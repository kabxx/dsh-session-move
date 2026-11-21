import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'
import { apply } from '../src/index.js'
import { openHost, parent, title } from './fixtures/transaction-host.js'

const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

// Flat row markers and their DOM ancestry are the only DOM contract used by
// the plugin. No browser, live sessions, or GUI changes are needed here.
class RowElement {
  constructor({ parent = null, key = null, draggable = false, expanded = null } = {}) {
    this.parent = parent
    this.isConnected = true
    this.dispatched = []
    this.draggable = draggable
    this.attributes = { 'data-row-key': key, 'aria-expanded': expanded }
    this.style = { outline: '', outlineOffset: '' }
  }

  dispatchEvent(event) {
    this.dispatched.push(event.type)
  }

  getAttribute(name) {
    return this.attributes[name] ?? null
  }

  closest(selector) {
    assert.equal(selector, '[data-row-key]')
    for (let node = this; node !== null; node = node.parent) {
      if (node.getAttribute('data-row-key') !== null) return node
    }
    return null
  }

  contains(target) {
    for (let node = target; node !== null; node = node.parent) {
      if (node === this) return true
    }
    return false
  }

  child(options) {
    return new RowElement({ ...options, parent: this })
  }
}

function fixture(t, language = 'zh', liveFetch = null) {
  const effects = []
  const listeners = new Map()
  const requests = []
  let fetchResult = { moved: true }
  let status = 200
  let pendingRequest
  let slot
  const snapshot = {
    items: [
      { workspaceId: 'A', title: 'A', sessionIds: ['sA', 'sA2', 'blank', 'archived'] },
      { workspaceId: 'B', title: 'B', sessionIds: ['sB'] },
      { workspaceId: 'B1', title: 'B1', sessionIds: ['sB1'] },
      { workspaceId: 'empty', title: 'Empty', sessionIds: [] },
    ],
    archivedSessionIds: ['archived'],
  }
  const document = {
    addEventListener(type, callback, capture) {
      assert.equal(capture, true)
      assert.equal(listeners.has(type), false)
      listeners.set(type, callback)
    },
    removeEventListener(type, callback, capture) {
      assert.equal(capture, true)
      assert.equal(listeners.get(type), callback)
      listeners.delete(type)
    },
  }
  const modules = {
    react: { useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot() },
    '@deepseek-ai/dsh-client-store': { createSnapshotStore(initial) {
      let value = initial
      return { getSnapshot: () => value, subscribe: () => {}, set: (next) => { value = next } }
    } },
  }
  let translate
  const ctx = {
    locale: {
      bind: () => (...params) => translate(...params),
      register: (_namespace, strings) => { translate = (key) => strings[language][key] },
    },
    workspaces: { list: { getSnapshot: () => snapshot } },
    slots: {
      inject: (_name, register) => register(),
      register: (_options, render) => { slot = render },
    },
    effect: (create) => { effects.push(create()) },
  }
  runInNewContext(source, {
    AbortController,
    document,
    Element: RowElement,
    Node: RowElement,
    fetch: async (url, options) => {
      requests.push({ url, method: options.method, body: JSON.parse(options.body) })
      if (liveFetch) {
        pendingRequest = liveFetch(new Request(new URL(url, 'http://test.local'), options))
        return await pendingRequest
      }
      return { ok: status >= 200 && status < 300, status, json: async () => fetchResult }
    },
    MouseEvent: Event,
    window: {
      __ModuleLoader__: { load: ({ factory }) => {
        const plugin = factory((id) => modules[id])
        for (const service of plugin.inject) assert.ok(Object.hasOwn(ctx, service), `Unexpected service: ${service}`)
        plugin.apply(ctx)
      } },
      addEventListener: (type, callback) => listeners.set(`window:${type}`, callback),
      removeEventListener: (type) => listeners.delete(`window:${type}`),
    },
  })
  const dispose = () => { for (const effect of effects.splice(0).reverse()) effect?.() }
  t.after(dispose)

  const root = new RowElement()
  const folder = (workspaceId, parent = root, expanded = true) =>
    parent.child({ key: `workspace:${workspaceId}`, expanded: String(expanded) })
  const session = (id, parent = root, draggable = true) =>
    parent.child({ key: `session:${id}`, draggable })
  const bGroup = root.child()
  const b1Group = bGroup.child()
  return {
    snapshot, requests, dispose, listeners,
    rows: {
      a: folder('A'), b: folder('B', bGroup), b1: folder('B1', b1Group),
      empty: folder('empty', root, false), ungrouped: folder(''), unknown: folder('unknown'),
      source: session('sA'), sameGroup: session('sA2'), bParentSession: session('sB', bGroup),
      bChildSession: session('sB1', b1Group), loose: session('loose'), blank: session('blank', root, false),
      archived: session('archived'), background: root, overflow: root.child({ key: 'overflow:B' }),
    },
    dispatch(type, target, relatedTarget = null) {
      const event = {
        target, relatedTarget, dataTransfer: { dropEffect: 'none' }, defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true },
        stopPropagation() { this.stopped = true },
      }
      listeners.get(type)(event)
      if (type === 'dragover') {
        // Model DSH's document-level fallback before our window handler.
        event.dataTransfer.dropEffect = 'move'
        listeners.get('window:dragover')?.(event)
      }
      return event
    },
    setResponse(code, result) { status = code; fetchResult = result },
    completedRequest: () => pendingRequest,
    toast: () => slot({ t: translate, renderFactorySlot: (_name, props) => props }),
  }
}

const postTo = (sessionId, targetWorkspaceId, sourceWorkspaceId) => ({
  url: '/api/session-move/session', method: 'POST', body: { sessionId, targetWorkspaceId, sourceWorkspaceId },
})

test('only the exact folder row accepts a cross-workspace drop', (t) => {
  const f = fixture(t)
  const { source, b, b1, bParentSession, bChildSession, sameGroup, a, ungrouped, unknown, overflow, background } = f.rows
  f.dispatch('dragstart', source)
  for (const target of [bParentSession.child(), bChildSession.child(), sameGroup, a.child(), ungrouped, unknown, overflow, background]) {
    const dragover = f.dispatch('dragover', target)
    assert.equal(dragover.defaultPrevented, false)
    assert.equal(dragover.stopped, false)
    assert.equal(dragover.dataTransfer.dropEffect, target === sameGroup ? 'move' : 'none')
    const drop = f.dispatch('drop', target)
    assert.equal(drop.defaultPrevented, false)
    assert.equal(drop.stopped, false)
    f.dispatch('dragstart', source)
  }
  assert.deepEqual(f.requests, [])
  assert.equal(f.dispatch('dragover', b.child()).dataTransfer.dropEffect, 'move')
  assert.equal(b.style.outline, '2px solid var(--dsw-alias-state-business-primary)')
  assert.equal(b1.style.outline, '')
  const drop = f.dispatch('drop', b.child())
  assert.equal(drop.defaultPrevented, true)
  assert.equal(drop.stopped, true)
  assert.equal(b.style.outline, '')
  assert.deepEqual(source.dispatched, ['drop'])
  assert.deepEqual(f.requests, [postTo('sA', 'B', 'A')])
})

test('a rejected drop or drag cancellation does not commit the last group sort marker', (t) => {
  const f = fixture(t)
  const { source, sameGroup, bParentSession } = f.rows
  for (const finish of ['foreign-drop', 'no-drop', 'group-drop']) {
    let order = ['sA', 'sA2']
    let marker = null
    let committed = false
    const nativeDrop = (target) => {
      if (committed) return
      committed = true
      if (target === sameGroup) order.reverse()
    }
    source.dispatchEvent = (event) => {
      assert.equal(event.type, 'drop')
      nativeDrop(source)
    }
    f.dispatch('dragstart', source)
    f.dispatch('dragover', sameGroup)
    marker = sameGroup
    if (finish === 'group-drop') {
      assert.equal(f.dispatch('drop', sameGroup).stopped, false)
      nativeDrop(sameGroup)
    } else {
      assert.equal(f.dispatch('dragover', bParentSession).dataTransfer.dropEffect, 'none')
      if (finish === 'foreign-drop') f.dispatch('drop', bParentSession)
    }
    f.dispatch('dragend', source)
    if (marker) nativeDrop(marker)
    assert.deepEqual(order, finish === 'group-drop' ? ['sA2', 'sA'] : ['sA', 'sA2'], finish)
  }
  assert.deepEqual(f.requests, [])
})

test('a dragged folder drop reaches the registered Host route with its captured source', {
  skip: !process.env.DSH_INSTALL_DIR && 'Set DSH_INSTALL_DIR to the pinned DSH installation',
}, async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-move-client-host-')))
  let host
  t.after(async () => {
    try { await host?.close() } finally { await rm(home, { force: true, recursive: true }) }
  })
  host = await openHost(home)
  const { ctx } = host
  const [a, b] = await Promise.all(['A', 'B'].map(async (name) => {
    const path = join(home, name)
    await mkdir(path)
    return await ctx.workspaceRegistry.create(path)
  }))
  const log = await ctx.sessionPersistence.create({ version: 4, id: parent, cwd: a.path, createdAt: 1, isSeeded: false })
  try { await log.append([title(parent, 0, 'original title')]) } finally { await log.close() }
  await a.attachSession(parent)
  let route
  ctx.provide('connection', { fetch: { register: (options) => { route = options } } })
  apply(ctx)
  let response
  const f = fixture(t, 'zh', async (request) => {
    assert.equal(new URL(request.url).pathname, route.path)
    assert.deepEqual(route.methods, [request.method])
    response = await route.fetch(request)
    return response.clone()
  })
  f.snapshot.items = [a, b].map(({ id, sessionIds }) => ({ workspaceId: id, sessionIds }))
  f.rows.source.attributes['data-row-key'] = `session:${parent}`
  f.rows.b.attributes['data-row-key'] = `workspace:${b.id}`
  f.dispatch('dragstart', f.rows.source)
  f.dispatch('dragover', f.rows.b)
  f.dispatch('drop', f.rows.b)
  assert.deepEqual(f.requests, [postTo(parent, b.id, a.id)])
  // The fetch starts synchronously, but completes after the native DSH storage
  // and ledger commit. Wait for that response rather than for a timer.
  await f.completedRequest()
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  assert.equal(result.moved, true)
  assert.deepEqual(a.sessionIds, [])
  assert.deepEqual(b.sessionIds, [parent])
})

test('the source workspace comes from actual membership and can target a nested folder', (t) => {
  const f = fixture(t)
  // This session row follows B1 in the sidebar but belongs to B. A move to B
  // itself is a no-op, and a move to B1 is an intentional cross-workspace drop.
  const { bParentSession, b, b1 } = f.rows
  f.dispatch('dragstart', bParentSession)
  assert.equal(f.dispatch('drop', b).defaultPrevented, false)
  f.dispatch('dragstart', bParentSession)
  assert.equal(f.dispatch('drop', b1.child()).defaultPrevented, true)
  assert.deepEqual(f.requests, [postTo('sB', 'B1', 'B')])
})

test('a collapsed empty folder accepts a drop and restores inline styles', (t) => {
  const f = fixture(t)
  const { source, empty, background } = f.rows
  empty.style.outline = '1px solid'
  empty.style.outlineOffset = '2px'
  const icon = empty.child()
  const title = empty.child()
  f.dispatch('dragstart', source)
  assert.equal(f.dispatch('dragover', icon).defaultPrevented, true)
  assert.notEqual(empty.style.outline, '1px solid')
  f.dispatch('dragleave', icon, title)
  assert.notEqual(empty.style.outline, '1px solid')
  f.dispatch('dragleave', title, background)
  assert.equal(empty.style.outline, '1px solid')
  assert.equal(empty.style.outlineOffset, '2px')
  assert.equal(f.dispatch('drop', title).defaultPrevented, true)
  assert.deepEqual(f.requests, [postTo('sA', 'empty', 'A')])
})

test('an ungrouped session can be dropped onto a workspace folder', (t) => {
  const f = fixture(t)
  const { loose, ungrouped, a } = f.rows
  f.dispatch('dragstart', loose)
  assert.equal(f.dispatch('dragover', ungrouped).defaultPrevented, false)
  assert.equal(f.dispatch('dragover', a).defaultPrevented, true)
  assert.equal(f.dispatch('drop', a).defaultPrevented, true)
  assert.deepEqual(f.requests, [postTo('loose', 'A', null)])
})

test('archived, non-draggable, and workspace drags cannot move via drag', (t) => {
  const f = fixture(t)
  const { archived, blank, a, b } = f.rows
  for (const ineligible of [archived, blank, a]) {
    f.dispatch('dragstart', ineligible)
    assert.equal(f.dispatch('dragover', b).defaultPrevented, false)
    assert.equal(f.dispatch('drop', b).defaultPrevented, false)
  }
  assert.deepEqual(f.requests, [])
})

test('a membership update during drag keeps the folder target and the captured source', async (t) => {
  const f = fixture(t)
  const { source, a, b } = f.rows
  f.setResponse(409, { error: 'stale-source' })
  f.dispatch('dragstart', source)
  f.dispatch('dragover', b)
  f.snapshot.items[0].sessionIds = ['sA2']
  f.snapshot.items[1].sessionIds.push('sA')
  assert.equal(f.dispatch('dragover', a).defaultPrevented, false)
  assert.equal(f.dispatch('dragover', b).dataTransfer.dropEffect, 'move')
  assert.equal(f.dispatch('drop', b).defaultPrevented, true)
  assert.equal(b.style.outline, '')
  assert.deepEqual(f.requests, [postTo('sA', 'B', 'A')])
  await setImmediate()
  assert.equal(f.toast().text, '会话所在工作区已变更，请从侧栏新位置重新拖动。')
  assert.equal(f.toast().tone, 'warning')
})

test('an ungrouped source stays null if the session joins a workspace during drag', async (t) => {
  const f = fixture(t, 'en')
  f.setResponse(409, { error: 'stale-source' })
  f.dispatch('dragstart', f.rows.loose)
  f.snapshot.items[0].sessionIds.push('loose')
  assert.equal(f.dispatch('drop', f.rows.b).defaultPrevented, true)
  assert.deepEqual(f.requests, [postTo('loose', 'B', null)])
  await setImmediate()
  assert.equal(f.toast().text, 'The session’s workspace has changed. Drag it again from its new location.')
  assert.equal(f.toast().tone, 'warning')
})

test('dragend and plugin unload clear feedback and unload removes listeners', (t) => {
  const f = fixture(t)
  const { source, b } = f.rows
  f.dispatch('dragstart', source)
  f.dispatch('dragover', b)
  assert.notEqual(b.style.outline, '')
  f.dispatch('dragend', source)
  assert.equal(b.style.outline, '')
  assert.equal(f.dispatch('drop', b).defaultPrevented, false)
  f.dispatch('dragstart', source)
  f.dispatch('dragover', b)
  f.dispose()
  assert.equal(b.style.outline, '')
  assert.equal(f.listeners.size, 0)
})

test('dragging to either of two same-titled workspaces uses the folder row ID', (t) => {
  const f = fixture(t)
  const { source, b, b1 } = f.rows
  f.snapshot.items[1].title = 'api'
  f.snapshot.items[2].title = 'api'
  for (const target of [b, b1]) {
    f.dispatch('dragstart', source)
    assert.equal(f.dispatch('drop', target).defaultPrevented, true)
  }
  assert.deepEqual(f.requests, [postTo('sA', 'B', 'A'), postTo('sA', 'B1', 'A')])
})

test('drag feedback requires explicit host success and reports pending cleanup', async (t) => {
  const f = fixture(t)
  const drop = async (status, result) => {
    f.setResponse(status, result)
    f.dispatch('dragstart', f.rows.source)
    f.dispatch('drop', f.rows.b)
    await setImmediate()
  }

  await drop(200, {})
  assert.equal(f.toast().text, '移动失败，请重试。')
  assert.equal(f.toast().tone, 'warning')

  await drop(409, { error: 'restored' })
  assert.equal(f.toast().text, '移动失败，会话记录已恢复到原目录。')
  assert.equal(f.toast().tone, 'warning')

  await drop(200, { moved: true, cleanupPending: true })
  assert.equal(f.toast().text, '会话已移动，后续清理待完成。')
  assert.equal(f.toast().tone, 'warning')

  await drop(200, { moved: true, sidebarPending: true })
  assert.equal(f.toast().text, '会话已移动，侧栏暂未同步，请刷新页面。')
  assert.equal(f.toast().tone, 'warning')

  await drop(200, { moved: true })
  assert.equal(f.toast().tone, 'success')
  assert.deepEqual(f.requests, Array.from({ length: 5 }, () => postTo('sA', 'B', 'A')))
})
