import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { createSessionMove } from '../src/move.js'
import { openHost, parent, request, title } from './fixtures/transaction-host.js'

const integration = { timeout: 15000, skip: !process.env.DSH_INSTALL_DIR && 'Set DSH_INSTALL_DIR to the pinned DSH installation' }
// The stock per-record projection backend accepts only filename-safe ids.
const child = 'session-sidebar-child'

for (const outcome of ['move', 'rollback', 'summary failure', 'family move']) {
  test(`sidebar synchronization after ${outcome}`, integration, async (t) => {
    const rollback = outcome === 'rollback'
    const summaryFailure = outcome === 'summary failure'
    const family = outcome === 'family move'
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-move-sidebar-')))
    let host
    t.after(async () => {
      try { await host?.close() } finally { await rm(home, { force: true, recursive: true }) }
    })
    const from = join(home, 'source')
    const to = join(home, 'target')
    await Promise.all([mkdir(from), mkdir(to)])
    const req = createRequire(join(process.env.DSH_INSTALL_DIR, 'package.json'))
    const fromPackage = (name, file) => import(pathToFileURL(join(dirname(req.resolve(`@deepseek-ai/${name}`)), 'types', file)))
    const [{ ApiSessionList }, { WorkspaceFeed }, { SessionProjectionCache }, { titleProjectionDefinition }] = await Promise.all([
      fromPackage('dsh-api-session-controller', 'list.js'),
      fromPackage('dsh-api-workspace-controller', 'feed.js'),
      import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-projection-cache'))),
      import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-title'))),
    ])
    host = await openHost(home, { nativeSessions: true })
    const { ctx } = host
    const source = await ctx.workspaceRegistry.create(from)
    const target = await ctx.workspaceRegistry.create(to)
    await ctx.sessionProjections.register(titleProjectionDefinition)
    await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 10, writeIntervalMs: 1000 })
    ctx.provide('attachments', { imageLimits: {
      maxImageBytes: 1024, maxImagesPerMessage: 1, maxMessageImageBytes: 1024,
      maxImageDimension: 10, maxImagePixels: 100, mediaTypes: ['image/png'],
    } })
    const list = new ApiSessionList(ctx, 16)
    await list.initialize()
    ctx.provide('sessionController', { listState: list })
    ctx.provide('sessionQuery', { config: { openAt: 'never' }, listSessions: () => ctx.sessionPersistence.list() })
    const header = { version: 4, id: parent, cwd: from, createdAt: 1, isSeeded: false }
    const openingTitle = title(parent, 0, 'original title')
    const file = await ctx.sessionPersistence.create(header)
    await file.append([openingTitle])
    await file.close()
    await source.attachSession(parent)
    const childTitle = title(child, 0, 'child title')
    if (family) {
      const childFile = await ctx.sessionPersistence.create({ ...header, id: child, origin: 'subagent', parentSession: parent })
      try { await childFile.append([childTitle]) } finally { await childFile.close() }
      await source.attachSession(child)
    }

    // Use native enter/dispose events and the same removal relay as the stock controller.
    const resident = ctx.sessions.prepare(parent, { meta: header, seed: [openingTitle] })
    const dispose = ctx.sessions.enter(resident)
    ctx.sessions.announce(resident)
    const fiberDisposer = async () => { await dispose() }
    Object.defineProperty(fiberDisposer, Symbol.for('cordis.effect'), { value: { label: `agentLoop.lifecycle(${parent})` } })
    const scope = () => {}
    const lifecycle = () => {}
    Object.defineProperty(lifecycle, Symbol.for('cordis.effect'), { value: { label: `agentLoop.scope(${parent})`, children: [scope] } })
    const rawDispose = () => {}
    Object.defineProperty(rawDispose, Symbol.for('cordis.effect'), { value: scope })
    const owner = { fiber: { _disposables: [fiberDisposer] } }
    Object.assign(ctx.sessionController, { ctx: owner, agents: { ctx: owner } })
    host.residentAgents.set(parent, {
      session: ctx.sessions.get(parent), status: 'idle', phase: { kind: 'idle' }, inbox: { hasPending: false },
      lifetimeSignal: new AbortController().signal, scope: { rawDispose }, loopCtx: { fiber: { _disposables: [lifecycle] } },
    })
    ctx.on('session/disposed', (session) => ctx.emit('api-session/removed', session.id))
    const events = []
    ctx.on('api-session/removed', (id) => { events.push({ kind: 'removed', id }) })
    ctx.on('api-session/added', (summary) => { events.push({ kind: 'added', summary }) })
    const abort = new AbortController()
    const follow = new WorkspaceFeed(ctx).follow(abort.signal)
    try {
      assert.equal((await follow.next()).value.type, 'baseline')
      const sequence = []
      if (family) {
        const persistence = ctx.sessionPersistence[Symbol.for('cordis.original')] ?? ctx.sessionPersistence
        const open = persistence.open.bind(persistence)
        persistence.open = async (id, access, options) => {
          sequence.push(`open ${id}`)
          return open(id, access, options)
        }
        ctx.on('api-session/added', (summary) => { sequence.push(`add ${summary.sessionId}`) })
      }
      const respond = createSessionMove(ctx, { ...host, activity: async () => [], checkpoint: (stage) => {
        if (rollback && stage === 'destination-published') throw new Error('injected rollback')
        if (family && ['prepared', 'committed'].includes(stage)) sequence.push(stage)
      } })
      if (summaryFailure) ctx.sessionController.listState = { summarizeCold() { throw new Error('injected summary failure') } }
      const response = await respond(request(target.id, source.id))
      const expected = summaryFailure ? { moved: true, sidebarPending: true } : rollback ? { error: 'restored' } : { moved: true }
      assert.deepEqual(await response.json(), expected)
      const added = summaryFailure ? [] : family ? ['added', 'added'] : ['added']
      assert.deepEqual(events.map(({ kind }) => kind), ['removed', ...added])
      const cwd = rollback ? from : to
      if (!summaryFailure) {
        const { summary } = events[1]
        assert.equal(summary.cwd, cwd)
        assert.equal(summary.projections.values.title, openingTitle.data.title)
        assert.equal(summary.agentAvailable, false)
      }
      if (family) {
        assert.ok(sequence.every((step) => !step.startsWith('open ')), 'Host must not read session bodies')
        assert.deepEqual(sequence.slice(sequence.indexOf('prepared')), [
          'prepared', 'committed', `add ${parent}`, `add ${child}`,
        ])
        assert.equal(events[2].summary.projections.values.title, childTitle.data.title)
        assert.equal(events[2].summary.cwd, to)
      }
      assert.equal(ctx.sessions.get(parent), undefined)
      const coldRows = await list.list()
      const cold = coldRows.find(({ sessionId }) => sessionId === parent)
      assert.equal(cold.cwd, cwd)
      assert.equal(cold.projections.values.title, openingTitle.data.title)
      if (family) assert.equal(coldRows.find(({ sessionId }) => sessionId === child).projections.values.title, childTitle.data.title)
      if (!rollback) {
        const frames = [(await follow.next()).value, (await follow.next()).value]
        assert.deepEqual(frames.find(({ workspace }) => workspace.workspaceId === target.id).workspace.sessionIds,
          family ? [parent, child] : [parent])
        assert.deepEqual(frames.find(({ workspace }) => workspace.workspaceId === source.id).workspace.sessionIds, [])
      }
    } finally {
      abort.abort()
      await follow.return()
    }
  })
}

test('moving a family preserves agentPreset projections and failed oversized moves restore sidebar rows without rescanning', integration, async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-move-sidebar-preset-')))
  let host
  t.after(async () => {
    try { await host?.close() } finally { await rm(home, { force: true, recursive: true }) }
  })
  const from = join(home, 'source')
  const to = join(home, 'target')
  await Promise.all([mkdir(from), mkdir(to)])
  const req = createRequire(join(process.env.DSH_INSTALL_DIR, 'package.json'))
  const fromPackage = (name, file) => import(pathToFileURL(join(dirname(req.resolve(`@deepseek-ai/${name}`)), 'types', file)))
  const [{ ApiSessionList }, { SessionProjectionCache }, { titleProjectionDefinition }, { agentPresetProjectionDefinition }] = await Promise.all([
    fromPackage('dsh-api-session-controller', 'list.js'),
    import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-projection-cache'))),
    import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-title'))),
    fromPackage('dsh-agent-preset-registry', 'session.js'),
  ])
  host = await openHost(home, { nativeSessions: true })
  const { ctx } = host
  const source = await ctx.workspaceRegistry.create(from)
  const target = await ctx.workspaceRegistry.create(to)
  await ctx.sessionProjections.register(titleProjectionDefinition)
  await ctx.sessionProjections.register(agentPresetProjectionDefinition)
  await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 10, writeIntervalMs: 1000 })
  ctx.provide('attachments', { imageLimits: {
    maxImageBytes: 1024, maxImagesPerMessage: 1, maxMessageImageBytes: 1024,
    maxImageDimension: 10, maxImagePixels: 100, mediaTypes: ['image/png'],
  } })
  const list = new ApiSessionList(ctx, 16)
  await list.initialize()
  ctx.provide('sessionController', { listState: list })
  ctx.provide('sessionQuery', { config: { openAt: 'never' }, listSessions: () => ctx.sessionPersistence.list() })

  const header = { version: 4, id: parent, cwd: from, createdAt: 1, isSeeded: false, agentPreset: 'creator' }
  const openingTitle = title(parent, 0, 'creator chat')
  const file = await ctx.sessionPersistence.create(header)
  try { await file.append([openingTitle]); await file.flush() } finally { await file.close() }
  await source.attachSession(parent)

  const childHeader = { version: 4, id: child, cwd: from, createdAt: 2, isSeeded: false, origin: 'subagent', parentSession: parent, agentPreset: 'default' }
  const childEvents = [
    { type: 'agent-preset/selected', seq: 0, time: 3, data: { agentPreset: 'reviewer' } },
    title(child, 1, 'reviewer child'),
  ]
  const childFile = await ctx.sessionPersistence.create(childHeader)
  try { await childFile.append(childEvents); await childFile.flush() } finally { await childFile.close() }
  await source.attachSession(child)

  const added = []
  ctx.on('api-session/added', (summary) => added.push(summary))
  const respond = createSessionMove(ctx, { ...host, activity: async () => [] })
  assert.deepEqual(await (await respond(request(target.id, source.id))).json(), { moved: true })

  const parentAdded = added.find((summary) => summary.sessionId === parent)
  const childAdded = added.find((summary) => summary.sessionId === child)
  assert.equal(parentAdded?.projections?.values?.agentPreset, 'creator')
  assert.equal(childAdded?.projections?.values?.agentPreset, 'reviewer')
  const coldRows = await list.list()
  assert.equal(coldRows.find(({ sessionId }) => sessionId === parent)?.projections?.values?.agentPreset, 'creator')
  assert.equal(coldRows.find(({ sessionId }) => sessionId === child)?.projections?.values?.agentPreset, 'reviewer')

  // Now attach a resident open session whose log contains an oversized record
  // that deterministically fails history inspection. Disposal removes its row,
  // and failure recovery must republish the pre-disposal summary immediately
  // without rescanning the oversized log.
  const hugeId = 'session-oversized-resident'
  const hugeHeader = { version: 4, id: hugeId, cwd: from, createdAt: 10, isSeeded: false, agentPreset: 'creator' }
  const hugeTitle = title(hugeId, 0, 'huge resident chat')
  const hugeFile = await ctx.sessionPersistence.create(hugeHeader)
  try { await hugeFile.append([hugeTitle]); await hugeFile.flush() } finally { await hugeFile.close() }
  await source.attachSession(hugeId)
  const hugePath = (await ctx.sessionPersistence.stat(hugeId)).location.path
  await appendFile(hugePath, zstdCompressSync(JSON.stringify({
    type: 'plugin:test/oversized', ignorable: true, seq: 1, time: 11, data: { payload: 'x'.repeat(16 * 1024 * 1024) },
  }) + '\n'))

  const resident = ctx.sessions.prepare(hugeId, { meta: hugeHeader, seed: [hugeTitle] })
  const dispose = ctx.sessions.enter(resident)
  ctx.sessions.announce(resident)
  const fiberDisposer = async () => { await dispose() }
  Object.defineProperty(fiberDisposer, Symbol.for('cordis.effect'), { value: { label: `agentLoop.lifecycle(${hugeId})` } })
  const scope = () => {}
  const lifecycle = () => {}
  Object.defineProperty(lifecycle, Symbol.for('cordis.effect'), { value: { label: `agentLoop.scope(${hugeId})`, children: [scope] } })
  const rawDispose = () => {}
  Object.defineProperty(rawDispose, Symbol.for('cordis.effect'), { value: scope })
  const owner = { fiber: { _disposables: [fiberDisposer] } }
  Object.assign(ctx.sessionController, { ctx: owner, agents: { ctx: owner } })
  host.residentAgents.set(hugeId, {
    session: ctx.sessions.get(hugeId), status: 'idle', phase: { kind: 'idle' }, inbox: { hasPending: false },
    lifetimeSignal: new AbortController().signal, scope: { rawDispose }, loopCtx: { fiber: { _disposables: [lifecycle] } },
  })
  ctx.on('session/disposed', (session) => ctx.emit('api-session/removed', session.id))

  added.length = 0
  const hugeRequest = new Request('http://test.local/api/session-move/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: hugeId, sourceWorkspaceId: source.id, targetWorkspaceId: target.id }),
  })
  const failure = await respond(hugeRequest)
  assert.equal(failure.status, 409)
  assert.deepEqual(await failure.json(), { error: 'history-resource' })
  assert.equal(added.length, 1)
  assert.equal(added[0].sessionId, hugeId)
  assert.equal(added[0].cwd, from)
  assert.equal(added[0].agentAvailable, false)
  assert.equal(added[0].projections?.values?.title, hugeTitle.data.title)
  assert.equal(added[0].projections?.values?.agentPreset, 'creator')
})
