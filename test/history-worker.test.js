import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { constants, zstdCompressSync } from 'node:zlib'
import { inspectMoveHistory } from '../src/history.js'
import { runHistory } from '../src/history-process.js'
import { HISTORY_CHUNK_BYTES, MAX_SUMMARY_STRING_BYTES } from '../src/history-stream.js'
import { inspectHistory } from '../src/history-worker.js'
import { openHost, parent, title } from './fixtures/transaction-host.js'

const install = process.env.DSH_INSTALL_DIR
const integration = { skip: !install && 'Set DSH_INSTALL_DIR to the pinned DSH installation' }
const workerPlatform = {
  skip: integration.skip || (!['linux', 'win32'].includes(process.platform) && 'Requires a supported history worker platform'),
}
const message = (id, kind = 'user') => ({ id, role: 'user', source: { kind }, content: [{ type: 'text', text: 'check' }] })
const splice = (seq, target, start, inserted, removedCount = 0) => ({
  type: 'agent/inbox/spliced', seq, time: seq + 10,
  data: { target, start, inserted, removedCount, ...(removedCount ? { outcome: 'canceled' } : {}) },
})
const userEvent = (seq, data) => ({ type: 'user/message', seq, time: seq + 10, surfaceOp: 'append', data })

async function setup(t, extraHeader = {}, dirName) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-move-history-worker-')))
  const home = dirName ? join(base, dirName) : base
  if (dirName) await mkdir(home)
  let host
  t.after(async () => {
    try { await host?.close() } finally { await rm(base, { force: true, recursive: true }) }
  })
  host = await openHost(home)
  const { ctx } = host
  const header = { version: 4, id: parent, cwd: home, createdAt: 1, isSeeded: false, ...extraHeader }
  let created = false
  const append = async (...events) => {
    const file = created ? await ctx.sessionPersistence.open(parent, 'write') : await ctx.sessionPersistence.create(header)
    try { await file.append(events); created = true } finally { await file.close() }
  }
  return { ctx, home, header, append, request: async () => ({
    path: (await ctx.sessionPersistence.stat(parent)).location.path,
    id: parent, cwd: home,
  }) }
}

test('history worker matches stock DSH inbox and list-summary projections', integration, async (t) => {
  const { ctx, header, append, request } = await setup(t, { agentPreset: 'creator' })
  const req = createRequire(join(install, 'package.json'))
  const { titleProjectionDefinition } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-title')))
  const { agentPresetProjectionDefinition } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-agent-preset-registry')))
  const controller = req.resolve('@deepseek-ai/dsh-api-session-controller')
  const { ApiSessionList } = await import(pathToFileURL(join(dirname(controller), 'types', 'list.js')))
  await ctx.sessionProjections.register(titleProjectionDefinition)
  await ctx.sessionProjections.register(agentPresetProjectionDefinition)
  ctx.provide('attachments', { imageLimits: {
    maxImageBytes: 1024, maxImagesPerMessage: 1, maxMessageImageBytes: 1024,
    maxImageDimension: 10, maxImagePixels: 100, mediaTypes: ['image/png'],
  } })
  await new ApiSessionList(ctx, 16).initialize()

  const first = message('first')
  const pending = message('pending')
  await append(
    { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } },
    userEvent(1, first),
    { type: 'turn/end', seq: 2, time: 12, data: { turn: 1, reason: { kind: 'completed' } } },
    title(parent, 3, 'older title'),
    splice(4, 'next-turn', 0, [pending]),
    splice(5, 'next-turn', 0, [pending], 1),
    splice(6, 'next-turn', 0, [], 1),
    splice(7, 'next-step', 0, [pending]),
  )
  const input = await request()
  // Header-only agentPreset is preserved before any agent-preset/selected event.
  assert.equal((await inspectHistory(input)).summary.agentPreset, 'creator')
  await assert.rejects(inspectHistory({ ...input, checkInbox: true }), { code: 'busy' })
  const cwd = join(header.cwd, 'subfolder')
  await append(
    splice(8, 'next-step', 0, [], 1),
    { type: 'working-directory/change', seq: 9, time: 19, data: { cwd } },
    title(parent, 10, 'newer title'),
    userEvent(11, message('host-notice', 'working-directory')),
    { type: 'agent-preset/selected', seq: 12, time: 22, data: { agentPreset: 'reviewer' } },
  )
  const read = await ctx.sessionPersistence.open(parent, 'read')
  try {
    const { events } = await read.read()
    const { snapshot } = ctx.sessionProjections.restore({}, events, 0, read.header, read.inheritedEventCount)
    assert.deepEqual(snapshot.values.inbox, { 'next-turn': [], 'next-step': [] })
    assert.equal(snapshot.values.agentPreset, 'reviewer')
    assert.deepEqual(await inspectHistory({ ...input, checkInbox: true }), {
      lastSeq: snapshot.asOfSeq,
      eventCount: events.length,
      inheritedEventCount: read.inheritedEventCount,
      summary: {
        title: snapshot.values.title,
        workingDirectory: cwd,
        agentPreset: snapshot.values.agentPreset,
        sessionListMetadata: snapshot.values.sessionListMetadata,
      },
      proof: false,
    })
  } finally { await read.close() }
  await append(splice(13, 'next-turn', 0, [pending]), splice(14, 'next-step', 0, [pending]))
  await assert.rejects(inspectHistory(input), { code: 'unsupported' })
})

test('history worker supports cwd sequence and first adjacent legacy notice as recovery proofs', integration, async (t) => {
  const { header, append, request } = await setup(t)
  const marker = 'legacy-notice'
  await append(
    { type: 'working-directory/change', seq: 0, time: 1, data: { cwd: header.cwd } },
    userEvent(1, message(marker, 'working-directory')),
    splice(2, 'next-turn', 0, [message('new-pending')]),
  )
  const input = await request()
  assert.equal((await inspectHistory({ ...input, cwdChangeSeq: 0 })).proof, true)
  assert.equal((await inspectHistory({ ...input, noticeId: marker })).proof, true)
  assert.equal((await inspectHistory({ ...input, cwdChangeSeq: 2, noticeId: marker })).proof, false)
  assert.equal((await inspectHistory({ ...input, noticeId: 'absent' })).proof, false)
  await assert.rejects(inspectHistory({ ...input, id: 'different' }), { code: 'changed' })
})

test('history worker consumes every frame, recovers torn final frames like DSH, and rejects corrupt logs', integration, async (t) => {
  const { ctx, append, request } = await setup(t)
  await append(userEvent(0, message('first')))
  await append(userEvent(1, message('second')))
  await append(userEvent(2, message('third')))
  const input = await request()
  const first = await inspectHistory(input)
  assert.equal(first.lastSeq, 2)
  assert.equal(first.eventCount, 3)
  assert.equal(first.tornTruncateTo, undefined)

  const checksummed = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
  const frame = zstdCompressSync(JSON.stringify({ type: 'plugin:test/large', ignorable: true,
    seq: 3, time: 13, data: { payload: randomBytes(256 * 1024).toString('base64') },
  }) + '\n', checksummed)
  assert.ok(frame.length > HISTORY_CHUNK_BYTES)
  const tail = zstdCompressSync(JSON.stringify(userEvent(4, message('last'))) + '\n', checksummed)
  await appendFile(input.path, Buffer.concat([frame, tail]))
  const beforeTorn = await readFile(input.path)
  const completeResult = await inspectHistory(input)
  assert.equal(completeResult.lastSeq, 4)
  assert.equal(completeResult.tornTruncateTo, undefined)

  // 1. Torn final frame missing the last checksum byte: matches stock DSH readZstdPrefix.
  const tailStart = beforeTorn.length - tail.length
  await writeFile(input.path, beforeTorn.subarray(0, beforeTorn.length - 1))
  const nativeRead1 = await ctx.sessionPersistence.open(parent, 'read')
  let nativeEvents1
  try { nativeEvents1 = (await nativeRead1.read()).events } finally { await nativeRead1.close() }
  const recovered1 = await inspectHistory(input)
  assert.equal(recovered1.eventCount, nativeEvents1.length)
  assert.equal(recovered1.lastSeq, 4)
  assert.equal(recovered1.tornTruncateTo, tailStart)
  assert.equal(recovered1.tornRecoveredCount, 1)

  // 2. Torn final frame carrying a pending inbox splice must still refuse moves.
  const busyTail = zstdCompressSync(JSON.stringify(splice(5, 'next-turn', 0, [message('torn-pending')])) + '\n', checksummed)
  await writeFile(input.path, Buffer.concat([beforeTorn, busyTail.subarray(0, busyTail.length - 1)]))
  await assert.rejects(inspectHistory({ ...input, checkInbox: true }), { code: 'busy' })

  // 3. Early truncated final frame (3 bytes): recovers prior complete frames with 0 tail records.
  await writeFile(input.path, Buffer.concat([beforeTorn, busyTail.subarray(0, 3)]))
  const nativeRead3 = await ctx.sessionPersistence.open(parent, 'read')
  let nativeEvents3
  try { nativeEvents3 = (await nativeRead3.read()).events } finally { await nativeRead3.close() }
  const recovered3 = await inspectHistory(input)
  assert.equal(recovered3.eventCount, nativeEvents3.length)
  assert.equal(recovered3.lastSeq, 4)
  assert.equal(recovered3.tornTruncateTo, beforeTorn.length)
  assert.equal(recovered3.tornRecoveredCount, 0)

  // 4. Multi-block torn final frame where record 5 completes inside block 1 and record 6 is truncated in block 2.
  const block1Record = JSON.stringify({ type: 'plugin:test/block', ignorable: true, seq: 5, time: 15,
    data: { payload: randomBytes(64 * 1024).toString('base64') } }) + '\n'
  const block2Record = JSON.stringify({ type: 'plugin:test/block', ignorable: true, seq: 6, time: 16,
    data: { payload: randomBytes(96 * 1024).toString('base64') } }) + '\n'
  const multiBlock = zstdCompressSync(block1Record + block2Record, checksummed)
  await writeFile(input.path, Buffer.concat([beforeTorn, multiBlock.subarray(0, Math.floor(multiBlock.length * 0.7))]))
  const nativeRead4 = await ctx.sessionPersistence.open(parent, 'read')
  let nativeEvents4
  try { nativeEvents4 = (await nativeRead4.read()).events } finally { await nativeRead4.close() }
  const recovered4 = await inspectHistory(input)
  assert.equal(recovered4.eventCount, nativeEvents4.length)
  assert.equal(recovered4.lastSeq, 5)
  assert.equal(recovered4.tornTruncateTo, beforeTorn.length)
  assert.equal(recovered4.tornRecoveredCount, 1)

  // 5. Complete frame with a corrupt checksum still rejects.
  const corrupt = Buffer.from(beforeTorn)
  corrupt[corrupt.length - 1] ^= 0xff
  await writeFile(input.path, corrupt)
  await assert.rejects(inspectHistory(input), /checksum/iu)

  // 6. Complete frame containing a torn JSONL record (no trailing newline) still rejects.
  const noNewlineFrame = zstdCompressSync(JSON.stringify(userEvent(5, message('no-newline'))), checksummed)
  await writeFile(input.path, Buffer.concat([beforeTorn, noNewlineFrame]))
  await assert.rejects(inspectHistory(input), { code: 'unsupported' })

  // 7. Invalid frame magic after complete frames still rejects.
  await writeFile(input.path, Buffer.concat([beforeTorn, Buffer.from([0xde, 0xad, 0xbe, 0xef])]))
  await assert.rejects(inspectHistory(input), { code: 'unsupported' })

  // 8. Truncated header frame (frame 0) still rejects.
  await writeFile(input.path, beforeTorn.subarray(0, 10))
  await assert.rejects(inspectHistory(input), { code: 'unsupported' })
})

test('summary string limits are unified at 1 MiB between worker and host protocol', workerPlatform, async (t) => {
  const { append, request } = await setup(t)
  const longTitle = 'a'.repeat(100 * 1024)
  await append({ type: 'session/title', seq: 0, time: 1, data: { title: longTitle, source: { kind: 'user' }, messageSeqs: [] } })
  const input = await request()
  assert.equal((await inspectHistory(input)).summary.title, longTitle)
  assert.equal((await inspectMoveHistory(input)).summary.title, longTitle)

  await append({ type: 'session/title', seq: 1, time: 2,
    data: { title: 'b'.repeat(MAX_SUMMARY_STRING_BYTES + 1), source: { kind: 'user' }, messageSeqs: [] } })
  await assert.rejects(inspectHistory(input), { code: 'history-resource' })
  await assert.rejects(inspectMoveHistory(input), { code: 'history-resource' })

  const presetHost = await setup(t, { agentPreset: 'c'.repeat(MAX_SUMMARY_STRING_BYTES + 1) })
  await presetHost.append(userEvent(0, message('oversized-preset')))
  const presetInput = await presetHost.request()
  await assert.rejects(inspectHistory(presetInput), { code: 'history-resource' })
  await assert.rejects(inspectMoveHistory(presetInput), { code: 'history-resource' })
})

test('canonical path check rejects dot-dot segments and accepts Windows case-only spelling', integration, async (t) => {
  const { append, request } = await setup(t, {}, 'MixedCaseHome')
  await append(userEvent(0, message('case-check')))
  const input = await request()
  const nonCanonical = `${dirname(input.path)}${sep}..${sep}${basename(dirname(input.path))}${sep}${basename(input.path)}`
  assert.notEqual(nonCanonical, input.path)
  await assert.rejects(inspectHistory({ ...input, path: nonCanonical }), { code: 'changed' })
  if (process.platform === 'win32') {
    const lowerCased = input.path.replace('MixedCaseHome', 'mixedcasehome')
    assert.notEqual(lowerCased, input.path)
    assert.equal((await inspectHistory({ ...input, path: lowerCased })).lastSeq, 0)
    assert.equal((await inspectMoveHistory({ ...input, path: lowerCased })).lastSeq, 0)
  }
})

test('the memory-limited worker sends only summary metadata and structured errors over IPC', workerPlatform, async (t) => {
  const { append, request } = await setup(t)
  await append(userEvent(0, message('original-message')))
  const input = await request()
  const expected = await inspectHistory(input)
  assert.deepEqual(await runHistory(input), expected)
  await assert.rejects(runHistory({ ...input, id: 'changed-session-id' }), { code: 'changed' })
})
