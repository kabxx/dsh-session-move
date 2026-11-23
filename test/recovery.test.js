import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { captureLedger, moveLedger } from '../src/ledger.js'
import { createSessionMove } from '../src/move.js'
import { encodeSegment, LOG_FILENAME, sessionDir } from '../src/paths.js'
import { buildPlan } from '../src/plan.js'
import { recoverMove } from '../src/recovery.js'
import { moveStorage } from '../src/transaction.js'
import { scanFrames } from '../src/zstd-frame.js'
import { child, openHost, parent, request, title } from './fixtures/transaction-host.js'

function fixture({ phase = 'prepared', held = false, unsafe = false, locked = false, atTarget = phase === 'committed' } = {}) {
  const member = { id: parent, oldCwd: '/source', oldDir: '/sessions/source', nextDir: '/sessions/target' }
  const state = { ticket: 'test', phase, targetCwd: '/target', ledger: [], members: [member] }
  const calls = []
  const log = []
  const ctx = {
    logger: { warn: (...args) => log.push(args) },
    sessionPersistence: {
      async stat(id) {
        calls.push('verify')
        if (unsafe) throw new Error('duplicate or unreadable log')
        return {
          header: { id, cwd: atTarget ? state.targetCwd : member.oldCwd },
          location: { kind: 'jsonl', path: join(atTarget ? member.nextDir : member.oldDir, LOG_FILENAME) },
        }
      },
    },
  }
  const storage = {
    async hasJournal() { return true },
    async hasHeld() { return held },
    async withLock(run) {
      calls.push('move-lock')
      if (locked) throw Object.assign(new Error('another process owns the move lock'), { code: 'locked' })
      await run()
    },
    async readState() { return state },
    async withSessionLocks(_state, run) { calls.push('session-lock'); await run() },
    async rollback() { calls.push('rollback'); held = false },
    async save() { calls.push('marker') },
    async finish() { calls.push('finish') },
    async cleanCommitted() { calls.push('cleanup') },
  }
  return { ctx, storage, calls, log }
}

const noSpace = () => Object.assign(new Error('No space left on device'), { code: 'ENOSPC' })

test('a full disk during metadata recovery leaves the verified source available and defers the journal', async () => {
  const { ctx, storage, calls, log } = fixture()
  const withLedger = async () => { throw noSpace() }
  await recoverMove(ctx, storage, { startup: true, withLedger })
  assert.deepEqual(calls, ['move-lock', 'verify'])
  assert.equal(log.length, 1)
  await assert.rejects(recoverMove(ctx, storage, { withLedger }), { code: 'restore-pending' })
})

test('a hidden log still gates workspace startup when the required session lease is unavailable', async () => {
  const { ctx, storage, log } = fixture({ held: true, unsafe: true })
  storage.withSessionLocks = async () => { throw Object.assign(new Error('lease unavailable'), { code: 'locked' }) }
  await assert.rejects(recoverMove(ctx, storage, { startup: true }), { code: 'restore-pending' })
  assert.equal(log.length, 0)
})

test('a verified target log remains available while another process holds its session lease', async () => {
  const { ctx, storage, calls, log } = fixture({ held: true, atTarget: true })
  storage.withSessionLocks = async () => { throw Object.assign(new Error('lease unavailable'), { code: 'locked' }) }
  await recoverMove(ctx, storage, { startup: true })
  assert.deepEqual(calls, ['move-lock', 'verify'])
  assert.equal(log.length, 1)
})

test('startup verifies original logs before attempting metadata after a disk rollback', async () => {
  const { ctx, storage, calls, log } = fixture({ held: true })
  const withLedger = async () => { calls.push('ledger'); throw noSpace() }
  await recoverMove(ctx, storage, { startup: true, withLedger })
  assert.deepEqual(calls, ['move-lock', 'session-lock', 'verify', 'rollback', 'verify', 'ledger'])
  assert.equal(log.length, 1)
})

test('a competing process can defer terminal cleanup only after startup verifies the logs', async () => {
  const safe = fixture({ phase: 'committed', locked: true })
  await recoverMove(safe.ctx, safe.storage, { startup: true })
  assert.deepEqual(safe.calls, ['move-lock', 'verify'])
  assert.equal(safe.log.length, 1)

  for (const state of [{ phase: 'committed', unsafe: true }, { phase: 'prepared' }]) {
    const { ctx, storage, log } = fixture({ locked: true, ...state })
    await assert.rejects(recoverMove(ctx, storage, { startup: true }), { code: 'restore-pending' })
    assert.equal(log.length, 0)
  }
})

test('startup confirms the completed journal before deferring failed cleanup', async () => {
  const { ctx, storage, calls, log } = fixture({ phase: 'rolled-back' })
  storage.finish = async () => { throw noSpace() }
  await recoverMove(ctx, storage, { startup: true })
  assert.deepEqual(calls, ['move-lock', 'verify'])
  assert.equal(log.length, 1)
})

test('startup enables the stock workspace registry on a fresh home with no migration directories', {
  skip: !process.env.DSH_INSTALL_DIR && 'Set DSH_INSTALL_DIR to the pinned DSH installation',
}, async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-move-fresh-home-')))
  t.after(() => rm(home, { force: true, recursive: true }))
  const host = await openHost(home)
  try {
    assert.equal(host.ctx.sessionMoveRecovery, true)
    assert.deepEqual(host.ctx.workspaceRegistry.list(), [])
  } finally { await host.close() }
})

test('a previous-version move can recover with a deleted source and open the stock workspace registry', {
  skip: !process.env.DSH_INSTALL_DIR && 'Set DSH_INSTALL_DIR to the pinned DSH installation',
}, async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-move-recovery-')))
  t.after(() => rm(home, { force: true, recursive: true }))
  const sourceCwd = join(home, 'source')
  const targetCwd = join(home, 'target')
  await Promise.all([mkdir(sourceCwd), mkdir(targetCwd)])
  const initial = await openHost(home)
  const { ctx, root } = initial
  const previous = join(home, 'plugins', '@kabxx', 'dsh-session-move', 'v0.1.1')
  let sourceId
  let targetId
  const original = title(parent, 0, 'preserve this chat')
  try {
    const source = await ctx.workspaceRegistry.create(sourceCwd)
    const target = await ctx.workspaceRegistry.create(targetCwd)
    sourceId = source.id
    targetId = target.id
    const handle = await ctx.sessionPersistence.create({ version: 4, id: parent, cwd: sourceCwd, createdAt: 1, isSeeded: false })
    try { await handle.append([original]); await handle.flush() } finally { await handle.close() }
    await source.attachSession(parent)

    // Leave the v0.1.1 journal in the exact state left by its failed rollback:
    // disk restored, source workspace deleted, and the target ledger stale.
    const storage = moveStorage(root, previous)
    let state
    const check = async (phase, value) => {
      if (phase === 'prepared') state = value
      if (phase === 'ledger-published') {
        await ctx.workspaceRegistry.delete(sourceId)
        await storage.rollback(state)
        throw new Error('simulated crash after the files returned to source')
      }
    }
    const failingStorage = {
      ...storage,
      async rollback() { throw new Error('stop the current implementation from completing the simulated old rollback') },
    }
    const respond = createSessionMove(ctx, { root, base: previous, storage: failingStorage, activity: async () => [], checkpoint: check })
    const response = await respond(request(targetId, sourceId))
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'restore-pending' })
    assert.ok(await storage.hasJournal())
  } finally { await initial.close() }

  const restored = await openHost(home)
  try {
    assert.equal(restored.ctx.workspaceRegistry.get(sourceId), undefined)
    assert.deepEqual([...restored.ctx.workspaceRegistry.get(targetId).sessionIds], [])
    assert.equal(await moveStorage(root, previous).hasJournal(), false)
    const handle = await restored.ctx.sessionPersistence.open(parent, 'read')
    try {
      assert.equal(handle.header.cwd, sourceCwd)
      assert.deepEqual((await handle.read()).events, [original])
    } finally { await handle.close() }
  } finally { await restored.close() }
})

for (const failure of ['missing-marker', 'legacy-missing-marker', 'missing-ledger', 'rewritten-prefix']) {
  test(`an appended destination with ${failure} requires both ledger and exact history evidence`, {
    skip: !process.env.DSH_INSTALL_DIR && 'Set DSH_INSTALL_DIR to the pinned DSH installation',
  }, async (t) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-move-append-recovery-')))
    t.after(() => rm(home, { force: true, recursive: true }))
    const sourceCwd = join(home, 'source')
    const targetCwd = join(home, 'target')
    await Promise.all([mkdir(sourceCwd), mkdir(targetCwd)])
    const initial = await openHost(home)
    const { ctx, root } = initial
    const legacy = failure === 'legacy-missing-marker'
    const base = legacy ? join(home, 'plugins', '@kabxx', 'dsh-session-move', 'v0.1.2') : initial.base
    const storage = moveStorage(root, base)
    const unrelated = 'separate-session'
    const completes = legacy || failure === 'missing-marker'
    const appendedId = completes ? parent : child
    const appended = title(appendedId, legacy ? 3 : 2, 'written after uncertain completion')
    let targetId
    let sourceId
    let journal
    try {
      const source = await ctx.workspaceRegistry.create(sourceCwd)
      const target = await ctx.workspaceRegistry.create(targetCwd)
      targetId = target.id
      sourceId = source.id
      for (const id of [parent, child, unrelated]) {
        const file = await ctx.sessionPersistence.create({
          version: 4, id, cwd: sourceCwd, createdAt: 1, isSeeded: false,
          ...(id === child ? { origin: 'subagent', parentSession: parent } : {}),
        })
        try { await file.append([title(id, 0, 'pre-move')]) } finally { await file.close() }
        await source.attachSession(id)
      }
      const plan = await buildPlan(ctx, { root }, { sessionId: parent, targetWorkspaceId: targetId, sourceWorkspaceId: source.id })
      await storage.withLock(() => storage.withSessionLocks(plan, async (lockStage) => {
        const ledger = captureLedger(ctx, plan)
        const state = await storage.prepare(ctx, plan, ledger, lockStage)
        journal = state
        if (legacy) {
          // Recreate the old v2 evidence: an adjacent notice and a prefix hash.
          journal = { ...state, members: await Promise.all(state.members.map(async ({ cwdChangeSeq, nextBytes, oldHash, ...member }) => {
            const path = join(base, 'backups', state.ticket, 'staged', encodeSegment(member.id), LOG_FILENAME)
            const bytes = await readFile(path)
            const { start } = scanFrames(bytes).frames.at(-1)
            const change = zstdDecompressSync(bytes.subarray(start)).toString('utf8')
            const noticeId = `legacy-notice-${member.id}`
            const notice = {
              type: 'user/message', seq: cwdChangeSeq + 1, time: Date.now(), surfaceOp: 'append', data: {
                id: noticeId, role: 'user', source: { kind: 'working-directory' }, content: [{ type: 'text', text: 'Legacy move notice' }],
              },
            }
            const next = Buffer.concat([bytes.subarray(0, start), zstdCompressSync(change + JSON.stringify(notice) + '\n')])
            await writeFile(path, next)
            return { ...member, nextHash: createHash('sha256').update(next).digest('hex'), noticeId }
          })) }
        }
        await storage.save(journal)
        journal = await storage.readState()
        await storage.publish(journal)
        if (failure !== 'missing-ledger') await moveLedger(ctx, state, ledger)
      }))
      const file = await ctx.sessionPersistence.open(appendedId, 'write')
      try { await file.append([appended]) } finally { await file.close() }
      if (failure === 'rewritten-prefix') {
        const logPath = join(sessionDir(root, targetCwd, child), LOG_FILENAME)
        const bytes = await readFile(logPath)
        const [{ end }] = scanFrames(bytes).frames
        const header = JSON.parse(zstdDecompressSync(bytes.subarray(0, end)))
        header.createdAt += 1
        await writeFile(logPath, Buffer.concat([zstdCompressSync(JSON.stringify(header) + '\n'), bytes.subarray(end)]))
      }
    } finally { await initial.close() }

    const restored = await openHost(home)
    t.after(restored.close)
    assert.equal(await storage.hasJournal(), !completes)
    if (!completes) assert.deepEqual(await storage.readState(), journal)
    for (const id of [parent, child]) {
      const handle = await restored.ctx.sessionPersistence.open(id, 'read')
      try {
        assert.equal(handle.header.cwd, targetCwd)
        if (id === appendedId) assert.deepEqual((await handle.read()).events.at(-1), appended)
      } finally { await handle.close() }
    }
    if (completes) {
      assert.deepEqual([...restored.ctx.workspaceRegistry.get(targetId).sessionIds], [parent, child])
    }
    const respond = createSessionMove(restored.ctx, { ...restored, activity: async () => [] })
    const response = await respond(new Request('http://test.local/api/session-move/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: unrelated, targetWorkspaceId: targetId, sourceWorkspaceId: sourceId }),
    }))
    assert.deepEqual(await response.json(), completes ? { moved: true } : { error: 'restore-pending' })
  })
}

test('startup recovery sweeps orphaned backup tickets left without a journal', {
  skip: process.platform !== 'linux' && !process.env.DSH_INSTALL_DIR && 'Set DSH_INSTALL_DIR to the pinned DSH installation',
}, async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-move-orphan-sweep-')))
  t.after(() => rm(home, { force: true, recursive: true }))
  const root = join(home, 'sessions')
  const base = join(home, 'plugin')
  const ticket = '12345678-1234-1234-1234-1234567890ab'
  const orphan = join(base, 'backups', ticket, 'original')
  await mkdir(root, { recursive: true })
  await mkdir(orphan, { recursive: true })
  await writeFile(join(orphan, 'leftover.bin'), 'orphan-bytes')

  const storage = moveStorage(root, base)
  assert.equal(await storage.hasJournal(), false)
  assert.equal(await storage.hasOrphans(), true)
  await recoverMove({ logger: { warn() {} } }, storage, { startup: true })
  assert.equal(await storage.hasOrphans(), false)
})
