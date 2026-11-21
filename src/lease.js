/**
 * Release the Web session controller's long-lived write handle.
 *
 * `dsh-agent-loop` opens the session log for write and keeps the handle on the
 * Session Controller fiber for as long as the session stays resident in the
 * GUI. Moving the log directory while that handle is open would leave the old
 * file descriptor writing into a moved-away path, so a resident session must
 * be torn down first.
 *
 * The teardown is reached through the `cordis.effect` symbols rather than a
 * public API, because DSH exposes no "close this session" entry point. The
 * exact-effect identity check below is what makes this safe: if the pinned
 * release ever changes its fiber layout, this refuses instead of disposing the
 * wrong thing.
 *
 * Adapted from the author's `dsh-session-delete` plugin, which proved this
 * path against the same DSH release.
 *
 * @module dsh-session-move/lease
 */

const effect = Symbol.for('cordis.effect')
const original = Symbol.for('cordis.original')

function refuse(code) {
  throw Object.assign(new Error(`Session writer (${code})`), { code })
}

function uniqueEffect(fiber, label) {
  const effects = fiber?._disposables
  if (!effects?.[Symbol.iterator]) return undefined
  const matches = [...effects].filter((entry) => typeof entry === 'function' && entry[effect]?.label === label)
  if (matches.length === 1) return matches[0]
}

function assertNoWork(agent) {
  if (agent.status === 'running' || agent.phase?.kind === 'maintenance' || agent.inbox?.hasPending === true) refuse('busy')
  if (agent.status !== 'idle' || agent.phase?.kind !== 'idle' || agent.inbox?.hasPending !== false) refuse('locked')
}

/**
 * Describe the teardown needed to release one resident session's writer.
 * @param ctx - the plugin context.
 * @param session - the live session to release.
 * @returns the teardown handle; `dispose` is absent when nothing is resident.
 */
export function idleWebWriter(ctx, session) {
  const agent = ctx.get('agents')?.get(session.id)
  if (agent?.session !== session) refuse('locked')
  const subagents = ctx.get('subagents')
  const manager = (subagents?.[original] ?? subagents)?.manager
  const activation = manager?.resident?.get(session.id)
  if (session.header.origin === 'subagent' && activation?.kind === 'local' && activation.handle?.agent === agent) {
    // The subagent manager owns settlement here and may notify the parent on
    // close; wait for that native transition instead of tearing it down.
    if (!activation.accepted || agent.inbox?.hasPending !== false || agent.status !== 'idle') refuse('busy')
    if (activation.closing === undefined && agent.phase?.kind !== 'idle') refuse('busy')
    return { session, agent, settling: true }
  }
  assertNoWork(agent)
  if (agent.lifetimeSignal?.aborted !== false || session.header.origin === 'subagent') refuse('locked')

  const service = ctx.get('sessionController')
  const controller = service?.[original] ?? service
  const owner = controller?.agents?.ctx?.fiber
  const scope = agent.scope?.rawDispose?.[effect]
  const scopeEffect = uniqueEffect(agent.loopCtx?.fiber, `agentLoop.scope(${session.id})`)
  const dispose = uniqueEffect(owner, `agentLoop.lifecycle(${session.id})`)
  if (!owner || owner !== controller.ctx?.fiber || !scope
    || !scopeEffect?.[effect].children.includes(scope) || !dispose) refuse('locked')
  return { session, agent, dispose }
}

/**
 * Run every teardown after re-checking that each one is still the current one.
 * @param ctx - the plugin context.
 * @param writers - handles from {@link idleWebWriter}.
 */
export async function releaseIdleWebWriters(ctx, writers) {
  for (const writer of writers) {
    const current = idleWebWriter(ctx, writer.session)
    if (ctx.sessions.get(writer.session.id) !== writer.session
      || current.agent !== writer.agent || current.dispose !== writer.dispose) refuse('changed')
  }
  // Check the entire family before starting any native teardown. Every
  // teardown must settle successfully before the caller takes a backup.
  const outcome = await Promise.allSettled(writers.map(async ({ dispose }) => { await dispose() }))
  for (const result of outcome) {
    if (result.status === 'rejected') throw result.reason
  }
}
