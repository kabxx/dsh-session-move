import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, mkdtemp, open, realpath, rm, stat, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { constants, zstdCompressSync } from 'node:zlib'
import { LOG_FILENAME, sessionDir } from '../src/paths.js'
import { moveStorage } from '../src/transaction.js'
import { createFrameScanner } from '../src/zstd-frame.js'

const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const frame = (text) => zstdCompressSync(text, options)
const row = (value) => JSON.stringify(value) + '\n'

async function digest(path, range) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, range)) hash.update(chunk)
  return hash.digest('hex')
}

test('incremental frame scanning preserves boundaries across sliced metadata and a torn tail', () => {
  const pieces = [frame('first'), frame(randomBytes(384 * 1024)), frame('')]
  const complete = Buffer.concat(pieces)
  const truncated = complete.subarray(0, complete.length - 1)
  const boundaries = []
  let start = 0
  for (const piece of pieces) {
    boundaries.push({ start, end: start + piece.length })
    start += piece.length
  }
  for (const [input, expected, tornStart] of [
    [complete, boundaries, undefined],
    [truncated, boundaries.slice(0, -1), boundaries.at(-1).start],
  ]) {
    for (const size of [1, 3, 255, 256 * 1024]) {
      const scanner = createFrameScanner()
      const actual = []
      for (let offset = 0; offset < input.length; offset += size) {
        scanner.write(input.subarray(offset, offset + size), (boundary) => actual.push(boundary))
      }
      assert.deepEqual(actual, expected)
      assert.equal(scanner.finish(), tornStart)
    }
  }
  const scanner = createFrameScanner()
  scanner.write(complete)
  scanner.write(Buffer.alloc(3))
  assert.throws(() => scanner.write(Buffer.alloc(1)), /invalid frame magic/u)
})

const nativeLocksUnavailable = process.platform !== 'linux' && (
  !['darwin', 'win32'].includes(process.platform) || !process.env.DSH_INSTALL_DIR
)

test('streamed staging preserves compressed history, detects appended bytes and restores the original', {
  skip: (nativeLocksUnavailable || !process.env.DSH_INSTALL_DIR) && 'The pinned DSH installation is required',
}, async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-move-stream-')))
  t.after(() => rm(home, { force: true, recursive: true }))
  const root = join(home, 'sessions')
  const base = join(home, 'plugin')
  const oldCwd = join(home, 'aa-bb')
  const targetCwd = join(home, 'aa', 'bb')
  const id = 'large-session'
  const oldDir = sessionDir(root, oldCwd, id)
  const nextDir = sessionDir(root, targetCwd, id)
  assert.equal(oldDir, nextDir)
  await mkdir(oldDir, { recursive: true })
  const oldFile = join(oldDir, LOG_FILENAME)
  const header = { type: 'session', version: 4, id, cwd: oldCwd, createdAt: 1, isSeeded: false, delegationDepth: 0 }
  const originalHeader = frame(row(header))
  const targetHeader = frame(row({ ...header, cwd: targetCwd }))
  const historyHash = createHash('sha256')
  const events = Array.from({ length: 32 }, (_, seq) => ({ type: 'plugin:test/event', ignorable: true, seq, time: 1, data: {} }))
  const payload = randomBytes(256 * 1024).toString('base64')
  const file = await open(oldFile, 'wx')
  try {
    await file.writeFile(originalHeader)
    for (const event of events) {
      const bytes = frame(row({ ...event, data: { payload } }))
      historyHash.update(bytes)
      await file.writeFile(bytes)
    }
    await file.sync()
  } finally { await file.close() }
  const originalBytes = (await stat(oldFile)).size
  const expectedOriginal = await digest(oldFile)
  const expectedHistory = historyHash.digest('hex')
  const storage = moveStorage(root, base)
  const plan = { targetCwd, members: [{ id, oldCwd, oldDir, oldFile, nextDir }] }
  await storage.withLock(() => storage.withSessionLocks(plan, async (lockStage) => {
    const state = await storage.prepare(undefined, plan, {}, lockStage)
    await storage.save(state)
    await storage.publish(state)
    await storage.verifyPublished(state, { exact: true })
    const [record] = state.members
    assert.equal(record.oldHash, expectedOriginal)
    assert.equal(record.nextHash, await digest(oldFile))
    assert.equal(record.nextBytes, (await stat(oldFile)).size)
    assert.equal(await digest(oldFile, {
      start: targetHeader.length, end: targetHeader.length + originalBytes - originalHeader.length - 1,
    }), expectedHistory)

    await appendFile(oldFile, frame(row({ type: 'plugin:test/event', ignorable: true, seq: events.length + 1, time: 2, data: {} })))
    const { nextBytes, ...legacyRecord } = record
    await storage.verifyPublished(state)
    await storage.verifyPublished({ ...state, members: [legacyRecord] })
    await assert.rejects(storage.verifyPublished(state, { exact: true }), { code: 'changed' })
    await assert.rejects(storage.verifyPublished({ ...state, members: [legacyRecord] }, { exact: true }), { code: 'changed' })
    await assert.rejects(storage.rollback(state), { code: 'changed' })
    await truncate(oldFile, nextBytes)
    await storage.rollback(state)
    await storage.rollback(state)
    assert.equal(await digest(oldFile), expectedOriginal)
    await storage.finish(state)
  }))
})
