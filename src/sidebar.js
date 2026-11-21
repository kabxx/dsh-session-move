const original = Symbol.for('cordis.original')

/** Publish ordinary DSH list rows without starting an Agent or attaching a Session. */
export async function refreshSessionSummaries(ctx, members, verified = new Map()) {
  const service = ctx.get('sessionController')
  if (!service) return true
  // The pinned DSH controller has no public single-row summary operation.
  const list = (service[original] ?? service).listState
  if (typeof list?.summaryFor !== 'function') return false
  const cache = ctx.get('sessionProjectionCache')
  let synced = true

  for (const { id, cwd } of members) {
    try {
      let session = ctx.sessions.get(id)
      if (session === undefined) {
        let cut = verified.get(id)
        if (!cut) {
          const handle = await ctx.sessionPersistence.open(id, 'read')
          try {
            cut = { header: handle.header, inheritedEventCount: handle.inheritedEventCount, ...await handle.read() }
          } finally { await handle.close() }
        }
        session = ctx.sessions.get(id) ?? ctx.sessions.prepare(id, {
          meta: cut.header, inheritedEventCount: cut.inheritedEventCount,
          seed: cut.events, eventState: cut.eventState,
        })
      }
      if (session.id !== id || session.header.cwd !== cwd) throw new Error('Session header changed')
      if (cache && ctx.sessions.get(id) === undefined) {
        // Bind the checkpoint to the new header for freshly connected lists.
        try { await cache.write(session) } catch (error) {
          ctx.logger?.warn?.('Session move: could not checkpoint "%s": %s', id, error)
        }
      }
      const current = ctx.sessions.get(id) ?? session
      if (current.header.cwd !== cwd) throw new Error('Session header changed')
      ctx.emit('api-session/added', list.summaryFor(current))
    } catch (error) {
      synced = false
      ctx.logger?.warn?.('Session move: could not publish summary for "%s": %s', id, error)
    }
  }
  return synced
}
