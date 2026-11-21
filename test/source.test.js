import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSessionMove } from '../src/move.js'
import { assertExpectedSource } from '../src/plan.js'
import { openHost, parent, request, title } from './fixtures/transaction-host.js'

const integration = { skip: !process.env.DSH_INSTALL_DIR && 'Set DSH_INSTALL_DIR to the pinned DSH installation' }

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-move-expected-source-')))
  let host
  t.after(async () => {
    try { await host?.close() } finally { await rm(home, { force: true, recursive: true }) }
  })
  host = await openHost(home)
  const { ctx } = host
  const folders = await Promise.all(['source', 'first', 'second'].map(async (name) => {
    const path = join(home, name)
    await mkdir(path)
    return path
  }))
  const [source, first, second] = await Promise.all(folders.map((path) => ctx.workspaceRegistry.create(path)))
  const original = title(parent, 0, 'original title')
  const file = await ctx.sessionPersistence.create({ version: 4, id: parent, cwd: source.path, createdAt: 1, isSeeded: false })
  try { await file.append([original]) } finally { await file.close() }
  await source.attachSession(parent)
  return { host, source, first, second, original }
}

test('expected source means unique projected membership or explicit null', () => {
  const workspace = { id: 'source', sessionIds: [parent] }
  const options = { sessionId: parent }
  assert.equal(assertExpectedSource([workspace], { ...options, sourceWorkspaceId: 'source' }), 'source')
  assert.equal(assertExpectedSource([], { ...options, sourceWorkspaceId: null }), null)
  assert.throws(() => assertExpectedSource([workspace], { ...options, sourceWorkspaceId: null }), { code: 'stale-source' })
  assert.throws(() => assertExpectedSource([workspace, { ...workspace, id: 'other' }], {
    ...options, sourceWorkspaceId: 'source',
  }), { code: 'stale-source' })
  assert.throws(() => assertExpectedSource([], options), { code: 'bad-request' })
})

test('serialized requests from different windows move only from the source both saw', integration, async (t) => {
  const { host, source, first, second, original } = await fixture(t)
  const prepared = []
  const move = createSessionMove(host.ctx, {
    ...host,
    activity: async () => [],
    checkpoint: (step, state) => { if (step === 'prepared') prepared.push(state.targetWorkspaceId) },
  })
  const [winner, stale, staleDuplicate] = await Promise.all([
    move(request(first.id, source.id)),
    move(request(second.id, source.id)),
    move(request(first.id, source.id)),
  ])
  assert.equal(winner.status, 200)
  assert.equal((await winner.json()).moved, true)
  for (const result of [stale, staleDuplicate]) {
    assert.equal(result.status, 409)
    assert.deepEqual(await result.json(), { error: 'stale-source' })
  }
  assert.deepEqual(prepared, [first.id])
  assert.deepEqual(source.sessionIds, [])
  assert.deepEqual(first.sessionIds, [parent])
  assert.deepEqual(second.sessionIds, [])
  const file = await host.ctx.sessionPersistence.open(parent, 'read')
  try {
    assert.equal(file.header.cwd, first.path)
    const { events } = await file.read()
    assert.equal(events.length, 2)
    assert.deepEqual(events[0], original)
    assert.equal(events[1].type, 'working-directory/change')
    assert.deepEqual(events[1].data, { cwd: first.path })
  } finally { await file.close() }
})

test('explicit ungrouped source supports reattachment, but stale or malformed sources are refused', integration, async (t) => {
  const { host, source, first } = await fixture(t)
  const { ctx } = host
  const move = createSessionMove(ctx, { ...host, activity: async () => [] })
  for (const invalid of [undefined, '', 42, {}, false, 'a\nb', 'x'.repeat(201)]) {
    const response = await move(request(first.id, invalid))
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'bad-request' })
  }
  assert.deepEqual(await (await move(request(first.id, null))).json(), { error: 'stale-source' })
  const path = (await ctx.sessionPersistence.stat(parent)).location.path
  const before = await readFile(path)
  await ctx.workspaceRegistry.delete(source.id)
  const added = await ctx.workspaceRegistry.create(source.path)
  assert.deepEqual(added.sessionIds, [])
  assert.deepEqual(await (await move(request(added.id, source.id))).json(), { error: 'stale-source' })
  assert.equal((await (await move(request(added.id, null))).json()).moved, true)
  assert.deepEqual(added.sessionIds, [parent])
  assert.deepEqual(await readFile(path), before)
  assert.deepEqual(await (await move(request(first.id, null))).json(), { error: 'stale-source' })
  assert.deepEqual(await (await move(request(added.id, added.id))).json(), { error: 'same-workspace' })
})
