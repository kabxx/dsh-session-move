import { fail } from './plan.js'

export async function readMoveEvents(ctx, { id, oldCwd }) {
  let file
  try {
    file = await ctx.sessionPersistence.open(id, 'read')
    if (file.header.id !== id || file.header.cwd !== oldCwd) throw fail('changed')
    const { events } = await file.read()
    assertNoPendingInbox(ctx, file.header, events, file.inheritedEventCount)
    return events
  } catch (error) {
    if (error.code === 'busy' || error.code === 'changed') throw error
    throw fail('unsupported', error)
  } finally {
    await file?.close()
  }
}

/** Check the full durable inbox at the caller's quiescent, write-locked cut. */
export function assertNoPendingInbox(ctx, header, events, inheritedEventCount) {
  let inbox
  try {
    if (!Array.isArray(events) || !Number.isSafeInteger(inheritedEventCount)
      || inheritedEventCount < 0 || inheritedEventCount > events.length) {
      throw new Error('Invalid session replay cut')
    }
    // An empty checkpoint forces DSH to replay from the origin instead of
    // taking a potentially stale cached inbox or opening a live agent.
    const restored = ctx.sessionProjections.restore({}, events, 0, header, inheritedEventCount)
    inbox = restored.snapshot.values.inbox
    if (!Array.isArray(inbox?.['next-turn']) || !Array.isArray(inbox['next-step'])) {
      throw new Error('DSH did not restore the standard inbox projection')
    }
  } catch (error) {
    throw fail('unsupported', error)
  }

  if (inbox['next-turn'].length || inbox['next-step'].length) throw fail('busy')
}
