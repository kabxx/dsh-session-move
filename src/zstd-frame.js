/**
 * Zstandard frame surgery for the JSONL session container.
 *
 * DSH stores a session as a concatenation of independently decodable
 * Zstandard frames; the first frame holds exactly the session header line.
 * Rewriting `cwd` therefore only needs that frame: the remaining frames are
 * copied byte-for-byte, so a multi-megabyte transcript is never recompressed
 * and its event payloads are never re-encoded.
 *
 * The frame scanner mirrors `dsh-session-persistence-jsonl/src/zstd.ts`
 * (`scanZstdFrames`) — see `test/zstd-frame.test.js`, which checks this copy
 * against real session files.
 *
 * @module dsh-session-move/zstd-frame
 */

import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xFD2FB528
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

const FRAME_MAGIC_BYTES = 4

/** Scan compressed frame boundaries with fixed scratch space and no body decompression. */
export function createFrameScanner() {
  const scratch = Buffer.allocUnsafe(4)
  let phase = 'magic'
  let remaining = FRAME_MAGIC_BYTES
  let offset = 0
  let start = 0
  let checksum
  let lastBlock

  function nextPhase(name, bytes) {
    phase = name
    remaining = bytes
  }

  function completeFrame(onFrame) {
    const end = offset
    nextPhase('magic', FRAME_MAGIC_BYTES)
    onFrame?.({ start, end })
    start = end
  }

  function advance(onFrame) {
    switch (phase) {
      case 'magic':
        if (scratch.readUInt32LE(0) !== ZSTD_MAGIC) {
          throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${start}`)
        }
        nextPhase('descriptor', 1)
        break
      case 'descriptor': {
        const descriptor = scratch[0]
        if ((descriptor & 0x18) !== 0) {
          throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
        }
        const contentSizeFlag = descriptor >>> 6
        const singleSegment = (descriptor & 0x20) !== 0
        checksum = (descriptor & 0x04) !== 0
        const dictionaryFlag = descriptor & 0x03
        const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
        const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
        nextPhase('frame-header', (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes)
        break
      }
      case 'frame-header':
        nextPhase('block-header', 3)
        break
      case 'block-header': {
        const blockHeader = scratch.readUIntLE(0, 3)
        lastBlock = (blockHeader & 1) !== 0
        const blockType = (blockHeader >>> 1) & 0x03
        if (blockType === 0x03) {
          throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
        }
        nextPhase('block', blockType === 0x01 ? 1 : blockHeader >>> 3)
        break
      }
      case 'block':
        if (!lastBlock) nextPhase('block-header', 3)
        else if (checksum) nextPhase('checksum', 4)
        else completeFrame(onFrame)
        break
      case 'checksum':
        completeFrame(onFrame)
    }
  }

  return {
    write(chunk, onFrame) {
      let cursor = 0
      while (cursor < chunk.length) {
        const count = Math.min(remaining, chunk.length - cursor)
        // Only descriptor and block metadata need to survive a chunk boundary.
        if (phase === 'magic' || phase === 'descriptor' || phase === 'block-header') {
          const fieldWidth = phase === 'magic' ? FRAME_MAGIC_BYTES : phase === 'descriptor' ? 1 : 3
          chunk.copy(scratch, fieldWidth - remaining, cursor, cursor + count)
        }
        cursor += count
        offset += count
        remaining -= count
        while (remaining === 0) advance(onFrame)
      }
    },
    finish() { return offset === start ? undefined : start },
  }
}

/** Locate complete frames in an in-memory artifact. */
export function scanFrames(buffer) {
  const frames = []
  const scanner = createFrameScanner()
  scanner.write(buffer, (frame) => frames.push(frame))
  const tornStart = scanner.finish()
  return tornStart === undefined ? { frames } : { frames, tornStart }
}

/**
 * Read the session header out of the first frame.
 * @param buffer - complete session artifact bytes.
 * @returns the parsed header object.
 */
export function readHeader(buffer) {
  const { frames } = scanFrames(buffer)
  if (frames.length === 0) throw new Error('corrupt Zstandard session log: no complete frame')
  const plain = zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end)).toString('utf8')
  const newline = plain.indexOf('\n')
  const line = newline === -1 ? plain : plain.slice(0, newline)
  const header = JSON.parse(line)
  if (header === null || typeof header !== 'object' || header.type !== 'session') {
    throw new Error('session log does not begin with a session header')
  }
  return header
}

/**
 * Rewrite the header's `cwd`, recompressing only the first frame.
 *
 * Returns the input buffer unchanged when the header already carries `cwd`,
 * so the caller can treat "nothing to do" without a second parse.
 * @param buffer - complete session artifact bytes.
 * @param cwd - the new project path, verbatim as stored by the workspace record.
 * @returns the new artifact bytes.
 */
export function rewriteHeaderCwd(buffer, cwd) {
  const { frames } = scanFrames(buffer)
  if (frames.length === 0) throw new Error('corrupt Zstandard session log: no complete frame')
  const first = frames[0]
  const plain = zstdDecompressSync(buffer.subarray(first.start, first.end)).toString('utf8')
  const newline = plain.indexOf('\n')
  const line = newline === -1 ? plain : plain.slice(0, newline)
  const header = JSON.parse(line)
  if (header === null || typeof header !== 'object' || header.type !== 'session') {
    throw new Error('session log does not begin with a session header')
  }
  if (header.cwd === cwd) return buffer

  header.cwd = cwd
  // Preserve key order and the original line ending by rebuilding the same
  // text layout around the mutated header object.
  const rebuilt = JSON.stringify(header) + (newline === -1 ? '' : plain.slice(newline))
  const frame = zstdCompressSync(Buffer.from(rebuilt, 'utf8'), CHECKSUM_OPTIONS)
  return Buffer.concat([frame, buffer.subarray(first.end)])
}

/**
 * Decompress every frame of a session artifact.
 * @param buffer - complete session artifact bytes.
 * @returns the concatenated plaintext.
 */
export function decodeAll(buffer) {
  const { frames } = scanFrames(buffer)
  return Buffer.concat(frames.map(({ start, end }) => zstdDecompressSync(buffer.subarray(start, end))))
}
