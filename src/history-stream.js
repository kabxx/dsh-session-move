import { createHash } from 'node:crypto'
import { constants as fileFlags } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { deserialize, serialize } from 'node:v8'
import { constants, createZstdDecompress } from 'node:zlib'
import { sessionRequire } from './platform-fs.js'
import { createFrameScanner } from './zstd-frame.js'

export const HISTORY_CHUNK_BYTES = 128 * 1024
export const MAX_HISTORY_RECORD_BYTES = 16 * 1024 * 1024
export const MAX_SUMMARY_STRING_BYTES = 1024 * 1024
const windows = process.platform === 'win32'
const maxReferencesPerRecord = 256 * 1024
const maxRelationshipStateBytes = 48 * 1024 * 1024
const knownRelationshipTypes = new Set([
  'system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result', 'assistant/attempt',
  'turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call', 'request/header', 'request/context',
  'tool/ptc-dispatch-start', 'tool/ptc-dispatch', 'llm/retry', 'llm/retry-started', 'session/title',
  'session/title-llm-request', 'command/run', 'command/done', 'compaction/start', 'compaction/summary',
  'compaction/end', 'compaction/prune', 'session/end-seed', 'subagent/catalog', 'session-log-deepseek/delivery-accepted',
])
let modules

function sessionFormat() {
  return modules ??= (async () => {
    const require = sessionRequire()
    const load = (name) => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
    const [format, session] = await Promise.all([load('dsh-session-format-v3-to-v4'), load('dsh-session')])
    return { ...format, ...session }
  })()
}

function requireHistory(condition, message, code = 'unsupported') {
  if (!condition) throw Object.assign(new Error(message), { code })
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const fields = (value, keys) => isRecord(value)
  ? Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]))
  : value

function checkMessageSources({ type, data }) {
  if (!isRecord(data)) return
  let messages
  switch (type) {
    case 'user/message': messages = [data]; break
    case 'system/message': case 'developer/message': case 'assistant/message': case 'tool/result': messages = [data.message]; break
    case 'agent/inbox/spliced': messages = data.inserted; break
    case 'session/title-llm-request': messages = data.messages; break
    default: return
  }
  requireHistory(Array.isArray(messages), `${type} requires a message array`)
  for (const item of messages) {
    requireHistory(isRecord(item) && isRecord(item.source) && typeof item.source.kind === 'string'
      && item.source.kind.length > 0 && item.source.kind !== 'plugin', 'Invalid durable message source')
  }
}

// V4 encodes ranges in a single short row. Bound expansion before asking the
// native codec to allocate the expanded array and its uniqueness set.
function checkReferenceSize({ sourceEventSeqs }) {
  if (!Array.isArray(sourceEventSeqs)) return
  let count = 0
  for (const source of sourceEventSeqs) {
    count += Array.isArray(source) && Number.isSafeInteger(source[0]) && Number.isSafeInteger(source[1])
      ? Math.max(1, source[1] - source[0] + 1) : 1
    requireHistory(count <= maxReferencesPerRecord, 'History record exceeds the source reference budget', 'history-resource')
  }
}

function toolResultShape(data) {
  const { turn, step, message, error } = data
  const shape = fields(message, ['toolCallId', 'id', 'isError'])
  if (isRecord(shape)) shape.source = fields(message.source, ['kind'])
  // The native validator only inspects tool result content for its special
  // interrupted-before-start repair. Carry that witness without retaining tool output.
  const correction = 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.'
  if (Array.isArray(message?.content) && message.content.length === 1 && message.content[0]?.type === 'text'
    && message.content[0]?.text === correction) shape.content = [{ type: 'text', text: correction }]
  else if (Array.isArray(message?.content)) shape.content = []
  return { turn, step, message: shape, error: fields(error, ['name', 'code']) }
}

// Values used only in tool-lifecycle equality checks can be represented by
// collision-resistant hashes. The two domains stay separate: ordinary tool
// calls compare strings by value, while PTC uses deep, order-independent JSON.
function toolArgument(value) {
  return typeof value === 'string'
    ? createHash('sha256').update(value, 'utf16le').digest('hex') : value
}

function dispatchArgument(value) {
  if (value === undefined) return undefined
  const hash = createHash('sha256')
  function visit(item) {
    if (Array.isArray(item)) {
      hash.update('[')
      for (const child of item) visit(child)
      hash.update(']')
    } else if (isRecord(item)) {
      hash.update('{')
      for (const key of Object.keys(item).sort()) {
        hash.update(JSON.stringify(key)).update(':')
        visit(item[key])
      }
      hash.update('}')
    } else {
      // Distinguish the JSON numeric forms that isDeepStrictEqual treats as distinct.
      const token = typeof item === 'number' && !Number.isFinite(item) ? `number:${item}`
        : Object.is(item, -0) ? '-0' : JSON.stringify(item)
      hash.update(token).update(',')
    }
  }
  visit(value)
  return hash.digest('hex')
}

/** Capture exactly the earlier facts used by the pinned V4 relationship pass. */
function relationshipFact(event) {
  const { type, seq, data, surfaceOp, sourceEventSeqs } = event
  let evidence = data
  if (isRecord(data)) {
    switch (type) {
      case 'user/message':
        evidence = { source: fields(data.source, ['kind', 'compactionId', 'sourceCommandId']) }
        break
      case 'system/message':
        evidence = { turn: data.turn, step: data.step, message: { source: fields(data.message?.source, ['kind']) } }
        break
      case 'assistant/message': case 'developer/message': {
        const message = fields(data.message, ['id', 'role'])
        // Assistant source.replayState may carry a large model replay payload.
        // The native relationship pass needs only the producer kind.
        if (isRecord(message)) message.source = fields(data.message.source, ['kind'])
        const content = data.message?.content
        if (isRecord(message)) message.content = Array.isArray(content)
          ? content.filter((block) => !isRecord(block) || (type === 'assistant/message'
            ? block.type === 'tool-call' : block.type === 'tool-addition'))
            .map((block) => {
              const selected = fields(block, ['type', 'id', 'name', 'arguments', 'toolName'])
              if (isRecord(selected) && Object.hasOwn(selected, 'arguments')) selected.arguments = toolArgument(selected.arguments)
              return selected
            }) : content
        evidence = { ...fields(data, ['turn', 'step', 'headerSeq']), message }
        break
      }
      case 'tool/result': evidence = toolResultShape(data); break
      case 'request/header': {
        const { config, tools } = data.header
        evidence = { header: { config: fields(config, ['provider']), tools: Array.isArray(tools)
          ? tools.map((tool) => isRecord(tool) ? { ...fields(tool, ['name', 'description']),
            description: typeof tool.description === 'string' ? '' : tool.description,
            parameters: isRecord(tool.parameters) ? {} : null } : null) : tools } }
        break
      }
      case 'session/title-llm-request':
        evidence = { messageSeqs: data.messageSeqs, messages: Array.isArray(data.messages)
          ? data.messages.map((message) => {
            const selected = fields(message, ['role'])
            if (isRecord(selected)) {
              selected.source = fields(message.source, ['kind'])
              selected.content = Array.isArray(message.content)
                ? message.content.map((part) => fields(part, ['type'])) : message.content
            }
            return selected
          }) : data.messages }
        break
      case 'session/title': evidence = fields(data, ['source', 'messageSeqs']); break
      case 'tool/ptc-dispatch': case 'tool/ptc-dispatch-start':
        evidence = fields(data, ['subCallId', 'rootCallId', 'parentCallId', 'name'])
        evidence.arguments = dispatchArgument(data.arguments)
        break
      case 'tool/call':
        evidence = fields(data, ['turn', 'step', 'callId', 'name'])
        evidence.arguments = toolArgument(data.arguments)
        break
      case 'compaction/start': case 'compaction/summary': case 'compaction/end': case 'compaction/prune':
        evidence = fields(data, ['turn', 'compactionId', 'sourceCommandId', 'shadowedRange', 'shadowedSeqs', 'error']); break
      case 'llm/retry': case 'llm/retry-started': evidence = fields(data, ['turn', 'step', 'provider', 'retryId', 'retry', 'policyKey']); break
      case 'command/run': case 'command/done': evidence = fields(data, ['commandId', 'sourceEventSeq', 'kind']); break
      case 'turn/start': case 'turn/end': case 'step/start': case 'step/end': case 'assistant/attempt':
        evidence = fields(data, ['turn', 'step']); break
      case 'request/context': case 'session/end-seed': evidence = {}; break
      // Keep the catalog and delivery objects for native ownership checks.
    }
  }
  return { type, seq, data: evidence, surfaceOp, sourceEventSeqs }
}

class RelationshipState {
  #bytes = 0
  #facts = new Map()
  #headers = new Map()

  append(event) {
    if (!knownRelationshipTypes.has(event.type)) return
    const { seq, ...evidence } = relationshipFact(event)
    let fact = serialize(evidence)
    let newFactBytes = fact.byteLength
    if (event.type === 'request/header') {
      // Native writes commonly repeat one tool schema across many requests.
      const fingerprint = createHash('sha256').update(fact).digest('hex')
      const existing = this.#headers.get(fingerprint)
      if (existing) {
        requireHistory(existing.equals(fact), 'Conflicting native request header evidence')
        fact = existing
        newFactBytes = 0
      } else this.#headers.set(fingerprint, fact)
    }
    // Budget backing storage plus room for the index and the native validator's
    // surface, command, retry, and dispatch indices. No transcript text is stored.
    this.#bytes += newFactBytes * 2 + 96
    requireHistory(this.#bytes <= maxRelationshipStateBytes,
      `History exceeds the relationship validation budget at seq ${seq}`, 'history-resource')
    this.#facts.set(seq, fact)
  }

  events() {
    const facts = this.#facts
    return new Proxy({
      *[Symbol.iterator]() {
        for (const [seq, value] of facts) yield { ...deserialize(value), seq }
      },
    }, {
      get(target, key) {
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/u.test(key)) return Reflect.get(target, key)
        const seq = Number(key)
        const fact = facts.get(seq)
        return fact === undefined ? undefined : { ...deserialize(fact), seq }
      },
    })
  }
}

async function scanBoundaries(file, size) {
  const buffer = Buffer.allocUnsafe(Math.min(HISTORY_CHUNK_BYTES, size))
  const scanner = createFrameScanner()
  let headerEnd
  let offset = 0
  while (offset < size) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - offset), offset)
    requireHistory(bytesRead > 0, 'Session log changed while scanning', 'changed')
    try {
      scanner.write(buffer.subarray(0, bytesRead), (frame) => { headerEnd ??= frame.end })
    } catch (error) {
      throw Object.assign(error, { code: 'unsupported' })
    }
    offset += bytesRead
    if (headerEnd === undefined) {
      requireHistory(offset <= MAX_HISTORY_RECORD_BYTES, 'Compressed Zstandard header exceeds the record limit', 'history-resource')
    }
  }
  requireHistory(headerEnd !== undefined, 'Missing complete Zstandard header frame')
  requireHistory(headerEnd <= MAX_HISTORY_RECORD_BYTES, 'Compressed Zstandard header exceeds the record limit', 'history-resource')
  return { headerEnd, tornTruncateTo: scanner.finish() }
}

// Some Node releases silently discard a later frame when its bytes arrive in
// the same input chunk as an earlier one. Isolate each frame while keeping both
// the compressed input and decompressed output streaming.
async function* frameParts(input) {
  const scanner = createFrameScanner()
  let offset = 0
  for await (const chunk of input) {
    const ends = []
    scanner.write(chunk, ({ end }) => ends.push(end - offset))
    let cursor = 0
    for (const end of ends) {
      yield { bytes: chunk.subarray(cursor, end), last: true }
      cursor = end
    }
    if (cursor < chunk.length) yield { bytes: chunk.subarray(cursor), last: false }
    offset += chunk.length
  }
  requireHistory(scanner.finish() === undefined, 'Incomplete Zstandard frame')
}

async function* readFrame(parts, part) {
  for (;;) {
    yield part.bytes
    if (part.last) return
    const next = await parts.next()
    requireHistory(!next.done, 'Incomplete Zstandard frame')
    part = next.value
  }
}

async function* decodeFrames(input) {
  const parts = frameParts(input)
  try {
    for await (const first of parts) {
      const frame = Readable.from(readFrame(parts, first), { objectMode: false, highWaterMark: HISTORY_CHUNK_BYTES })
      const decoder = createZstdDecompress({ chunkSize: HISTORY_CHUNK_BYTES,
        params: { [constants.ZSTD_d_windowLogMax]: 27 } })
      const transport = pipeline(frame, decoder).then(() => undefined, (error) => error)
      try {
        yield* decoder
        const error = await transport
        if (error) throw error
      } finally {
        decoder.destroy()
        await transport
      }
    }
  } finally {
    await parts.return()
  }
}

async function* readRecords(file, { compressed, start, end }) {
  const input = file.createReadStream({ start, end, autoClose: false, highWaterMark: HISTORY_CHUNK_BYTES })
  const decoded = compressed ? decodeFrames(input) : input
  // Match the native scanner's UTF-8 replacement behavior. Keep the line cap
  // on raw bytes while collecting only an incomplete record between chunks.
  let fragments = []
  let bytes = 0
  for await (const chunk of decoded) {
    let cursor = 0
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(0x0a, cursor)
      const part = chunk.subarray(cursor, newline < 0 ? chunk.length : newline + 1)
      bytes += part.length
      requireHistory(bytes <= MAX_HISTORY_RECORD_BYTES, 'History contains a record larger than 16 MiB', 'history-resource')
      if (newline < 0) fragments.push(part)
      else {
        const line = fragments.length ? Buffer.concat([...fragments, part], bytes) : part
        fragments = []
        bytes = 0
        yield JSON.parse(line.toString('utf8'))
      }
      cursor += part.length
    }
  }
  requireHistory(bytes === 0, 'History contains an incomplete final record')
}

// Mirror DSH's `readZstdPrefix` torn-tail recovery: flush available plaintext
// from a structurally incomplete final frame, keep complete newline-terminated
// records, and drop an incomplete final line.
async function* readTornRecords(file, { start, end }) {
  const input = file.createReadStream({ start, end, autoClose: false, highWaterMark: HISTORY_CHUNK_BYTES })
  const decoder = createZstdDecompress({
    chunkSize: HISTORY_CHUNK_BYTES,
    finishFlush: constants.ZSTD_e_flush,
    params: { [constants.ZSTD_d_windowLogMax]: 27 },
  })
  const transport = pipeline(input, decoder).then(() => undefined, (error) => error)
  const iterator = decoder[Symbol.asyncIterator]()
  let fragments = []
  let bytes = 0
  let emitted = 0
  try {
    for (;;) {
      let step
      try {
        step = await iterator.next()
      } catch (error) {
        if (emitted === 0) return
        throw Object.assign(new Error('Corrupt trailing Zstandard frame', { cause: error }), { code: 'unsupported' })
      }
      if (step.done) break
      const chunk = step.value
      let cursor = 0
      while (cursor < chunk.length) {
        const newline = chunk.indexOf(0x0a, cursor)
        const part = chunk.subarray(cursor, newline < 0 ? chunk.length : newline + 1)
        bytes += part.length
        requireHistory(bytes <= MAX_HISTORY_RECORD_BYTES, 'History contains a record larger than 16 MiB', 'history-resource')
        if (newline < 0) fragments.push(part)
        else {
          const line = fragments.length ? Buffer.concat([...fragments, part], bytes) : part
          fragments = []
          bytes = 0
          const record = JSON.parse(line.toString('utf8'))
          emitted++
          yield record
        }
        cursor += part.length
      }
    }
    const error = await transport
    if (error && emitted > 0) {
      throw Object.assign(new Error('Corrupt trailing Zstandard frame', { cause: error }), { code: 'unsupported' })
    }
  } finally {
    decoder.destroy()
    await transport
  }
}

function sameFile(first, next) {
  return next.isFile() && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => first[key] === next[key])
}

function sameCanonicalPath(actual, expected) {
  if (resolve(expected) !== expected) return false
  const normalize = (value) => windows ? value.toLowerCase() : value
  return normalize(actual) === normalize(expected)
}

/** Read an unchanged v4 artifact, awaiting each callback before advancing. */
export async function scanHistory(path, { onHeader, onEvent } = {}) {
  requireHistory(typeof path === 'string' && isAbsolute(path) && /^session\.v4\.jsonl(?:\.zstd)?$/u.test(basename(path)),
    'Invalid current session log path')
  requireHistory(sameCanonicalPath(await realpath(path), path), 'Noncanonical session log path', 'changed')
  const file = await open(path, fileFlags.O_RDONLY | (fileFlags.O_NONBLOCK ?? 0) | (fileFlags.O_NOFOLLOW ?? 0))
  try {
    const initial = await file.stat({ bigint: true })
    requireHistory(initial.isFile() && initial.size > 0n && initial.size <= BigInt(Number.MAX_SAFE_INTEGER), 'Invalid session log size')
    requireHistory(sameFile(initial, await lstat(path, { bigint: true })), 'Session log identity changed', 'changed')
    const size = Number(initial.size)
    const end = size - 1
    const compressed = path.endsWith('.zstd')
    const boundaries = compressed ? await scanBoundaries(file, size) : undefined
    const headerEnd = boundaries?.headerEnd
    const tornTruncateTo = boundaries?.tornTruncateTo
    const { adoptSessionEvent, KNOWN_SESSION_EVENT_TYPES, releasedV4SessionFormatCodec, assertReleasedV4Header,
      assertV4RowAdmission, assertReleasedV4Relationships } = await sessionFormat()
    const relationships = new RelationshipState()
    let decoder
    let eventCount = 0
    let tornRecoveredCount = 0
    const decodeHeader = async (record) => {
      requireHistory(decoder === undefined, 'The first Zstandard frame must contain exactly one header record')
      decoder = releasedV4SessionFormatCodec.createDecoder(record, 'strict')
      assertReleasedV4Header(decoder.header)
      await onHeader?.(Object.freeze(decoder.header))
    }
    let event
    const context = {
      emitEvent(value) { event = adoptSessionEvent(value) },
      emitRun() { throw new Error('Unexpected compressed event run in v4 log') },
    }
    const decodeEvent = async (record) => {
      const known = KNOWN_SESSION_EVENT_TYPES.has(record?.type)
      requireHistory(known || record?.ignorable === true, 'History contains an unknown required event')
      requireHistory(record?.type !== 'request/header' || record.data?.reason !== 'fallback', 'History contains a retired request header')
      checkReferenceSize(record)
      assertV4RowAdmission(record, KNOWN_SESSION_EVENT_TYPES)
      decoder.decodeRow(record, context)
      if (known) {
        checkMessageSources(event)
        relationships.append(event)
      }
      eventCount++
      await onEvent?.(event)
      event = undefined
    }
    if (compressed) {
      for await (const record of readRecords(file, { compressed, start: 0, end: headerEnd - 1 })) await decodeHeader(record)
      requireHistory(decoder !== undefined, 'Missing session header')
      const completeEnd = (tornTruncateTo ?? size) - 1
      if (headerEnd <= completeEnd) {
        for await (const record of readRecords(file, { compressed, start: headerEnd, end: completeEnd })) await decodeEvent(record)
      }
      if (tornTruncateTo !== undefined) {
        for await (const record of readTornRecords(file, { start: tornTruncateTo, end })) {
          await decodeEvent(record)
          tornRecoveredCount++
        }
      }
    } else {
      for await (const record of readRecords(file, { compressed, start: 0, end })) {
        if (decoder === undefined) await decodeHeader(record)
        else await decodeEvent(record)
      }
      requireHistory(decoder !== undefined, 'Missing session header')
    }
    const header = decoder.header
    const inheritedEventCount = decoder.finish(context)
    assertReleasedV4Relationships({ header, inheritedEventCount, events: relationships.events() }, KNOWN_SESSION_EVENT_TYPES)
    requireHistory(sameFile(initial, await file.stat({ bigint: true })) && sameFile(initial, await lstat(path, { bigint: true }))
      && sameCanonicalPath(await realpath(path), path), 'Session log changed while scanning', 'changed')
    return {
      header, inheritedEventCount, eventCount, lastSeq: eventCount - 1,
      ...(tornTruncateTo === undefined ? {} : { tornTruncateTo, tornRecoveredCount }),
    }
  } finally { await file.close() }
}
