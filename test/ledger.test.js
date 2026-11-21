import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { captureLedger, moveLedger, repairLegacyDuplicates, restoreLedger } from '../src/ledger.js'

const ROOT = 'root-session'
const CHILD = 'root-session:spawn:1'

async function paths(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-move-ledger-')))
  t.after(() => rm(root, { force: true, recursive: true }))
  const cwd = { source: join(root, 'source'), target: join(root, 'target'), other: join(root, 'other') }
  await Promise.all(Object.values(cwd).map((path) => mkdir(path)))
  return { root, cwd }
}

function fixtureRecords(cwd) {
  const timestamp = new Date(0).toISOString()
  return new Map(Object.entries({
    source: ['first', ROOT, 'middle', CHILD, 'last'],
    target: ['target-first', 'target-last'],
    other: ['other-session', 'already-stale'],
  }).map(([id, sessionIds]) => [id, {
    path: cwd[id], title: id, sessionIds, createdAt: timestamp, updatedAt: timestamp,
  }]))
}

function fixturePlan(cwd) {
  return {
    targetWorkspaceId: 'target', targetCwd: cwd.target, beforeSessionId: 'target-last',
    members: [ROOT, CHILD].map((id) => ({ id, oldCwd: cwd.source })),
  }
}

function fixtureHeaders(cwd, records) {
  const headers = new Map()
  for (const [workspace, record] of records) {
    for (const id of record.sessionIds) {
      if (id !== 'already-stale') headers.set(id, { id, cwd: cwd[workspace], createdAt: 0 })
    }
  }
  return headers
}

function setDirectory(headers, plan, cwd) {
  for (const { id } of plan.members) headers.set(id, { ...headers.get(id), cwd })
}

async function fakeHost(t) {
  const { cwd } = await paths(t)
  const records = fixtureRecords(cwd)
  const headers = fixtureHeaders(cwd, records)
  const table = { records, get: (id) => records.get(id), entries: () => records.entries() }
  const raw = new Map(records)
  const events = []
  let durable = new Map(raw)
  let onPublish
  let onEmit
  let tail = Promise.resolve()
  let writes = 0
  const domain = {
    name: 'workspace',
    table: () => table,
    enqueue(job) {
      const result = tail.then(job)
      tail = result.catch(() => {})
      return result
    },
    emitChanged(change) { events.push(change); onEmit?.(change) },
    unit: {
      descriptor: { name: 'workspace', version: 2 },
      state: { tables: new Map([['workspaces', raw]]) },
      async publish() {
        durable = new Map(raw)
        await onPublish?.(++writes)
      },
    },
  }
  const registry = {
    table,
    enqueueOperation: (fn) => fn(),
    entities: new Map([...records].map(([id, record]) => [id, { record }])),
    headers: new Map(headers),
    sessionPaths: new Map([...headers].map(([id, header]) => [id, header.cwd])),
    missingSessionPaths: new Set(), invalidSessionPaths: new Map(),
  }
  const ctx = {
    get: (name) => name === 'storageDomain' ? { get: () => domain } : undefined,
    workspaceRegistry: registry,
    sessionPersistence: { stat: async (id) => ({ header: headers.get(id) }) },
  }
  return {
    cwd, ctx, registry, events, plan: fixturePlan(cwd), headers, domain, raw, records,
    durable: () => durable, onPublish: (fn) => { onPublish = fn }, onEmit: (fn) => { onEmit = fn },
  }
}

test('one publish transfers the whole family and only updates its record and index entries', async (t) => {
  const host = await fakeHost(t)
  const { ctx, cwd, plan, headers, registry, events, records } = host
  const saved = captureLedger(ctx, plan)
  assert.deepEqual(saved.map(({ id }) => id), ['source', 'target'])
  const other = records.get('other')
  const otherHeader = registry.headers.get('other-session')
  setDirectory(headers, plan, cwd.target)
  let publishes = 0
  host.onPublish(() => {
    publishes++
    assert.equal(registry.sessionPaths.get(ROOT), cwd.source)
    assert.equal(registry.sessionPaths.get('other-session'), cwd.other)
  })
  host.onEmit(() => {
    assert.equal(registry.sessionPaths.get(ROOT), cwd.target)
    assert.deepEqual(registry.entities.get('source').record.sessionIds, ['first', 'middle', 'last'])
    assert.deepEqual(registry.entities.get('target').record.sessionIds, ['target-first', ROOT, CHILD, 'target-last'])
  })
  await moveLedger(ctx, plan, saved)
  assert.equal(publishes, 1)
  assert.deepEqual(events.map(({ key }) => key), ['source', 'target'])
  assert.equal(records.get('other'), other)
  assert.equal(registry.headers.get('other-session'), otherHeader)
  assert.deepEqual(host.durable(), records)
  await moveLedger(ctx, plan, saved)
  assert.equal(publishes, 1)
})

test('a publish error after replacement restores the previous disk and sidebar state', async (t) => {
  const host = await fakeHost(t)
  const { ctx, cwd, plan, headers, records, events, registry } = host
  const before = new Map(records)
  const saved = captureLedger(ctx, plan)
  setDirectory(headers, plan, cwd.target)
  host.onPublish((count) => { if (count === 1) throw new Error('fsync failed after replacement') })
  await assert.rejects(moveLedger(ctx, plan, saved), /fsync failed/u)
  assert.deepEqual(host.durable(), before)
  assert.deepEqual(records, before)
  assert.equal(registry.sessionPaths.get(ROOT), cwd.source)
  assert.equal(events.length, 0)
})

test('rollback restores original relative positions and preserves other edits', async (t) => {
  const host = await fakeHost(t)
  const { ctx, cwd, plan, headers, records, raw, registry } = host
  const saved = JSON.parse(JSON.stringify(captureLedger(ctx, plan)))
  setDirectory(headers, plan, cwd.target)
  await moveLedger(ctx, plan, saved)
  const source = { ...records.get('source'), title: 'renamed', sessionIds: ['new', 'first', 'middle', 'last'] }
  raw.set('source', source)
  records.set('source', source)
  registry.entities.get('source').record = source
  setDirectory(headers, plan, cwd.source)
  await restoreLedger(ctx, plan, saved)
  assert.equal(records.get('source').title, 'renamed')
  assert.deepEqual(records.get('source').sessionIds, ['new', 'first', ROOT, 'middle', CHILD, 'last'])
  assert.deepEqual(records.get('target').sessionIds, ['target-first', 'target-last'])
  assert.equal(registry.sessionPaths.get(CHILD), cwd.source)
  assert.deepEqual(host.durable(), records)
})

test('rollback preserves a deleted source workspace and clears only the target membership', async (t) => {
  const { ctx, cwd, plan, headers, records, raw, registry, events } = await fakeHost(t)
  const saved = captureLedger(ctx, plan)
  setDirectory(headers, plan, cwd.target)
  await moveLedger(ctx, plan, saved)
  records.delete('source')
  raw.delete('source')
  registry.entities.delete('source')
  setDirectory(headers, plan, cwd.source)
  const unrelated = records.get('other')
  const eventCount = events.length
  await restoreLedger(ctx, plan, saved)
  assert.equal(records.has('source'), false)
  assert.deepEqual(records.get('target').sessionIds, ['target-first', 'target-last'])
  assert.equal(records.get('other'), unrelated)
  assert.equal(registry.sessionPaths.get(ROOT), cwd.source)
  assert.deepEqual(events.slice(eventCount).map(({ key }) => key), ['target'])
  await restoreLedger(ctx, plan, saved)
  assert.equal(events.length, eventCount + 1)
})

test('rollback before ledger publication does not undo an intervening reorder', async (t) => {
  const { ctx, plan, records, events } = await fakeHost(t)
  const saved = captureLedger(ctx, plan)
  const order = ['last', 'first', ROOT, 'middle', CHILD]
  records.set('source', { ...records.get('source'), sessionIds: order })
  await restoreLedger(ctx, plan, saved)
  assert.deepEqual(records.get('source').sessionIds, order)
  assert.equal(events.length, 0)
})

test('prepared-journal recovery can restore exact original order before the registry is provided', async (t) => {
  const { ctx, domain, cwd, plan, headers, records } = await fakeHost(t)
  const snapshot = JSON.parse(JSON.stringify(captureLedger(ctx, plan)))
  const original = [...records.get('source').sessionIds]
  setDirectory(headers, plan, cwd.target)
  await moveLedger(ctx, plan, snapshot)
  setDirectory(headers, plan, cwd.source)
  const earlyContext = { sessionPersistence: ctx.sessionPersistence }
  await restoreLedger(earlyContext, plan, snapshot, { domain })
  assert.deepEqual(records.get('source').sessionIds, original)
  assert.deepEqual(records.get('target').sessionIds, ['target-first', 'target-last'])
})

test('a backend without atomic replacement is rejected before starting a transfer', async (t) => {
  const { ctx, domain, plan } = await fakeHost(t)
  delete domain.unit.publish
  assert.throws(() => captureLedger(ctx, plan), { code: 'unsupported' })
})

test('legacy duplicate repair is restricted to IDs with one provable owner', async (t) => {
  const { ctx, domain, cwd, headers, records, raw } = await fakeHost(t)
  for (const [id, extra] of [['source', ['ambiguous']], ['target', [ROOT, 'ambiguous']]]) {
    const record = { ...records.get(id), sessionIds: [...records.get(id).sessionIds, ...extra] }
    records.set(id, record)
    raw.set(id, record)
  }
  setDirectory(headers, fixturePlan(cwd), cwd.target)
  const before = records.get('other')
  assert.equal(await repairLegacyDuplicates(ctx, { domain }), 1)
  assert.deepEqual(records.get('source').sessionIds, ['first', 'middle', CHILD, 'last', 'ambiguous'])
  assert.deepEqual(records.get('target').sessionIds, ['target-first', 'target-last', ROOT, 'ambiguous'])
  assert.equal(records.get('other'), before)
})

test('real DSH JSON ledger and registry — startup repair, transfer, and unrelated rename', {
  skip: !process.env.DSH_LEDGER_TEST_INSTALL && 'set DSH_LEDGER_TEST_INSTALL to the pinned DSH installation',
}, async (t) => {
  const rootRequire = createRequire(join(process.env.DSH_LEDGER_TEST_INSTALL, 'package.json'))
  const load = (name) => import(pathToFileURL(rootRequire.resolve(`@deepseek-ai/${name}`)).href)
  const [workspace, storage, json, cordis] = await Promise.all([
    load('dsh-workspace'), load('dsh-storage-domain'), load('dsh-storage-json'), load('cordis'),
  ])
  const { root, cwd } = await paths(t)
  const ledgerDir = join(root, 'storage')
  const records = fixtureRecords(cwd)
  // Include an old duplicate before opening the production WorkspaceRegistry.
  records.set('target', { ...records.get('target'), sessionIds: [ROOT, ...records.get('target').sessionIds] })
  const headers = fixtureHeaders(cwd, records)
  headers.set(ROOT, { ...headers.get(ROOT), cwd: cwd.source })
  const backend = new json.JsonStorageBackend(ledgerDir)
  const context = new cordis.Context()
  // Use the stock Cordis service proxies, including WorkspaceRegistry.
  context.provide('storage', { backend: { get: () => backend } })
  const facility = new storage.DomainFacility(context, { backend: 'json' })
  t.after(async () => {
    await facility.closeAll()
    await backend.close()
  })
  context.provide('storageDomain', facility)
  context.provide('sessionPersistence', {
    list: async () => [...headers.values()].map((header) => ({ header })),
    stat: async (id) => ({ header: headers.get(id) }),
  })
  const early = await facility.open(workspace.workspaceDomainSpec)
  for (const [id, record] of records) await early.table('workspaces').put(id, record)
  await early.global.set({ initialized: true, workspaceIds: [...records.keys()], archivedSessionIds: [], pinnedSessionIds: [] })
  assert.equal(await repairLegacyDuplicates(context, { domain: early }), 1)
  await early.close()
  await context.plugin(workspace.WorkspaceRegistry)
  const registry = context.get('workspaceRegistry')
  assert.ok(registry)
  const plan = fixturePlan(cwd)
  const snapshot = captureLedger(context, plan)
  setDirectory(headers, plan, cwd.target)
  const nativeDomain = facility.get('workspace')
  const publish = nativeDomain.unit.publish.bind(nativeDomain.unit)
  let release
  let markEntered
  const entered = new Promise((resolve) => { markEntered = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  nativeDomain.unit.publish = async () => {
    markEntered()
    await gate
    await publish()
  }
  const move = moveLedger(context, plan, snapshot)
  await Promise.race([entered, move.then(() => assert.fail('move completed before entering the write'))])
  const rename = registry.get('other').setTitle('new title')
  assert.deepEqual([...registry.get('other').sessionIds], ['other-session'])
  release()
  await Promise.all([move, rename])
  assert.deepEqual([...registry.get('source').sessionIds], ['first', 'middle', 'last'])
  assert.deepEqual([...registry.get('target').sessionIds], ['target-first', ROOT, CHILD, 'target-last'])
  const medium = JSON.parse(await readFile(join(ledgerDir, 'workspace.json'), 'utf8'))
  assert.equal(medium.tables.workspaces.other.title, 'new title')
  assert.deepEqual(medium.tables.workspaces.other.sessionIds, ['other-session'])
  assert.deepEqual(medium.tables.workspaces.target.sessionIds, ['target-first', ROOT, CHILD, 'target-last'])
})
