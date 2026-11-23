import { isAbsolute } from 'node:path'
import { historyMessageBytes, historyReady, historyWorkerArg, verifyHistoryIsolation } from './history-process.js'
import { MAX_SUMMARY_STRING_BYTES, scanHistory } from './history-stream.js'

const maxPendingMessages = 8192
const maxPendingIdBytes = 1024 * 1024
const oversizedSummary = Symbol('oversized summary')
const sequence = (value) => Number.isSafeInteger(value) && value >= 0
const directory = (value) => typeof value === 'string' && isAbsolute(value) && !value.includes('\0')

// A short JSON string may otherwise retain its whole decoded source line.
function retainString(value) {
  return Buffer.from(value, 'utf16le').toString('utf16le')
}

function retainSummary(value) {
  return Buffer.byteLength(value) <= MAX_SUMMARY_STRING_BYTES ? retainString(value) : oversizedSummary
}

function historyError(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { code })
}

function requireEvent(condition, message) {
  if (!condition) throw historyError('unsupported', message)
}

/** Incremental equivalent of AgentLoop's inbox fold, retaining only pending message identities. */
function createInbox() {
  const queue = { 'next-turn': [], 'next-step': [] }
  const pending = new Set()
  let idBytes = 0
  return {
    get busy() { return pending.size !== 0 },
    apply(event) {
      const { target, start, removedCount, inserted } = event.data
      requireEvent(Object.hasOwn(queue, target) && Array.isArray(inserted), 'Invalid durable inbox splice')
      const current = queue[target]
      const count = removedCount ?? 0
      requireEvent(sequence(start) && start <= current.length && sequence(count) && count <= current.length - start,
        'Invalid durable inbox splice range')
      if (pending.size - count + inserted.length > maxPendingMessages) {
        throw historyError('history-resource', 'Durable inbox exceeds the pending message limit')
      }
      // Removing first also permits replacing an item with the same identity.
      // A malformed insertion aborts the scan, so no partial state can escape.
      for (let index = start; index < start + count; index++) {
        const id = current[index]
        pending.delete(id)
        idBytes -= Buffer.byteLength(id)
      }
      const newIds = []
      for (const message of inserted) {
        const id = message?.id
        requireEvent(typeof id === 'string' && id.length > 0 && !pending.has(id), 'Invalid or duplicate durable inbox message identity')
        idBytes += Buffer.byteLength(id)
        if (idBytes > maxPendingIdBytes) throw historyError('history-resource', 'Durable inbox identities exceed the byte limit')
        const retained = retainString(id)
        pending.add(retained)
        newIds.push(retained)
      }
      current.splice(start, count, ...newIds)
    },
  }
}

/** Inspect one native v4 log without holding an event list or forwarding user message payloads. */
export async function inspectHistory(request) {
  const { path, id, cwd, cwdChangeSeq, noticeId, checkInbox = false } = request ?? {}
  requireEvent(directory(path) && typeof id === 'string' && id.length > 0 && directory(cwd)
    && (cwdChangeSeq === undefined || sequence(cwdChangeSeq))
    && (noticeId === undefined || (typeof noticeId === 'string' && noticeId.length > 0))
    && typeof checkInbox === 'boolean', 'Invalid history inspection parameters')

  const inbox = createInbox()
  const sessionListMetadata = { blank: true, lastPromptAt: null }
  let title = null
  let workingDirectory = cwd
  let agentPreset = null
  let proof = false
  let foundLegacyNotice = false
  let previousWasDirectoryChange = false
  const legacy = cwdChangeSeq === undefined && noticeId !== undefined

  const history = await scanHistory(path, {
    onHeader(header) {
      if (header.id !== id || header.cwd !== cwd) throw historyError('changed', 'Session header no longer matches the expected session and path')
      if (header.agentPreset !== undefined && header.agentPreset !== null) {
        requireEvent(typeof header.agentPreset === 'string', 'Invalid session agent preset')
        agentPreset = retainSummary(header.agentPreset)
      }
    },
    onEvent(event) {
      const { type, data, seq, time } = event
      // These summary fields mirror the registered stock DSH projections.
      switch (type) {
        case 'agent/inbox/spliced':
          inbox.apply(event)
          break
        case 'session/title':
          requireEvent(typeof data?.title === 'string' && data.title.length > 0, 'Invalid session title')
          title = retainSummary(data.title)
          break
        case 'working-directory/change':
          requireEvent(typeof data?.cwd === 'string', 'Invalid session working directory')
          workingDirectory = retainSummary(data.cwd)
          break
        case 'agent-preset/selected':
          requireEvent(typeof data?.agentPreset === 'string', 'Invalid session agent preset')
          agentPreset = retainSummary(data.agentPreset)
          break
        case 'turn/start':
          sessionListMetadata.blank = false
          break
        case 'user/message':
          if (data.source?.kind === 'user') sessionListMetadata.lastPromptAt = time
          break
      }
      const isDirectoryChange = type === 'working-directory/change' && data?.cwd === cwd
      if (cwdChangeSeq !== undefined) {
        if (seq === cwdChangeSeq) proof = isDirectoryChange
      } else if (legacy && !foundLegacyNotice && type === 'user/message' && data?.id === noticeId) {
        proof = previousWasDirectoryChange
        foundLegacyNotice = true
      }
      previousWasDirectoryChange = isDirectoryChange
    },
  })
  if (checkInbox && inbox.busy) throw historyError('busy', 'Session has pending input')
  if (title === oversizedSummary || workingDirectory === oversizedSummary || agentPreset === oversizedSummary) {
    throw historyError('history-resource', 'Session summary exceeds its string byte limit')
  }
  requireEvent(directory(workingDirectory), 'Invalid session working directory')
  return {
    lastSeq: history.lastSeq,
    eventCount: history.eventCount,
    inheritedEventCount: history.inheritedEventCount,
    summary: { title, workingDirectory, agentPreset, sessionListMetadata },
    proof,
    ...(history.tornTruncateTo === undefined ? {} : {
      tornTruncateTo: history.tornTruncateTo,
      tornRecoveredCount: history.tornRecoveredCount,
    }),
  }
}

async function readRequest(maxBytes) {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > maxBytes) throw historyError('history-ipc-limit', 'History inspection request exceeds the communication limit')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
}

const supportedCodes = new Set(['busy', 'changed', 'unsupported', 'history-resource', 'history-ipc-limit'])

async function main() {
  await verifyHistoryIsolation(process.argv[3])
  process.stdout.write(historyReady)
  let output
  try {
    const value = await inspectHistory(await readRequest(historyMessageBytes))
    output = JSON.stringify({ ok: true, value })
    if (Buffer.byteLength(output) + Buffer.byteLength(historyReady) > historyMessageBytes) {
      throw historyError('history-ipc-limit', 'History inspection response exceeds the communication limit')
    }
  } catch (error) {
    const code = supportedCodes.has(error?.code) ? error.code : 'unsupported'
    const message = String(error?.message ?? 'History inspection failed').slice(0, 512)
    output = JSON.stringify({ ok: false, code, message })
  }
  await new Promise((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()))
}

if (process.argv[2] === historyWorkerArg) {
  await main().catch(() => { process.exitCode = 1 })
}
