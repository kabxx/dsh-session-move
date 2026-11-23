import { join } from 'node:path'
import { assertExpectedSource, buildPlan, fail, validId, validSourceWorkspaceId } from './plan.js'
import { LOG_FILENAME } from './paths.js'
import { idleWebWriter, releaseIdleWebWriters } from './lease.js'
import { captureLedger, moveLedger, restoreLedger } from './ledger.js'
import { recoverMove } from './recovery.js'
import { moveStorage } from './transaction.js'
import { assertPreparing, inspectMoveHistory } from './history.js'
import { captureLiveSummaries, refreshSessionSummaries } from './sidebar.js'

const knownErrors = new Set([
  'bad-request', 'busy', 'locked', 'missing', 'target-missing', 'target-not-canonical',
  'same-workspace', 'stale-source', 'collision', 'changed', 'unsupported', 'restore-pending', 'cleanup-pending',
  'archived', 'subagent', 'unsafe-path', 'cross-device', 'restored', 'disk-space', 'family-limit',
  'history-busy', 'history-timeout', 'history-cancelled', 'history-resource', 'history-isolation-unavailable',
  'history-protocol', 'history-ipc-limit', 'history-invalid', 'history-limit',
])

function destinationMembers(plan) {
  return plan.members.map(({ id, oldCwd }) => ({ id, cwd: plan.targetCwd, moved: oldCwd !== plan.targetCwd }))
}

export function createSessionMove(ctx, { root, base, previous, checkpoint, activity = async (id) => {
  return await ctx.waterfall('workspace/session-activity', { sessionId: id }, async () => [])
}, release = releaseIdleWebWriters, storage = moveStorage(root, base, { checkpoint }) }) {
  const previousStorages = (Array.isArray(previous) ? previous : [previous]).filter(Boolean)
    .map((directory) => moveStorage(root, directory))
  let chain = Promise.resolve()

  async function checkIdle(plan, signal) {
    for (const { id } of plan.members) {
      assertPreparing(signal)
      if ((await activity(id)).length) throw fail('busy')
    }
    assertPreparing(signal)
  }

  async function verifyDestination(state) {
    for (const { id, nextDir } of state.members) {
      const snapshot = await ctx.sessionPersistence.stat(id)
      if (snapshot?.header?.id !== id || snapshot.header.cwd !== state.targetCwd
        || snapshot.formatStatus !== 'current' || snapshot.location?.kind !== 'jsonl'
        || snapshot.location.path !== join(nextDir, LOG_FILENAME)) throw fail('changed')
    }
    // The staged digest covers the validated source body, rewritten header,
    // and appended directory event. Require the exact stage before committing.
    await storage.verifyPublished(state, { exact: true })
  }

  async function move(body, requestSignal) {
    for (const previousStorage of previousStorages) await recoverMove(ctx, previousStorage)
    await recoverMove(ctx, storage)
    return storage.withLock(async () => {
      if (await storage.readState()) throw fail('restore-pending')
      if (typeof storage.sweepOrphans === 'function') {
        await storage.sweepOrphans().catch((error) => {
          ctx.logger?.warn?.('Session move: orphan cleanup deferred: %s', error)
        })
      }
      const timeout = AbortSignal.timeout(180_000)
      const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout
      const summaries = new Map()
      assertPreparing(signal)
      const plan = await buildPlan(ctx, { root }, body, { signal })
      await checkIdle(plan, signal)
      assertExpectedSource(ctx.workspaceRegistry.list(), body)
      const writers = plan.members.flatMap(({ id }) => {
        const session = ctx.sessions.get(id)
        if (!session) return []
        const writer = idleWebWriter(ctx, session)
        if (writer.settling) throw fail('busy')
        return [writer]
      })
      assertPreparing(signal)
      const restored = captureLiveSummaries(ctx, writers)
      let preparing = true
      try {
        await release(ctx, writers)
        return await storage.withSessionLocks(plan, async (lockStage) => {
          if (plan.members.some(({ id }) => ctx.sessions.get(id))) throw fail('locked')
          await checkIdle(plan, signal)
          const current = await buildPlan(ctx, { root }, body, { signal })
          if (current.targetCwd !== plan.targetCwd || current.members.length !== plan.members.length
            || current.members.some((member, i) => member.id !== plan.members[i].id
              || member.oldCwd !== plan.members[i].oldCwd || member.oldFile !== plan.members[i].oldFile)) throw fail('changed')
          assertExpectedSource(ctx.workspaceRegistry.list(), body)
          const ledger = captureLedger(ctx, current)
          assertPreparing(signal)
          if (current.members.every(({ oldCwd }) => oldCwd === current.targetCwd)) {
            // Reattaching to the same project only changes its workspace record.
            for (const { id, oldFile, oldCwd } of current.members) {
              summaries.set(id, await inspectMoveHistory({ path: oldFile, id, cwd: oldCwd, checkInbox: true }, { signal }))
            }
            assertPreparing(signal)
            preparing = false
            try {
              await moveLedger(ctx, current, ledger)
            } catch (error) {
              if (error.code === 'unknown-state') throw fail('restore-pending', error)
              throw error
            }
            const synced = await refreshSessionSummaries(ctx, destinationMembers(current), summaries)
            return synced ? { moved: true } : { moved: true, sidebarPending: true }
          }
          const state = await storage.prepare(ctx, current, ledger, lockStage, { signal, summaries })
          try {
            await storage.save(state)
          } catch (error) {
            if (await storage.hasJournal()) throw fail('restore-pending', error)
            if (typeof storage.discardPrepared === 'function') {
              await storage.discardPrepared(state.ticket).catch(() => {})
            }
            throw error
          }
          preparing = false
          let committing = false
          try {
            await checkpoint?.('prepared', state)
            await storage.publish(state)
            await verifyDestination(state)
            await moveLedger(ctx, state, ledger)
            committing = true
            await checkpoint?.('ledger-published', state)
            await storage.save({ ...state, phase: 'committed' })
          } catch (error) {
            if (committing || error.code === 'unknown-state') {
              // The ledger rename may already be durable. Let recovery prove
              // which side is authoritative before touching the transcript.
              throw fail('restore-pending', error)
            }
            try {
              await storage.rollback(state)
              await restoreLedger(ctx, state, ledger)
              await storage.save({ ...state, phase: 'rolled-back' })
              await storage.finish(state)
            } catch (restoreError) { throw fail('restore-pending', restoreError) }
            ctx.logger?.warn?.('Session move rolled back: %s', error)
            throw fail('restored', error)
          }
          let cleanupPending = false
          try {
            await checkpoint?.('committed', state)
            await storage.cleanCommitted(state)
          } catch (error) {
            cleanupPending = true
            ctx.logger?.warn?.('Session move cleanup: %s', error)
          }
          const synced = await refreshSessionSummaries(ctx, destinationMembers(state), summaries)
          return { moved: true, ...(cleanupPending ? { cleanupPending } : {}), ...(!synced ? { sidebarPending: true } : {}) }
        })
      } catch (error) {
        let outcome = error
        if (preparing && signal.aborted && !knownErrors.has(error?.code)) {
          try { assertPreparing(signal) } catch (aborted) { outcome = aborted }
        }
        // Disposing a resident writer also removes its list row. Republish
        // an unchanged or restored source if the move failed after disposal,
        // without starting another full history scan.
        if (outcome.code !== 'restore-pending') {
          const disposed = writers.filter(({ session }) => !ctx.sessions.get(session.id))
          await refreshSessionSummaries(ctx, disposed.map(({ session }) => ({ id: session.id, cwd: session.header.cwd })), summaries, {
            restored,
            allowScan: false,
          })
        }
        throw outcome
      }
    })
  }

  return (request) => {
    const result = chain.then(async () => {
      const headers = { 'Cache-Control': 'no-store' }
      try {
        if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
          throw fail('bad-request')
        }
        let body
        try { body = await request.json() } catch { throw fail('bad-request') }
        if (!validId(body?.sessionId) || !validId(body?.targetWorkspaceId) || !validSourceWorkspaceId(body.sourceWorkspaceId)
          || (body.beforeSessionId !== undefined && !validId(body.beforeSessionId))) throw fail('bad-request')
        return Response.json(await move(body, request.signal), { headers })
      } catch (error) {
        const code = error?.code === 'ENOSPC' ? 'disk-space' : knownErrors.has(error?.code) ? error.code : 'failed'
        if (code === 'failed' || code === 'restore-pending' || code.startsWith('history-')) ctx.logger?.warn?.('Session move: %s', error)
        return Response.json({ error: code }, { headers, status: code === 'bad-request' ? 400 : code === 'failed' ? 500 : 409 })
      }
    })
    chain = result.then(() => {}, () => {})
    return result
  }
}
