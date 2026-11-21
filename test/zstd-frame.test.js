import assert from 'node:assert/strict'
import { constants, zstdCompressSync } from 'node:zlib'
import { test } from 'node:test'
import { decodeAll, readHeader, rewriteHeaderCwd, scanFrames } from '../src/zstd-frame.js'

const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

function frame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), CHECKSUM)
}

function artifact(header, body) {
  const headerLine = JSON.stringify(header) + '\n'
  const bodyLines = body.map((line) => JSON.stringify(line) + '\n').join('')
  return Buffer.concat([
    frame(headerLine),
    frame(bodyLines.slice(0, Math.floor(bodyLines.length / 2))),
    frame(bodyLines.slice(Math.floor(bodyLines.length / 2))),
  ])
}

const HEADER = { type: 'session', version: 4, id: 'abc', createdAt: 1, cwd: '/old/place' }
const BODY = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }]

test('scanFrames finds every concatenated frame', () => {
  const buffer = artifact(HEADER, BODY)
  const { frames, tornStart } = scanFrames(buffer)
  assert.equal(frames.length, 3)
  assert.equal(tornStart, undefined)
  assert.equal(frames[0].start, 0)
  assert.equal(frames.at(-1).end, buffer.length)
})

test('scanFrames reports a torn final frame instead of throwing', () => {
  const buffer = artifact(HEADER, BODY)
  const { frames, tornStart } = scanFrames(buffer.subarray(0, buffer.length - 3))
  assert.equal(frames.length, 2)
  assert.equal(typeof tornStart, 'number')
})

test('scanFrames rejects a corrupt stream', () => {
  const broken = Buffer.from(artifact(HEADER, BODY))
  broken.writeUInt32LE(0xdeadbeef, 0)
  assert.throws(() => scanFrames(broken), /invalid frame magic/u)
})

test('readHeader returns the first frame payload', () => {
  assert.deepEqual(readHeader(artifact(HEADER, BODY)), HEADER)
})

test('rewriteHeaderCwd changes only the header and keeps the body byte-identical', () => {
  const buffer = artifact(HEADER, BODY)
  const next = rewriteHeaderCwd(buffer, '/new/place')
  assert.equal(readHeader(next).cwd, '/new/place')
  assert.equal(readHeader(next).id, 'abc')
  const before = decodeAll(buffer).toString('utf8').split('\n').filter(Boolean).slice(1)
  const after = decodeAll(next).toString('utf8').split('\n').filter(Boolean).slice(1)
  assert.deepEqual(after, before)
})

test('rewriteHeaderCwd is a no-op when the cwd already matches', () => {
  const buffer = artifact(HEADER, BODY)
  assert.equal(rewriteHeaderCwd(buffer, '/old/place'), buffer)
})

test('rewriteHeaderCwd keeps the header key order', () => {
  const buffer = artifact(HEADER, BODY)
  const text = decodeAll(rewriteHeaderCwd(buffer, '/new/place')).toString('utf8')
  const firstLine = text.slice(0, text.indexOf('\n'))
  assert.deepEqual(Object.keys(JSON.parse(firstLine)), Object.keys(HEADER))
})

test('rewriteHeaderCwd refuses a log that does not start with a header', () => {
  const notAHeader = Buffer.concat([frame('{"type":"turn/start"}\n')])
  assert.throws(() => rewriteHeaderCwd(notAHeader, '/x'), /does not begin with a session header/u)
})
