import { inspectMoveHistory } from './history.js'

const original = Symbol.for('cordis.original')

function rowsFor({ lastSeq, summary }, cwd, moved) {
  const row = (val) => ({ ver: 1, seq: lastSeq + Number(moved), val })
  return {
    title: row(summary.title),
    workingDirectory: row(moved ? cwd : summary.workingDirectory),
    agentPreset: row(summary.agentPreset ?? null),
    sessionListMetadata: row(summary.sessionListMetadata),
  }
}

/** Snapshot live resident summaries before teardown so failed moves restore them without rescanning. */
export function captureLiveSummaries(ctx, writers) {
  const captured = new Map()
  const service = ctx.get('sessionController')
  const list = (service?.[original] ?? service)?.listState
  if (typeof list?.summaryFor !== 'function') return captured
  for (const { session } of writers) {
    try {
      const summary = list.summaryFor(session)
      captured.set(session.id, {
        ...summary,
        agentAvailable: false,
        running: false,
        ...(summary.projections === undefined ? {} : {
          projections: { kind: 'cached', asOfSeq: summary.projections.asOfSeq, values: summary.projections.values },
        }),
      })
    } catch (error) {
      ctx.logger?.warn?.('Session move: could not capture live summary for "%s": %s', session.id, error)
    }
  }
  return captured
}

/** Update cold list rows from the write-locked cut without constructing a full Session. */
export async function refreshSessionSummaries(ctx, members, cuts, { restored, signal, allowScan = true } = {}) {
  const service = ctx.get('sessionController')
  if (!service) return true
  // These methods are internal to the pinned DSH version. Partial checkpoint
  // rows are valid: other projections still fold from the authoritative log.
  const list = (service[original] ?? service).listState
  const injectedCache = ctx.get('sessionProjectionCache')
  const cache = injectedCache?.[original] ?? injectedCache
  let synced = true

  for (const { id, cwd, moved = false } of members) {
    try {
      const live = ctx.sessions.get(id)
      if (live !== undefined) {
        if (live.header.cwd !== cwd) throw new Error('Session header changed')
        ctx.emit('api-session/added', list.summaryFor(live))
        continue
      }
      const snapshot = await ctx.sessionPersistence.stat(id)
      const header = snapshot?.header
      if (header?.id !== id || header.cwd !== cwd || snapshot.formatStatus !== 'current'
        || snapshot.location?.kind !== 'jsonl') throw new Error('Session header changed')
      const hasCut = Boolean(cuts?.has(id))
      if (!hasCut && !moved && restored?.has(id)) {
        const appearing = ctx.sessions.get(id)
        if (appearing !== undefined) {
          if (appearing.header.cwd !== cwd) throw new Error('Session header changed')
          ctx.emit('api-session/added', list.summaryFor(appearing))
          continue
        }
        ctx.emit('api-session/added', restored.get(id))
        continue
      }
      if (!hasCut && !allowScan) {
        if (typeof list?.summarizeCold !== 'function') throw new Error('Unsupported session summary interface')
        const appearing = ctx.sessions.get(id)
        if (appearing !== undefined) {
          if (appearing.header.cwd !== cwd) throw new Error('Session header changed')
          ctx.emit('api-session/added', list.summaryFor(appearing))
          continue
        }
        ctx.emit('api-session/added', list.summarizeCold(snapshot))
        continue
      }
      const cut = hasCut ? cuts.get(id) : await inspectMoveHistory({ path: snapshot.location.path, id, cwd }, signal ? { signal } : undefined)
      const rows = rowsFor(cut, cwd, moved && hasCut)
      const keys = ctx.sessionProjections.summaryKeys()
      const values = ctx.sessionProjections.viewCheckpoint(rows, keys)
      const appearing = ctx.sessions.get(id)
      if (appearing !== undefined) {
        if (appearing.header.cwd !== cwd) throw new Error('Session header changed')
        ctx.emit('api-session/added', list.summaryFor(appearing))
        continue
      }
      if (cache && typeof cache.put === 'function') {
        try {
          await cache.put(id, { formatVersion: header.version, createdAt: header.createdAt, cwd,
            isSeeded: header.isSeeded, inheritedEventCount: cut.inheritedEventCount }, rows)
        } catch (error) {
          ctx.logger?.warn?.('Session move: could not checkpoint "%s": %s', id, error)
        }
      }
      if (typeof list?.summarizeCold !== 'function') throw new Error('Unsupported session summary interface')
      const summary = list.summarizeCold(snapshot)
      // The stock per-record backend may refuse some child IDs. Their live
      // list event can still carry the same valid projection hints.
      ctx.emit('api-session/added', {
        ...summary,
        updatedAt: Math.max(header.createdAt, cut.summary.sessionListMetadata.lastPromptAt ?? 0),
        blank: cut.summary.sessionListMetadata.blank,
        ...(Object.keys(values).length === 0 ? {} : {
          projections: { kind: 'cached', asOfSeq: rows.title.seq, values },
        }),
      })
    } catch (error) {
      synced = false
      ctx.logger?.warn?.('Session move: could not publish summary for "%s": %s', id, error)
    }
  }
  return synced
}
