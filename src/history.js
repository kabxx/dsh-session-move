import { runHistory } from './history-process.js'
import { MAX_SUMMARY_STRING_BYTES } from './history-stream.js'
import { fail } from './plan.js'
import { sessionInstallDirectory } from './platform-fs.js'

/** Read only bounded derived metadata from a v4 transcript. */
export async function inspectMoveHistory({ path, id, cwd, checkInbox, cwdChangeSeq, noticeId }, options) {
  let result
  try {
    result = await runHistory({ path, id, cwd, checkInbox, cwdChangeSeq, noticeId },
      { ...options, installDirectory: sessionInstallDirectory() })
  } catch (error) {
    assertPreparing(options?.signal)
    if (error.code === 'unsupported') throw fail('history-invalid', error)
    if (error.code === 'history-ipc-limit' || error.code === 'history-limit') throw fail('history-resource', error)
    throw error
  }
  const { lastSeq, eventCount, inheritedEventCount, summary, proof, tornTruncateTo, tornRecoveredCount } = result ?? {}
  const { title, workingDirectory, agentPreset, sessionListMetadata: metadata } = summary ?? {}
  const hasTorn = tornTruncateTo !== undefined || tornRecoveredCount !== undefined
  const validTorn = !hasTorn || (
    Number.isSafeInteger(tornTruncateTo) && tornTruncateTo > 0
    && Number.isSafeInteger(tornRecoveredCount) && tornRecoveredCount >= 0 && tornRecoveredCount <= eventCount
  )
  if (!Number.isSafeInteger(lastSeq) || lastSeq < -1 || lastSeq >= Number.MAX_SAFE_INTEGER
    || !Number.isSafeInteger(eventCount) || eventCount < 0 || eventCount !== lastSeq + 1
    || !Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0 || inheritedEventCount > eventCount
    || (typeof title !== 'string' && title !== null)
    || (typeof workingDirectory !== 'string' && workingDirectory !== null)
    || (typeof agentPreset !== 'string' && agentPreset !== null)
    || (title !== null && Buffer.byteLength(title) > MAX_SUMMARY_STRING_BYTES)
    || (workingDirectory !== null && Buffer.byteLength(workingDirectory) > MAX_SUMMARY_STRING_BYTES)
    || (agentPreset !== null && Buffer.byteLength(agentPreset) > MAX_SUMMARY_STRING_BYTES)
    || typeof metadata?.blank !== 'boolean' || (metadata.lastPromptAt !== null && !Number.isFinite(metadata.lastPromptAt))
    || ((cwdChangeSeq !== undefined || noticeId !== undefined) && typeof proof !== 'boolean')
    || !validTorn) throw fail('history-protocol')
  return result
}

export function assertPreparing(signal) {
  if (signal?.aborted) {
    throw fail(signal.reason?.name === 'TimeoutError' ? 'history-timeout' : 'history-cancelled', signal.reason)
  }
}
