/**
 * Resolve a move request into an executable plan, or refuse it before anything
 * changes.
 *
 * The plan is the whole point of this module: every check that can reject the
 * move runs here, so the caller never starts a relocation it cannot finish.
 * Mirrors the "refused before anything moved" contract of OMP's
 * `SessionManager.moveTo`.
 *
 * @module dsh-session-move/plan
 */

import { lstat, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { LOG_FILENAME, sessionDir } from './paths.js'

export function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\u0000-\u001f]/u.test(id)
}

export function validSourceWorkspaceId(id) {
  return id === null || validId(id)
}

/** Refuse a move with a code the client maps to a message. */
export function fail(code, cause) {
  return Object.assign(new Error(`Session move (${code})`), { code, cause })
}

function checkPreparing(signal) {
  if (signal?.aborted) {
    throw fail(signal.reason?.name === 'TimeoutError' ? 'history-timeout' : 'history-cancelled', signal.reason)
  }
}

/**
 * Expand a session into itself plus every subagent session created from it.
 * Children move with their parent so the delegation tree never spans two
 * workspaces.
 * @param root - the session to expand.
 * @param stored - stored snapshots from `sessionPersistence.list()`.
 * @param live - live sessions from `ctx.sessions.list()`.
 * @returns the member ids, parents before children.
 */
export function moveScope(root, stored, live) {
  const headers = new Map(stored.map(({ header }) => [header.id, header]))
  for (const session of live) headers.set(session.id, session.header)
  if (!headers.has(root)) throw fail('missing')
  if (headers.get(root).origin === 'subagent') throw fail('subagent')
  const children = new Map()
  for (const header of headers.values()) {
    if (header.origin !== 'subagent' || !header.parentSession) continue
    const siblings = children.get(header.parentSession) ?? []
    siblings.push(header.id)
    children.set(header.parentSession, siblings)
  }
  const ordered = []
  const seen = new Set()
  const visit = (id) => {
    if (seen.has(id)) return
    seen.add(id)
    if (ordered.length === 128) throw fail('family-limit')
    ordered.push(id)
    for (const child of children.get(id) ?? []) visit(child)
  }
  visit(root)
  return ordered
}

/** Compare the request with the same projected membership used by the sidebar. */
export function assertExpectedSource(workspaces, request) {
  if (!validSourceWorkspaceId(request.sourceWorkspaceId)) throw fail('bad-request')
  // The header's cwd can match a workspace even if its list no longer contains
  // the session. Ambiguous membership is not safe to interpret as one source.
  const sources = workspaces.filter((workspace) => workspace.sessionIds.includes(request.sessionId))
  const actual = sources[0]?.id ?? null
  if (sources.length > 1 || actual !== request.sourceWorkspaceId) throw fail('stale-source')
  return actual
}

/**
 * Build the plan for one move.
 * @param ctx - the plugin context.
 * @param options - `root` is the session storage root.
 * @param request - `sessionId`, `sourceWorkspaceId` (null for ungrouped),
 * `targetWorkspaceId`, optional `beforeSessionId`.
 * @returns the plan, ready to execute.
 */
export async function buildPlan(ctx, { root }, request, { signal } = {}) {
  checkPreparing(signal)
  const registry = ctx.workspaceRegistry
  const workspaces = registry.list()
  const sourceWorkspaceId = assertExpectedSource(workspaces, request)

  const target = workspaces.find((workspace) => workspace.id === request.targetWorkspaceId)
  if (target === undefined) throw fail('target-missing')
  if (sourceWorkspaceId === target.id) throw fail('same-workspace')

  const targetPath = target.path
  if (typeof targetPath !== 'string' || targetPath.length === 0) throw fail('target-missing')
  let targetIsDirectory = false
  try {
    targetIsDirectory = (await stat(targetPath)).isDirectory()
  } catch {
    targetIsDirectory = false
  }
  checkPreparing(signal)
  if (!targetIsDirectory) throw fail('target-missing')

  // The attach validation compares the header's realpath against the stored
  // record path verbatim, so the plan carries that exact string and never a
  // path this plugin composed itself.
  const targetCwd = targetPath

  let stored
  try {
    stored = await ctx.sessionPersistence.list(signal ? { signal } : undefined)
  } catch (error) {
    checkPreparing(signal)
    throw error
  }
  checkPreparing(signal)
  const members = moveScope(request.sessionId, stored, ctx.sessions.list())
  if (registry.archivedSessionIds?.includes(request.sessionId)) throw fail('archived')
  const snapshots = new Map(stored.map((snapshot) => [snapshot.header.id, snapshot]))

  const planned = []
  for (const id of members) {
    checkPreparing(signal)
    const snapshot = snapshots.get(id)
    if (snapshot === undefined) throw fail('missing')
    const oldCwd = snapshot.header.cwd
    if (typeof oldCwd !== 'string' || oldCwd.length === 0) throw fail('unsupported')
    const oldFile = snapshot.location?.path
    const oldDir = sessionDir(root, oldCwd, id)
    if (snapshot.location?.kind !== 'jsonl' || snapshot.formatStatus !== 'current'
      || oldFile !== join(oldDir, LOG_FILENAME)) throw fail('unsupported')

    const nextDir = sessionDir(root, targetCwd, id)
    const nextFile = join(nextDir, LOG_FILENAME)
    planned.push({ id, header: snapshot.header, oldCwd, oldDir, oldFile, nextDir, nextFile })
  }

  // A destination that already holds this session's directory means the move
  // would merge two transcripts. Refuse rather than guess which one wins.
  for (const member of planned) {
    checkPreparing(signal)
    if (member.oldDir === member.nextDir) continue
    try {
      await lstat(member.nextDir)
      throw fail('collision')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  // `attachSession` re-reads the header and canonicalizes it; a target whose
  // realpath differs from its record path could never be attached, so refuse
  // now instead of after the files moved.
  checkPreparing(signal)
  let canonicalTarget
  try {
    canonicalTarget = await realpath(targetPath)
  } catch {
    throw fail('target-missing')
  }
  checkPreparing(signal)
  if (canonicalTarget !== targetPath) {
    // Canonicalizing would change the string attach compares against, so the
    // only safe outcome is refusing while nothing has moved.
    throw fail('target-not-canonical')
  }

  return {
    sessionId: request.sessionId,
    sourceWorkspaceId,
    targetWorkspaceId: target.id,
    targetCwd,
    beforeSessionId: request.beforeSessionId,
    members: planned,
    targetProjectDir: dirname(planned[0].nextDir),
  }
}
