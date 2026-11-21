import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { storagePaths } from './config.js'
import { refreshSearchIndex, repairLegacyDuplicates, restoreLedger, withPublishedLedger } from './ledger.js'
import { refreshSessionSummaries } from './sidebar.js'
import { LOG_FILENAME } from './paths.js'
import { fail } from './plan.js'
import { sessionRequire } from './platform-fs.js'
import { moveStorage, recoverLegacyDisk } from './transaction.js'

export const inject = ['storageDomain', 'sessionPersistence', 'dshHomePath']

function atLocation(snapshot, id, cwd, directory) {
  return snapshot?.header?.id === id && snapshot.header.cwd === cwd
    && snapshot.location?.kind === 'jsonl' && snapshot.location.path === join(directory, LOG_FILENAME)
}

/** The native reader verifies that each member is unique and matches its path. */
async function verifyScanSafety(ctx, state, { allowEitherSide = false } = {}) {
  for (const { id, oldCwd, oldDir, nextDir } of state.members) {
    const snapshot = await ctx.sessionPersistence.stat(id)
    const atSource = atLocation(snapshot, id, oldCwd, oldDir)
    const atTarget = atLocation(snapshot, id, state.targetCwd, nextDir)
    const safe = allowEitherSide ? atSource || atTarget : state.phase === 'committed' ? atTarget : atSource
    if (!safe) throw fail('restore-pending')
  }
}

/** Confirm that the move's exact output still precedes any subsequent appends. */
async function hasPublishedHistory(ctx, storage, state) {
  for (const { id, nextDir } of state.members) {
    const snapshot = await ctx.sessionPersistence.stat(id)
    if (!atLocation(snapshot, id, state.targetCwd, nextDir)) return false
  }
  try { await storage.verifyPublished(state) } catch (error) {
    if (error.code === 'changed') return false
    throw error
  }
  for (const { id, oldCwd, cwdChangeSeq, noticeId } of state.members) {
    if (oldCwd === state.targetCwd) continue
    const handle = await ctx.sessionPersistence.open(id, 'read')
    try {
      if (handle.header.id !== id || handle.header.cwd !== state.targetCwd) return false
      const { events } = await handle.read()
      let directory
      if (cwdChangeSeq !== undefined) {
        directory = events.find(({ seq }) => seq === cwdChangeSeq)
      } else if (typeof noticeId === 'string') {
        // Older v2 journals identified the change by the following notice.
        const noticeIndex = events.findIndex(({ type, data }) => type === 'user/message' && data?.id === noticeId)
        if (noticeIndex > 0) directory = events[noticeIndex - 1]
      }
      if (directory?.type !== 'working-directory/change' || directory.data?.cwd !== state.targetCwd) return false
    } finally { await handle.close() }
  }
  return true
}

async function verifyWhileContended(ctx, storage) {
  // A prepared intent may belong to an active mover that has yet to hide the
  // source. Only terminal intents have an authoritative visible side while
  // another process owns the move lock.
  const state = await storage.readState()
  if (!state) return
  if (state.phase === 'prepared') throw fail('restore-pending')
  await verifyScanSafety(ctx, state)
  const latest = await storage.readState()
  if (latest && (latest.ticket !== state.ticket || latest.phase !== state.phase)) throw fail('restore-pending')
}

/** Retry a journal. Only startup may defer work after proving scan safety. */
export async function recoverMove(ctx, storage, { startup = false, withLedger = (run) => run() } = {}) {
  if (!await storage.hasJournal()) return
  let scanSafe = false
  try {
    await storage.withLock(async () => {
      const state = await storage.readState()
      if (!state) {
        scanSafe = true
        return
      }
      if (state.phase === 'prepared' && await storage.hasHeld(state)) {
        try {
          const committed = await storage.withSessionLocks(state, async () => {
            if (await hasPublishedHistory(ctx, storage, state)) {
              const terminal = { ...state, phase: 'committed' }
              const confirmed = await withLedger((options) => withPublishedLedger(ctx, state, state.ledger, async () => {
                scanSafe = true
                await storage.save(terminal)
              }, options))
              if (confirmed) {
                await storage.cleanCommitted(terminal)
                return true
              }
            }
            await storage.rollback(state)
            return false
          }, { recovery: true })
          if (committed) {
            if (!startup) {
              await refreshSessionSummaries(ctx, state.members.map(({ id }) => ({ id, cwd: state.targetCwd })))
              await refreshSearchIndex(ctx)
            }
            return
          }
        } catch (error) {
          // A failed rollback can still leave every transcript visible. Its
          // journal and original bytes remain available for a later retry.
          if (startup) {
            try {
              await verifyScanSafety(ctx, state, { allowEitherSide: true })
              scanSafe = true
            } catch { /* Resolve the invisible or inconsistent log before startup. */ }
          }
          throw error
        }
      }
      await verifyScanSafety(ctx, state)
      scanSafe = true

      if (state.phase === 'committed') {
        await storage.withSessionLocks(state, () => storage.cleanCommitted(state), { recovery: true })
        return
      }
      if (state.phase === 'prepared') {
        await withLedger((options) => restoreLedger(ctx, state, state.ledger, options))
        await storage.save({ ...state, phase: 'rolled-back' })
      }
      await storage.finish(state)
    })
  } catch (error) {
    if (startup && !scanSafe && error.code === 'locked') {
      try {
        await verifyWhileContended(ctx, storage)
        scanSafe = true
      } catch { /* The active journal has not reached a verifiable stable side. */ }
    }
    if (!startup || !scanSafe) throw fail('restore-pending', error)
    ctx.logger?.warn?.('Session move: recovery deferred until the next move or restart: %s', error)
  }
}

export async function apply(ctx) {
  const { root, base, legacy, previous } = storagePaths(ctx)
  const withLedger = async (run) => {
    const resolve = sessionRequire()
    const { workspaceDomainSpec } = await import(pathToFileURL(resolve.resolve('@deepseek-ai/dsh-workspace')).href)
    const domain = await ctx.storageDomain.open(workspaceDomainSpec)
    try { return await run({ domain }) } finally { await domain.close() }
  }
  await recoverLegacyDisk(root, legacy)
  for (const directory of new Set([...[].concat(previous ?? []), base].filter(Boolean))) {
    await recoverMove(ctx, moveStorage(root, directory), { startup: true, withLedger })
  }
  try {
    await withLedger((options) => repairLegacyDuplicates(ctx, options))
  } catch (error) {
    if (error.code !== 'unsupported') ctx.logger?.warn?.('Session move: legacy ledger cleanup deferred: %s', error)
  }
  ctx.provide('sessionMoveRecovery', true)
}
