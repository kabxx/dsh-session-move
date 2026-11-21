/** Workspace ledger adapter for the stock DSH 0.2.2-rc.5 JSON backend. */

import { isAbsolute, parse } from 'node:path'
import { realpath, stat } from 'node:fs/promises'

const WORKSPACE = 'workspace'
const TABLE = 'workspaces'
const ORIGINAL = Symbol.for('cordis.original')

function ledgerError(code, cause) {
  return Object.assign(new Error(`Workspace ledger (${code})`, { cause }), { code })
}

function access(ctx, { domain: offline } = {}) {
  const domain = offline ?? ctx.get('storageDomain')?.get(WORKSPACE)
  const registry = offline ? undefined : ctx.workspaceRegistry
  const native = registry?.[ORIGINAL] ?? registry
  const table = domain?.table(TABLE)
  const unit = domain?.unit
  const records = unit?.state?.tables?.get(TABLE)
  // Neither KvTable nor KvUnit exposes multi-record puts. The standard backend
  // already atomically publishes this entire unit. Use its write slot and
  // publish function so Host writes compose with the same authoritative state.
  if (domain?.name !== WORKSPACE || typeof domain.enqueue !== 'function'
    || typeof domain.emitChanged !== 'function' || unit?.descriptor?.name !== WORKSPACE
    || unit.descriptor.version !== 2 || unit.descriptor.layout === 'per-record'
    || typeof unit.publish !== 'function' || !(records instanceof Map)
    || !(table?.records instanceof Map) || (!offline && !native)
    || (native && (native.table !== table || typeof native.enqueueOperation !== 'function'
      || !(native.entities instanceof Map) || !(native.headers instanceof Map)
      || !(native.sessionPaths instanceof Map) || !(native.missingSessionPaths instanceof Set)
      || !(native.invalidSessionPaths instanceof Map)))) {
    throw ledgerError('unsupported')
  }
  return { domain, native, table, unit, records }
}

function scope(plan) {
  if (!Array.isArray(plan?.members) || plan.members.length === 0
    || typeof plan.targetWorkspaceId !== 'string' || typeof plan.targetCwd !== 'string') {
    throw ledgerError('changed')
  }
  const ids = plan.members.map((member) => member?.id)
  if (ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
    throw ledgerError('changed')
  }
  return new Set(ids)
}

/** Capture raw membership before publishing a prepared migration journal. */
export function captureLedger(ctx, plan) {
  const ids = scope(plan)
  const { table } = access(ctx)
  if (table.get(plan.targetWorkspaceId)?.path !== plan.targetCwd) throw ledgerError('target-missing')
  return [...table.entries()]
    .filter(([id, record]) => id === plan.targetWorkspaceId || record.sessionIds.some((candidate) => ids.has(candidate)))
    .map(([id, { path, sessionIds }]) => ({ id, path, sessionIds: [...sessionIds] }))
}

function savedRecords(snapshot, plan) {
  const records = new Map()
  if (!Array.isArray(snapshot)) throw ledgerError('changed')
  for (const record of snapshot) {
    if (typeof record?.id !== 'string' || typeof record.path !== 'string' || records.has(record.id)
      || !Array.isArray(record.sessionIds) || record.sessionIds.some((id) => typeof id !== 'string')) {
      throw ledgerError('changed')
    }
    records.set(record.id, record)
  }
  if (records.get(plan.targetWorkspaceId)?.path !== plan.targetCwd) throw ledgerError('changed')
  return records
}

function sameSequence(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameOwners(current, saved, ids) {
  // Compare only moved IDs, independent of edits to the rest of either list.
  const owners = (records) => [...records].flatMap(([workspace, { sessionIds }]) =>
    sessionIds.filter((id) => ids.has(id)).map((id) => JSON.stringify([workspace, id]))).sort()
  return sameSequence(owners(current), owners(saved))
}

async function prepareIndexEntry(header) {
  const { cwd } = header
  if (typeof cwd !== 'string') return { header, invalid: 'header has no cwd' }
  const root = parse(cwd).root
  if (!isAbsolute(cwd) || (process.platform === 'win32' && (root === '\\' || root === '/'))) {
    return { header, invalid: `cwd '${cwd}' is not fully qualified` }
  }
  try {
    const path = await realpath(cwd)
    if ((await stat(path)).isDirectory()) return { header, path }
    return { header, invalid: `cwd '${cwd}' is not a directory` }
  } catch (error) {
    return { header, missing: error.code === 'ENOENT', invalid: `cwd '${cwd}' does not resolve` }
  }
}

async function prepareIndexes(ctx, plan, direction) {
  return Promise.all(plan.members.map(async (member) => {
    const header = (await ctx.sessionPersistence.stat(member.id))?.header
    const cwd = direction === 'forward' ? plan.targetCwd : member.oldCwd
    if (header?.id !== member.id || header.cwd !== cwd) throw ledgerError('changed')
    const entry = await prepareIndexEntry(header)
    if (direction === 'forward' && entry.path !== plan.targetCwd) throw ledgerError('target-missing')
    return entry
  }))
}

function publishIndexes(registry, indexes) {
  if (!registry) return
  for (const { header, path, missing, invalid } of indexes) {
    const { id } = header
    registry.headers.set(id, header)
    if (path === undefined) registry.sessionPaths.delete(id)
    else registry.sessionPaths.set(id, path)
    if (missing) registry.missingSessionPaths.add(id)
    else registry.missingSessionPaths.delete(id)
    if (invalid === undefined) registry.invalidSessionPaths.delete(id)
    else registry.invalidSessionPaths.set(id, invalid)
  }
}

function inLedgerQueue({ domain, native }, run) {
  const execute = () => domain.enqueue(run)
  return native ? native.enqueueOperation(execute) : execute()
}

/** Run one batch in the registry and domain queues, then publish feed updates. */
function transact(adapter, update, indexes = []) {
  const { domain, native, table, unit, records } = adapter
  return inLedgerQueue(adapter, async () => {
    const changes = update(new Map(table.entries()))
    const previous = new Map()
    const entities = new Map()
    for (const [id] of changes) {
      if (!records.has(id)) throw ledgerError('changed')
      previous.set(id, records.get(id))
      if (native) {
        const entity = native.entities.get(id)
        if (!entity || entity.record?.path !== table.get(id)?.path) throw ledgerError('changed')
        entities.set(id, entity)
      }
    }
    if (changes.size) {
      for (const [id, record] of changes) records.set(id, record)
      try {
        await unit.publish()
      } catch (cause) {
        for (const [id, record] of previous) records.set(id, record)
        // The backend's error may follow rename (e.g. directory fsync failed).
        // Re-publish the old state before native writes can use it again.
        try {
          await unit.publish()
        } catch (undo) {
          const failure = ledgerError('unknown-state', new AggregateError([cause, undo]))
          domain.failure = failure
          throw failure
        }
        throw cause
      }
      for (const [id, record] of changes) {
        table.records.set(id, record)
        const entity = entities.get(id)
        if (entity) entity.record = record
      }
    }
    // Make all three memory mirrors coherent before any follow observer runs.
    publishIndexes(native, indexes)
    for (const [key, value] of changes) {
      domain.emitChanged({ domain: WORKSPACE, table: TABLE, operation: 'put', key, value })
    }
  })
}

/** Keep ownership evidence stable until the caller saves the commit marker. */
export async function withPublishedLedger(ctx, plan, snapshot, confirm, options) {
  const ids = scope(plan)
  const saved = savedRecords(snapshot, plan)
  const targetOwners = new Map([[plan.targetWorkspaceId, { sessionIds: [...ids] }]])
  if (sameOwners(saved, targetOwners, ids)) return false
  const adapter = access(ctx, options)
  return inLedgerQueue(adapter, async () => {
    const current = new Map(adapter.table.entries())
    if (current.get(plan.targetWorkspaceId)?.path !== plan.targetCwd || !sameOwners(current, targetOwners, ids)) {
      return false
    }
    await confirm()
    return true
  })
}

function saveChanged(changes, id, record, sessionIds) {
  if (!sameSequence(record.sessionIds, sessionIds)) {
    changes.set(id, { ...record, sessionIds, updatedAt: new Date().toISOString() })
  }
}

/** Publish the source removals and target insertion in one atomic ledger write. */
export async function moveLedger(ctx, plan, snapshot, options) {
  const ids = scope(plan)
  const saved = savedRecords(snapshot, plan)
  const adapter = access(ctx, options)
  const indexes = await prepareIndexes(ctx, plan, 'forward')
  await transact(adapter, (current) => {
    const target = current.get(plan.targetWorkspaceId)
    if (target?.path !== plan.targetCwd) throw ledgerError('target-missing')
    const changes = new Map()
    const exactTarget = new Map([[plan.targetWorkspaceId, { sessionIds: [...ids] }]])
    if (sameOwners(current, exactTarget, ids)) return changes // committed recovery
    if (!sameOwners(current, saved, ids)) throw ledgerError('changed')
    for (const [id, original] of saved) {
      const record = current.get(id)
      if (record?.path !== original.path) throw ledgerError('changed')
      const next = record.sessionIds.filter((candidate) => !ids.has(candidate))
      if (id === plan.targetWorkspaceId) {
        const anchor = next.indexOf(plan.beforeSessionId)
        next.splice(anchor < 0 ? 0 : anchor, 0, ...ids)
      }
      saveChanged(changes, id, record, next)
    }
    return changes
  }, indexes)
}

function restorePositions(current, original, ids) {
  const next = current.filter((id) => !ids.has(id))
  for (const [index, id] of original.entries()) {
    if (!ids.has(id)) continue
    const right = original.slice(index + 1).find((anchor) => !ids.has(anchor) && next.includes(anchor))
    const left = original.slice(0, index).findLast((anchor) => next.includes(anchor))
    const at = right !== undefined ? next.indexOf(right)
      : left !== undefined ? next.indexOf(left) + 1 : Math.min(index, next.length)
    next.splice(at, 0, id)
  }
  return next
}

/** Restore original ownership and member order against the current unrelated IDs. */
export async function restoreLedger(ctx, plan, snapshot, options) {
  const ids = scope(plan)
  const saved = savedRecords(snapshot, plan)
  const adapter = access(ctx, options)
  const indexes = await prepareIndexes(ctx, plan, 'rollback')
  await transact(adapter, (current) => {
    const changes = new Map()
    for (const [id, original] of saved) {
      const record = current.get(id)
      // A folder removed (or replaced) during the transfer is a user edit.
      // Roll back only records that still represent the original workspace.
      if (record?.path !== original.path) continue
      const moved = (sessionId) => ids.has(sessionId)
      if (sameSequence(record.sessionIds.filter(moved), original.sessionIds.filter(moved))) continue
      saveChanged(changes, id, record, restorePositions(record.sessionIds, original.sessionIds, ids))
    }
    return changes
  }, indexes)
}

/** Fix only legacy duplicates for which one stored header identifies one owner. */
export async function repairLegacyDuplicates(ctx, options) {
  const domain = options?.domain ?? ctx.get('storageDomain')?.get(WORKSPACE)
  const table = domain?.table(TABLE)
  if (!table) throw ledgerError('unsupported')
  const candidates = new Map()
  for (const [workspace, { path, sessionIds }] of table.entries()) {
    for (const id of new Set(sessionIds)) {
      const owners = candidates.get(id) ?? []
      owners.push({ workspace, path })
      candidates.set(id, owners)
    }
  }
  const fixes = new Map()
  for (const [id, owners] of candidates) {
    if (owners.length < 2) continue
    const header = (await ctx.sessionPersistence.stat(id))?.header
    if (header?.id !== id) continue
    const entry = await prepareIndexEntry(header)
    const matches = owners.filter(({ path }) => path === entry.path)
    if (matches.length === 1) fixes.set(id, { owners, keep: matches[0].workspace })
  }
  let repaired = 0
  if (fixes.size === 0) return repaired
  await transact(access(ctx, options), (current) => {
    const changes = new Map()
    for (const [id, { owners, keep }] of fixes) {
      if (owners.some(({ workspace, path }) => {
        const record = current.get(workspace)
        return record?.path !== path || !record.sessionIds.includes(id)
      })) continue
      for (const { workspace } of owners) {
        if (workspace === keep) continue
        const record = changes.get(workspace) ?? current.get(workspace)
        saveChanged(changes, workspace, record, record.sessionIds.filter((candidate) => candidate !== id))
        repaired++
      }
    }
    return changes
  })
  return repaired
}

/** Reconcile the search index if the deployment has opened it. */
export async function refreshSearchIndex(ctx) {
  try {
    const query = ctx.get('sessionQuery')
    if (query?.config?.openAt === 'never' || typeof query?.searchSessions !== 'function') return
    const { openAt, path } = query.config ?? {}
    if (openAt === 'first-search' && typeof path === 'string' && path !== ':memory:') {
      try {
        await stat(path)
      } catch (error) {
        if (error.code === 'ENOENT') return
        throw error
      }
    }
    await query.searchSessions({ query: 'session', limit: 1 })
  } catch (error) {
    ctx.logger?.warn?.('Session move: search reconciliation failed: %s', error)
  }
}
