import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { fail, moveScope } from '../src/plan.js'

// Independent native replay oracle for the streaming worker regressions.
function assertNoPendingInbox(ctx, header, events, inheritedEventCount) {
  let values
  try {
    if (!Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0 || inheritedEventCount > events.length) throw new Error('Invalid cut')
    values = ctx.sessionProjections.restore({}, events, 0, header, inheritedEventCount).snapshot.values.inbox
    if (!Array.isArray(values?.['next-turn']) || !Array.isArray(values['next-step'])) throw new Error('Invalid inbox')
  } catch (error) { throw fail('unsupported', error) }
  if (values['next-turn'].length || values['next-step'].length) throw fail('busy')
}

const header = { version: 4, id: 'session-inbox-test', createdAt: 1, isSeeded: false }
const emptyInbox = () => ({ 'next-turn': [], 'next-step': [] })
const restoreResult = (inbox) => ({ snapshot: { values: { inbox } } })
const message = { id: 'session-inbox-message', role: 'user', content: [{ type: 'text', text: 'Run the tests' }] }
const splice = (seq, target, inserted, options = {}) => Object.freeze({
  type: 'agent/inbox/spliced', seq, time: seq + 1,
  data: Object.freeze({ target, start: 0, inserted: Object.freeze(inserted), ...options }),
})

test('admission uses the full event slice and the exact inherited prefix without a checkpoint', () => {
  const events = [splice(0, 'next-turn', [])]
  const ctx = { sessionProjections: { restore(checkpoint, history, baseSeq, meta, inherited) {
    assert.deepEqual(checkpoint, {})
    assert.equal(history, events)
    assert.equal(baseSeq, 0)
    assert.equal(meta, header)
    assert.equal(inherited, 1)
    return restoreResult(emptyInbox())
  } } }
  assert.doesNotThrow(() => assertNoPendingInbox(ctx, header, events, 1))
})

test('unavailable replay and missing or malformed inbox projections refuse admission', () => {
  const unavailable = new Error('projection replay failed')
  for (const restore of [undefined, () => restoreResult(undefined), () => restoreResult({ 'next-turn': [] })]) {
    assert.throws(() => assertNoPendingInbox({ sessionProjections: { restore } }, header, [], 0), { code: 'unsupported' })
  }
  const ctx = { sessionProjections: { restore() { throw unavailable } } }
  assert.throws(() => assertNoPendingInbox(ctx, header, [], 0), { code: 'unsupported', cause: unavailable })
  assert.throws(() => assertNoPendingInbox(ctx, header, [], 1), { code: 'unsupported' })
})

const install = process.env.DSH_INSTALL_DIR

test('new moves admit at most 128 members including the parent', () => {
  const root = 'test-root'
  const stored = [{ header: { id: root } }, ...Array.from({ length: 128 }, (_, index) => ({
    header: { id: `child-${index}`, origin: 'subagent', parentSession: root },
  }))]
  assert.equal(moveScope(root, stored.slice(0, 128), []).length, 128)
  assert.throws(() => moveScope(root, stored, []), { code: 'family-limit' })
})

test('DSH cold replay refuses either pending queue and accepts a queue cleared in history', {
  skip: !install && 'Set DSH_INSTALL_DIR to the pinned DSH installation',
}, async (t) => {
  const req = createRequire(join(install, 'package.json'))
  const load = (name) => import(pathToFileURL(req.resolve(`@deepseek-ai/${name}`)).href)
  const [cordis, projection, driver] = await Promise.all([
    load('cordis'), load('dsh-session-projection'), load('dsh-agent-loop'),
  ])
  const ctx = new cordis.Context()
  t.after(() => ctx.fiber.dispose())
  ctx.provide('sessions', {})
  ctx.provide('agents', { setFactory: () => () => {} })
  ctx.provide('llm', {})
  ctx.provide('tools', {})
  ctx.provide('systemPrompt', { variable() {} })
  await ctx.plugin(projection.SessionProjectionRegistry)
  await ctx.plugin(driver.AgentLoop)

  for (const target of ['next-turn', 'next-step']) {
    const queued = splice(0, target, [message])
    const pending = Object.freeze([queued])
    const removed = Object.freeze([queued, splice(1, target, [], { removedCount: 1, outcome: 'canceled' })])
    assert.throws(() => assertNoPendingInbox(ctx, header, pending, 0), { code: 'busy' })
    assert.doesNotThrow(() => assertNoPendingInbox(ctx, header, removed, 0))
    assert.throws(() => assertNoPendingInbox(ctx, header, [splice(0, target, [], { start: 1 })], 0), { code: 'unsupported' })
  }

  assert.throws(() => assertNoPendingInbox(ctx, header, [splice(1, 'next-turn', [])], 0), { code: 'unsupported' })
})
