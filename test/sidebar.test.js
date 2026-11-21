import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { createSessionMove } from '../src/move.js'
import { openHost, parent, request, title } from './fixtures/transaction-host.js'

const integration = { timeout: 15000, skip: !process.env.DSH_INSTALL_DIR && 'Set DSH_INSTALL_DIR to the pinned DSH installation' }

for (const outcome of ['move', 'rollback', 'summary failure']) {
  test(`sidebar synchronization after ${outcome}`, integration, async (t) => {
    const rollback = outcome === 'rollback'
    const summaryFailure = outcome === 'summary failure'
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
      const respond = createSessionMove(ctx, { ...host, activity: async () => [], checkpoint: (stage) => {
        if (rollback && stage === 'destination-published') throw new Error('injected rollback')
      } })
      if (summaryFailure) ctx.sessionController.listState = { summaryFor() { throw new Error('injected summary failure') } }
      const response = await respond(request(target.id, source.id))
      const expected = summaryFailure ? { moved: true, sidebarPending: true } : rollback ? { error: 'restored' } : { moved: true }
      assert.deepEqual(await response.json(), expected)
      assert.deepEqual(events.map(({ kind }) => kind), summaryFailure ? ['removed'] : ['removed', 'added'])
      const cwd = rollback ? from : to
      if (!summaryFailure) {
        const { summary } = events[1]
        assert.equal(summary.cwd, cwd)
        assert.equal(summary.projections.values.title, openingTitle.data.title)
        assert.equal(summary.agentAvailable, false)
      }
      assert.equal(ctx.sessions.get(parent), undefined)
      const [cold] = await list.list()
      assert.equal(cold.cwd, cwd)
      assert.equal(cold.projections.values.title, openingTitle.data.title)
      if (!rollback) {
        const frames = [(await follow.next()).value, (await follow.next()).value]
        assert.deepEqual(frames.find(({ workspace }) => workspace.workspaceId === target.id).workspace.sessionIds, [parent])
        assert.deepEqual(frames.find(({ workspace }) => workspace.workspaceId === source.id).workspace.sessionIds, [])
      }
    } finally {
      abort.abort()
      await follow.return()
    }
  })
}
