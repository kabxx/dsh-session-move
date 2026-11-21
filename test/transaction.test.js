import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSessionMove } from '../src/move.js'
import { encodeSegment, LOG_FILENAME, sessionDir } from '../src/paths.js'
import { child, openHost, parent, request, title } from './fixtures/transaction-host.js'

const integration = { skip: !process.env.DSH_INSTALL_DIR && 'Set DSH_INSTALL_DIR to the pinned DSH installation' }

async function seed(host, id, cwd, events, isChild = false) {
  const header = { version: 4, id, cwd, createdAt: Date.now(), isSeeded: false, ...(isChild ? { origin: 'subagent', parentSession: parent } : {}) }
  const file = await host.ctx.sessionPersistence.create(header)
  try { await file.append(events); await file.flush() } finally { await file.close() }
}

async function setup(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-move-integration-')))
  // The absolute remove target is exactly the private directory mkdtemp created.
  t.after(() => rm(home, { force: true, recursive: true }))
  const directories = {}
  for (const key of ['source', 'target', 'other', 'subdir']) {
    directories[key] = join(home, key)
    await mkdir(directories[key])
  }
  const host = await openHost(home)
  const { ctx } = host
  const workspaces = {}
  for (const key of ['source', 'target', 'other']) workspaces[key] = (await ctx.workspaceRegistry.create(directories[key])).id
  await seed(host, 'first', directories.source, [])
  await seed(host, parent, directories.source, [title(parent, 0, 'old'), {
    type: 'working-directory/change', seq: 1, time: 2, data: { cwd: directories.subdir },
  }])
  await seed(host, child, directories.source, [title(child, 0, 'task')], true)
  await seed(host, 'last', directories.source, [])
  await seed(host, 'other-id', directories.other, [])
  for (const id of ['last', child, parent, 'first']) await ctx.workspaceRegistry.get(workspaces.source).attachSession(id)
  await ctx.workspaceRegistry.get(workspaces.other).attachSession('other-id')
  return { home, ...host, workspaces, directories }
}

async function snapshot(host, id) {
  const file = await host.ctx.sessionPersistence.open(id, 'read')
  try { return { cwd: file.header.cwd, events: (await file.read()).events } } finally { await file.close() }
}

const owners = (host, id) => Array.from(host.ctx.workspaceRegistry.get(id).sessionIds)
const createMove = (host, options) => createSessionMove(host.ctx, { ...host, activity: async () => [], ...options })

test('a failed directory update rolls back, keeping the final write drained before backup', integration, async (t) => {
  const host = await setup(t)
  t.after(host.close)
  const writer = await host.ctx.sessionPersistence.open(parent, 'write')
  const response = await createMove(host, {
    release: async () => { await writer.append([title(parent, 2, 'last durable write')]); await writer.close() },
    checkpoint: async (step, member) => {
      if (step !== 'destination-published' || member.id !== parent) return
      // Fail after publication; recovery must preserve the last write.
      const original = await readFile(join(host.base, 'move-intent.json'), 'utf8')
      const { ticket } = JSON.parse(original)
      const bytes = await readFile(join(host.base, 'backups', ticket, 'original', encodeSegment(parent), LOG_FILENAME))
      assert.ok(bytes.length > 0)
      throw new Error('injected failure during directory update')
    },
  })(request(host.workspaces.target, host.workspaces.source))
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'restored' })
  const log = await snapshot(host, parent)
  assert.equal(log.cwd, host.directories.source)
  assert.equal(log.events.at(-1).data.title, `${parent}: last durable write`)
  assert.deepEqual(owners(host, host.workspaces.source), ['first', parent, child, 'last'])
  assert.deepEqual(owners(host, host.workspaces.target), [])
})

test('a source workspace removed during the move stays removed after rollback and restart', integration, async (t) => {
  const initial = await setup(t)
  const before = await snapshot(initial, parent)
  try {
    const response = await createMove(initial, {
      checkpoint: async (step) => {
        if (step === 'prepared') await initial.ctx.workspaceRegistry.delete(initial.workspaces.source)
      },
    })(request(initial.workspaces.target, initial.workspaces.source))
    assert.deepEqual(await response.json(), { error: 'restored' })
    assert.equal(initial.ctx.workspaceRegistry.get(initial.workspaces.source), undefined)
    assert.deepEqual(await snapshot(initial, parent), before)
  } finally { await initial.close() }

  const restored = await openHost(initial.home)
  t.after(restored.close)
  assert.equal(restored.ctx.workspaceRegistry.get(initial.workspaces.source), undefined)
  assert.deepEqual(owners(restored, initial.workspaces.target), [])
  assert.deepEqual(owners(restored, initial.workspaces.other), ['other-id'])
  assert.deepEqual(await snapshot(restored, parent), before)
})

test('a family move appends only the native directory change and uses encoded backup paths', integration, async (t) => {
  const host = await setup(t)
  t.after(host.close)
  const originalEvents = new Map(await Promise.all([parent, child].map(async (id) => [id, (await snapshot(host, id)).events])))
  const response = await createMove(host, { checkpoint: async (step, state) => {
    if (step !== 'prepared') return
    const file = join(host.base, 'backups', state.ticket, 'original', 'session-parent~003Aspawn~003A1.2', LOG_FILENAME)
    assert.ok((await readFile(file)).length > 0)
  } })(request(host.workspaces.target, host.workspaces.source))
  assert.deepEqual(await response.json(), { moved: true })
  assert.deepEqual(owners(host, host.workspaces.source), ['first', 'last'])
  assert.deepEqual(owners(host, host.workspaces.target), [parent, child])
  assert.deepEqual(owners(host, host.workspaces.other), ['other-id'])
  for (const id of [parent, child]) {
    const result = await snapshot(host, id)
    assert.equal(result.cwd, host.directories.target)
    const before = originalEvents.get(id)
    assert.deepEqual(result.events.slice(0, -1), before)
    const { time, ...change } = result.events.at(-1)
    assert.ok(Number.isFinite(time))
    assert.deepEqual(change, {
      type: 'working-directory/change', seq: before.at(-1).seq + 1, data: { cwd: host.directories.target },
    })
  }
})

test('activity and a live write lease each refuse the move before backup', integration, async (t) => {
  const host = await setup(t)
  t.after(host.close)
  const before = await snapshot(host, parent)
  const failIfPrepared = () => assert.fail('blocked move should not prepare a backup')
  const busy = await createMove(host, { activity: async () => ['active'], checkpoint: failIfPrepared })(request(host.workspaces.target, host.workspaces.source))
  assert.deepEqual(await busy.json(), { error: 'busy' })
  const writer = await host.ctx.sessionPersistence.open(parent, 'write')
  try {
    const locked = await createMove(host, { checkpoint: failIfPrepared })(request(host.workspaces.target, host.workspaces.source))
    assert.deepEqual(await locked.json(), { error: 'locked' })
  } finally { await writer.close() }
  assert.deepEqual(await snapshot(host, parent), before)
  assert.deepEqual(owners(host, host.workspaces.source), ['first', parent, child, 'last'])
})

const queued = { id: 'pending-test-command', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Run the current project tests' }] }

async function spliceQueue(host, id, target, inserted, removedCount = 0) {
  const file = await host.ctx.sessionPersistence.open(id, 'write')
  try {
    const { events } = await file.read()
    await file.append([{
      type: 'agent/inbox/spliced', seq: events.length, time: Date.now(),
      data: { target, start: 0, inserted, removedCount, ...(removedCount ? { outcome: 'canceled' } : {}) },
    }])
    await file.flush()
  } finally { await file.close() }
}

test('the same pending parent instruction refuses warm and cold moves', integration, async (t) => {
  const initial = await setup(t)
  const failIfMoved = () => assert.fail('pending instruction must not reach a move checkpoint')
  let before
  try {
    await spliceQueue(initial, parent, 'next-turn', [queued])
    before = await snapshot(initial, parent)
    const session = { id: parent, header: { id: parent, cwd: before.cwd } }
    initial.residentSessions.set(parent, session)
    initial.residentAgents.set(parent, { session, status: 'idle', phase: { kind: 'idle' }, inbox: { hasPending: true } })
    const response = await createMove(initial, { checkpoint: failIfMoved })(request(initial.workspaces.target, initial.workspaces.source))
    assert.deepEqual(await response.json(), { error: 'busy' })
  } finally { await initial.close() }

  const host = await openHost(initial.home)
  t.after(host.close)
  assert.equal(host.ctx.sessions.get(parent), undefined)
  const response = await createMove(host, { checkpoint: failIfMoved })(request(initial.workspaces.target, initial.workspaces.source))
  assert.deepEqual(await response.json(), { error: 'busy' })
  assert.deepEqual(await snapshot(host, parent), before)
  assert.deepEqual(owners(host, initial.workspaces.source), ['first', parent, child, 'last'])
  await assert.rejects(readFile(join(host.base, 'move-intent.json')), { code: 'ENOENT' })
})

test('a child next-step instruction stops the whole family until it is canceled', integration, async (t) => {
  const host = await setup(t)
  t.after(host.close)
  await spliceQueue(host, child, 'next-step', [queued])
  const parentBefore = await snapshot(host, parent)
  const childBefore = await snapshot(host, child)
  const move = createMove(host)
  assert.deepEqual(await (await move(request(host.workspaces.target, host.workspaces.source))).json(), { error: 'busy' })
  assert.deepEqual(await snapshot(host, parent), parentBefore)
  assert.deepEqual(await snapshot(host, child), childBefore)
  await assert.rejects(readFile(join(host.base, 'move-intent.json')), { code: 'ENOENT' })

  await spliceQueue(host, child, 'next-step', [], 1)
  assert.deepEqual(await (await move(request(host.workspaces.target, host.workspaces.source))).json(), { moved: true })
  assert.deepEqual(owners(host, host.workspaces.target), [parent, child])
})

test('re-adding the same folder attaches the ungrouped family without rewriting logs', integration, async (t) => {
  const host = await setup(t)
  t.after(host.close)
  const files = [parent, child].map((id) => join(sessionDir(host.root, host.directories.source, id), LOG_FILENAME))
  const original = await Promise.all(files.map((path) => readFile(path)))
  await host.ctx.workspaceRegistry.delete(host.workspaces.source)
  const replacement = await host.ctx.workspaceRegistry.create(host.directories.source)
  assert.deepEqual([...replacement.sessionIds], [])
  const move = createMove(host, { checkpoint: () => assert.fail('same project should not prepare a migration') })
  assert.deepEqual(await (await move(request(replacement.id, null))).json(), { moved: true })
  assert.deepEqual(owners(host, replacement.id), [parent, child])
  assert.deepEqual(await Promise.all(files.map((path) => readFile(path))), original)
  await assert.rejects(readFile(join(host.base, 'move-intent.json')), { code: 'ENOENT' })
  assert.deepEqual(await (await move(request(replacement.id, replacement.id))).json(), { error: 'same-workspace' })
})

test('a mixed family moves the parent and preserves the child already in the target project', integration, async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-move-mixed-')))
  t.after(() => rm(home, { force: true, recursive: true }))
  const source = join(home, 'source')
  const target = join(home, 'target')
  await Promise.all([mkdir(source), mkdir(target)])
  const host = await openHost(home)
  t.after(host.close)
  const sourceWorkspace = await host.ctx.workspaceRegistry.create(source)
  const targetWorkspace = await host.ctx.workspaceRegistry.create(target)
  await seed(host, parent, source, [title(parent, 0, 'parent')])
  await seed(host, child, target, [title(child, 0, 'already at target')], true)
  await sourceWorkspace.attachSession(parent)
  await targetWorkspace.attachSession(child)
  const childFile = join(sessionDir(host.root, target, child), LOG_FILENAME)
  const original = await readFile(childFile)
  assert.deepEqual(await (await createMove(host)(request(targetWorkspace.id, sourceWorkspace.id))).json(), { moved: true })
  assert.deepEqual(owners(host, targetWorkspace.id), [parent, child])
  assert.equal((await snapshot(host, parent)).cwd, target)
  assert.deepEqual(await readFile(childFile), original)
})

test('normal move requests distinguish different projects sharing the same DSH storage path', integration, async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-move-shared-path-')))
  t.after(() => rm(home, { force: true, recursive: true }))
  const source = join(home, 'aa-bb')
  const target = join(home, 'aa', 'bb')
  await Promise.all([mkdir(source), mkdir(target, { recursive: true })])
  const host = await openHost(home)
  t.after(host.close)
  const from = await host.ctx.workspaceRegistry.create(source)
  const to = await host.ctx.workspaceRegistry.create(target)
  const history = title(parent, 0, 'same storage, different project')
  await seed(host, parent, source, [history])
  await from.attachSession(parent)
  const oldLocation = (await host.ctx.sessionPersistence.stat(parent)).location.path
  assert.equal(oldLocation, join(sessionDir(host.root, target, parent), LOG_FILENAME))

  assert.deepEqual(await (await createMove(host)(request(to.id, from.id))).json(), { moved: true })
  assert.deepEqual(owners(host, from.id), [])
  assert.deepEqual(owners(host, to.id), [parent])
  assert.equal((await host.ctx.sessionPersistence.stat(parent)).location.path, oldLocation)
  const result = await snapshot(host, parent)
  assert.equal(result.cwd, target)
  assert.deepEqual(result.events[0], history)
  assert.deepEqual(result.events[1].data, { cwd: target })
})

for (const step of ['prepared', 'source-hidden', 'destination-published', 'ledger-published', 'committed']) {
  test(`process exit at ${step} recovers before workspace startup`, integration, async (t) => {
    const initial = await setup(t)
    await initial.close()
    const driver = fileURLToPath(new URL('./fixtures/transaction-host.js', import.meta.url))
    const result = spawnSync(process.execPath, [driver, 'crash', initial.home, initial.workspaces.target, initial.workspaces.source, step], { encoding: 'utf8', timeout: 15_000 })
    assert.equal(result.status, 93, result.stderr || String(result.error ?? ''))
    const restored = await openHost(initial.home)
    t.after(restored.close)
    const committed = step === 'ledger-published' || step === 'committed'
    const expected = committed ? initial.directories.target : initial.directories.source
    for (const id of [parent, child]) assert.equal((await snapshot(restored, id)).cwd, expected)
    assert.deepEqual(owners(restored, initial.workspaces.source), committed ? ['first', 'last'] : ['first', parent, child, 'last'])
    assert.deepEqual(owners(restored, initial.workspaces.target), committed ? [parent, child] : [])
    assert.deepEqual(owners(restored, initial.workspaces.other), ['other-id'])
  })
}

test('legacy misplaced file recovers before registry startup', integration, async (t) => {
  const host = await setup(t)
  await host.close()
  const oldDir = sessionDir(host.root, host.directories.source, parent)
  const nextDir = sessionDir(host.root, host.directories.target, parent)
  const legacy = host.legacy
  await mkdir(legacy, { recursive: true })
  await mkdir(dirname(nextDir), { recursive: true })
  assert.equal(dirname(dirname(oldDir)), host.root)
  assert.equal(dirname(dirname(nextDir)), host.root)
  await rename(oldDir, nextDir)
  await writeFile(join(legacy, 'move-intent.json'), JSON.stringify({ version: 1, phase: 'prepared',
    ticket: 'ab123456-1234-1234-1234-123456abcdef', members: [ { id: parent, oldCwd: host.directories.source,
      oldDir, oldFile: join(oldDir, LOG_FILENAME), nextDir, nextFile: join(nextDir, LOG_FILENAME) } ],
  }))
  const recovered = await openHost(host.home)
  t.after(recovered.close)
  assert.equal((await snapshot(recovered, parent)).cwd, host.directories.source)
  assert.deepEqual(owners(recovered, host.workspaces.source), ['first', parent, child, 'last'])
})
