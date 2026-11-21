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

/**
 * Locate complete frames without decompressing their blocks.
 * @param buffer - complete bytes currently present in the session artifact.
 * @returns complete frame ranges and an optional incomplete-final-frame start.
 */
export function scanFrames(buffer) {
  const frames = []
  let offset = 0

  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4

    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }

  return { frames }
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
