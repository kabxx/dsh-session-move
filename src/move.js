import { assertExpectedSource, buildPlan, fail, validId, validSourceWorkspaceId } from './plan.js'
import { idleWebWriter, releaseIdleWebWriters } from './lease.js'
import { captureLedger, moveLedger, restoreLedger, refreshSearchIndex } from './ledger.js'
import { recoverMove } from './recovery.js'
import { moveStorage } from './transaction.js'
import { readMoveEvents } from './inbox.js'
import { refreshSessionSummaries } from './sidebar.js'

const knownErrors = new Set([
  'bad-request', 'busy', 'locked', 'missing', 'target-missing', 'target-not-canonical',
  'same-workspace', 'stale-source', 'collision', 'changed', 'unsupported', 'restore-pending', 'cleanup-pending',
  'archived', 'subagent', 'unsafe-path', 'cross-device', 'restored',
])

function destinationMembers(plan) {
  return plan.members.map(({ id }) => ({ id, cwd: plan.targetCwd }))
}

export function createSessionMove(ctx, { root, base, previous, checkpoint, activity = async (id) => {
  return await ctx.waterfall('workspace/session-activity', { sessionId: id }, async () => [])
}, release = releaseIdleWebWriters, storage = moveStorage(root, base, { checkpoint }) }) {
  const previousStorages = (Array.isArray(previous) ? previous : [previous]).filter(Boolean)
    .map((directory) => moveStorage(root, directory))
  let chain = Promise.resolve()

  async function checkIdle(plan) {
    for (const { id } of plan.members) if ((await activity(id)).length) throw fail('busy')
  }

  async function verifyDestination(state) {
    const verified = new Map()
    for (const member of state.members) {
      const handle = await ctx.sessionPersistence.open(member.id, 'read')
      try {
        if (handle.header.id !== member.id || handle.header.cwd !== state.targetCwd) throw fail('changed')
        if (member.oldCwd === state.targetCwd) continue
        const cut = { header: handle.header, inheritedEventCount: handle.inheritedEventCount, ...await handle.read() }
        const directory = cut.events.at(-1)
        if (directory?.type !== 'working-directory/change' || directory.seq !== member.cwdChangeSeq
          || directory.data?.cwd !== state.targetCwd) throw fail('changed')
        verified.set(member.id, cut)
      } finally { await handle.close() }
    }
    return verified
  }

  async function move(body, signal) {
    for (const previousStorage of previousStorages) await recoverMove(ctx, previousStorage)
    await recoverMove(ctx, storage)
    return storage.withLock(async () => {
      if (await storage.readState()) throw fail('restore-pending')
      const plan = await buildPlan(ctx, { root }, body)
      await checkIdle(plan)
      assertExpectedSource(ctx.workspaceRegistry.list(), body)
      const writers = plan.members.flatMap(({ id }) => {
        const session = ctx.sessions.get(id)
        if (!session) return []
        const writer = idleWebWriter(ctx, session)
        if (writer.settling) throw fail('busy')
        return [writer]
      })
      signal?.throwIfAborted()
      try {
        await release(ctx, writers)
        return await storage.withSessionLocks(plan, async (lockStage) => {
          if (plan.members.some(({ id }) => ctx.sessions.get(id))) throw fail('locked')
          await checkIdle(plan)
          const current = await buildPlan(ctx, { root }, body)
          if (current.targetCwd !== plan.targetCwd || current.members.length !== plan.members.length
            || current.members.some((member, i) => member.id !== plan.members[i].id
              || member.oldCwd !== plan.members[i].oldCwd || member.oldFile !== plan.members[i].oldFile)) throw fail('changed')
          assertExpectedSource(ctx.workspaceRegistry.list(), body)
          const ledger = captureLedger(ctx, current)
          signal?.throwIfAborted()
          if (current.members.every(({ oldCwd }) => oldCwd === current.targetCwd)) {
            // Reattaching to the same project only changes its workspace record.
            for (const member of current.members) await readMoveEvents(ctx, member)
            signal?.throwIfAborted()
            try {
              await moveLedger(ctx, current, ledger)
            } catch (error) {
              if (error.code === 'unknown-state') throw fail('restore-pending', error)
              throw error
            }
            const synced = await refreshSessionSummaries(ctx, destinationMembers(current))
            return synced ? { moved: true } : { moved: true, sidebarPending: true }
          }
          const state = await storage.prepare(ctx, current, ledger, lockStage)
          await storage.save(state)
          let committing = false
          let verified
          try {
            await checkpoint?.('prepared', state)
            await storage.publish(state)
            verified = await verifyDestination(state)
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
          const synced = await refreshSessionSummaries(ctx, destinationMembers(state), verified)
          await refreshSearchIndex(ctx)
          return { moved: true, ...(cleanupPending ? { cleanupPending } : {}), ...(!synced ? { sidebarPending: true } : {}) }
        })
      } catch (error) {
        // Disposing a resident writer also removes its list row. Republish
        // an unchanged or restored source if the move failed after disposal.
        if (error.code !== 'restore-pending') {
          const disposed = writers.filter(({ session }) => !ctx.sessions.get(session.id))
          await refreshSessionSummaries(ctx, disposed.map(({ session }) => ({ id: session.id, cwd: session.header.cwd })))
        }
        throw error
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
        const code = knownErrors.has(error?.code) ? error.code : 'failed'
        if (code === 'failed' || code === 'restore-pending') ctx.logger?.warn?.('Session move: %s', error)
        return Response.json({ error: code }, { headers, status: code === 'bad-request' ? 400 : code === 'failed' ? 500 : 409 })
      }
    })
    chain = result.then(() => {}, () => {})
    return result
  }
}
