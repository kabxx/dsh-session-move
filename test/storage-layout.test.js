import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { LOCK_FILENAME, LOG_FILENAME, sessionDir } from '../src/paths.js'
import { moveStorage } from '../src/transaction.js'
import { openHost, title } from './fixtures/transaction-host.js'

const integration = { skip: !process.env.DSH_INSTALL_DIR && 'Set DSH_INSTALL_DIR to the pinned DSH installation' }

async function setup(t, { shared = false, ids = ['example'] } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-move-storage-')))
  t.after(() => rm(home, { force: true, recursive: true }))
  const oldCwd = join(home, 'aa-bb')
  const targetCwd = shared ? join(home, 'aa', 'bb') : join(home, 'other')
  await mkdir(oldCwd)
  await mkdir(targetCwd, { recursive: true })
  const host = await openHost(home, { recover: false })
  t.after(host.close)
  const members = []
  for (const id of ids) {
    const writer = await host.ctx.sessionPersistence.create({ version: 4, id, cwd: oldCwd, createdAt: 1, isSeeded: false })
    try { await writer.append([title(id, 0, 'before')]); await writer.flush() } finally { await writer.close() }
    const oldDir = sessionDir(host.root, oldCwd, id)
    const nextDir = sessionDir(host.root, targetCwd, id)
    members.push({ id, oldCwd, oldDir, nextDir, oldFile: join(oldDir, LOG_FILENAME), nextFile: join(nextDir, LOG_FILENAME) })
  }
  return { ...host, plan: { members, targetCwd } }
}

const shadows = new Map([
  ['session.jsonl.zstd', zstdCompressSync('{"type":"historical","version":0}\n')],
  ['session.v3.jsonl.zstd', zstdCompressSync('{"type":"historical","version":3}\n')],
])

async function addShadows(dir) {
  for (const [name, bytes] of shadows) await writeFile(join(dir, name), bytes)
}

async function checkShadows(dir) {
  for (const [name, bytes] of shadows) assert.deepEqual(await readFile(join(dir, name)), bytes)
}

function runPrepared(host, storage, run) {
  return storage.withLock(() => storage.withSessionLocks(host.plan, async (lockStage) => {
    const state = await storage.prepare(host.ctx, host.plan, {}, lockStage)
    await storage.save(state)
    return await run(state)
  }))
}

test('a shared DSH bucket maintains one live path and restores its original bytes', integration, async (t) => {
  const host = await setup(t, { shared: true })
  const [member] = host.plan.members
  assert.equal(member.oldDir, member.nextDir)
  await addShadows(member.oldDir)
  const before = await readFile(member.oldFile)
  const inode = process.platform !== 'win32' && (await stat(join(member.oldDir, LOCK_FILENAME))).ino
  const checkpoints = []
  const storage = moveStorage(host.root, host.base, { checkpoint: async (step) => checkpoints.push(step) })
  await runPrepared(host, storage, async (state) => {
    assert.equal(await storage.hasHeld(state), false)
    await storage.publish(state)
    assert.equal(await storage.hasHeld(state), true)
    const actual = await host.ctx.sessionPersistence.stat(member.id)
    assert.equal(actual.header.cwd, host.plan.targetCwd)
    assert.equal(actual.location.path, member.oldFile)
    await storage.verifyPublished(state)
    await checkShadows(member.oldDir)
    await storage.rollback(state)
    await storage.rollback(state)
    assert.deepEqual(await readFile(member.oldFile), before)
    assert.equal((await host.ctx.sessionPersistence.stat(member.id)).header.cwd, member.oldCwd)
    await storage.finish(state)
  })
  await runPrepared(host, storage, async (state) => {
    await storage.publish(state)
    await storage.cleanCommitted(state)
  })
  assert.deepEqual(checkpoints, ['destination-published', 'destination-published'])
  await checkShadows(member.oldDir)
  if (inode !== false) assert.equal((await stat(join(member.oldDir, LOCK_FILENAME))).ino, inode)
  assert.equal((await host.ctx.sessionPersistence.stat(member.id)).header.cwd, host.plan.targetCwd)
})

test('published sessions have no competing historical log left at the source', integration, async (t) => {
  const host = await setup(t)
  const [member] = host.plan.members
  await addShadows(member.oldDir)
  const before = await readFile(member.oldFile)
  const ctx = host.ctx
  const seen = []
  let stop = true
  const storage = moveStorage(host.root, host.base, { checkpoint: async (step) => {
    seen.push(step)
    const snapshot = await ctx.sessionPersistence.stat(member.id)
    if (step === 'shadow-hidden') {
      assert.equal(snapshot.location.path, member.oldFile)
      if (stop) throw new Error('halt in shadow transfer')
    }
    if (step === 'source-hidden') assert.equal(snapshot, undefined)
    if (step === 'destination-published') assert.equal(snapshot.location.path, member.nextFile)
  } })
  await runPrepared(host, storage, async (state) => {
    await assert.rejects(storage.publish(state), /halt in shadow transfer/)
    assert.equal(await storage.hasHeld(state), true)
    await storage.rollback(state)
    assert.deepEqual(await readFile(member.oldFile), before)
    await checkShadows(member.oldDir)
    await storage.finish(state)
  })
  stop = false
  await runPrepared(host, storage, async (state) => {
    await storage.publish(state)
    await storage.verifyPublished(state)
    await checkShadows(member.nextDir)
    await storage.rollback(state)
    assert.deepEqual(await readFile(member.oldFile), before)
    await checkShadows(member.oldDir)
    await storage.finish(state)
  })
  await runPrepared(host, storage, async (state) => {
    await storage.publish(state)
    await storage.cleanCommitted(state)
  })
  assert.deepEqual(seen, ['shadow-hidden', ...Array(2).fill(['shadow-hidden', 'shadow-hidden', 'source-hidden', 'destination-published']).flat()])
  await assert.rejects(stat(member.oldDir), { code: 'ENOENT' })
  await checkShadows(member.nextDir)
})

test('exact journal prefix survives native appends and prevents a partial family rollback', integration, async (t) => {
  const host = await setup(t, { ids: ['parent', 'child'] })
  const [parent, child] = host.plan.members
  const storage = moveStorage(host.root, host.base)
  const state = await runPrepared(host, storage, async (state) => {
    await storage.publish(state)
    return state
  })
  const writer = await host.ctx.sessionPersistence.open(parent.id, 'write')
  try { await writer.append([title(parent.id, 2, 'after')]); await writer.flush() } finally { await writer.close() }
  await storage.withSessionLocks(state, async () => {
    await storage.verifyPublished(state)
    const oldJournal = { ...state, members: state.members.map(({ nextBytes, ...rest }) => rest) }
    await storage.verifyPublished(oldJournal)
    await assert.rejects(storage.rollback(state), { code: 'changed' })
    for (const member of [parent, child]) {
      assert.equal((await host.ctx.sessionPersistence.stat(member.id)).location.path, member.nextFile)
    }
    const wrongHash = { ...state, members: state.members.map((member) => ({ ...member, nextHash: '0'.repeat(64) })) }
    await assert.rejects(storage.verifyPublished(wrongHash), { code: 'changed' })
    await storage.cleanCommitted(state)
  }, { recovery: true })
})
