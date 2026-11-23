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
  constructor({ parent = null, key = null, draggable = false, expanded = null, role = null, listArea = false } = {}) {
    this.parent = parent
    this.children = []
    this.isConnected = true
    this.dispatched = []
    this.draggable = draggable
    this.attributes = {
      'data-row-key': key,
      'aria-expanded': expanded,
      role,
      'data-sidebar-list-area': listArea ? '' : null,
    }
    this.style = { outline: '', outlineOffset: '' }
    if (parent !== null) parent.children.push(this)
  }

  dispatchEvent(event) {
    this.dispatched.push(event.type)
  }

  getAttribute(name) {
    return this.attributes[name] ?? null
  }

  matches(selector) {
    if (selector === '[data-row-key]') return this.getAttribute('data-row-key') !== null
    if (selector === '[data-row-key^="workspace:"]') return this.getAttribute('data-row-key')?.startsWith('workspace:') === true
    if (selector === '[data-sidebar-list-area]') return this.getAttribute('data-sidebar-list-area') !== null
    if (selector === '[role="tree"]') return this.getAttribute('role') === 'tree'
    throw new Error(`Unsupported selector in test DOM: ${selector}`)
  }

  closest(selector) {
    for (let node = this; node !== null; node = node.parent) {
      if (node.matches(selector)) return node
    }
    return null
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child
      const nested = child.querySelector(selector)
      if (nested !== null) return nested
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

function fixture(t, language = 'zh', liveFetch = null, { sessions = null } = {}) {
  const effects = []
  const listeners = new Map()
  const requests = []
  const toastErrors = []
  let toastError = null
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
    react: {
      Fragment: Symbol('Fragment'),
      createElement: (type, props, ...children) => ({ type, props, children }),
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    },
    '@deepseek-ai/dsh-client-store': { createSnapshotStore(initial) {
      let value = initial
      return {
        getSnapshot: () => value,
        subscribe: () => {},
        set(next) {
          if (toastError !== null) {
            const error = toastError
            toastError = null
            throw error
          }
          value = next
        },
      }
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
    ...(sessions === null ? {} : {
      inject(services, callback) {
        if (!services.includes('sessions')) return
        const scoped = {
          get: (name) => name === 'sessions' ? sessions : undefined,
          effect: (create) => { effects.push(create()) },
        }
        callback(scoped)
      },
    }),
  }
  runInNewContext(source, {
    AbortController,
    console: { warn: (_message, error) => toastErrors.push(error) },
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

  const root = new RowElement({ listArea: true, role: 'tree' })
  const folder = (workspaceId, parent = root, expanded = true) =>
    parent.child({ key: `workspace:${workspaceId}`, expanded: String(expanded) })
  const session = (id, parent = root, draggable = true) =>
    parent.child({ key: `session:${id}`, draggable })
  const bGroup = root.child()
  const b1Group = bGroup.child()
  const renderFeedback = () => slot({ t: translate, renderFactorySlot: (_name, props) => props })
  return {
    snapshot, requests, dispose, listeners, toastErrors,
    failNextToast(error) { toastError = error },
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
    toast: () => renderFeedback().children[1],
    progress: () => {
      const [status] = renderFeedback().children
      return { status, indicator: status.children[0] }
    },
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
  assert.equal(f.progress().indicator.children[2], 'Moving session…')
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

test('dragging to either of two same-titled workspaces uses the folder row ID', async (t) => {
  const f = fixture(t)
  const { source, b, b1 } = f.rows
  f.snapshot.items[1].title = 'api'
  f.snapshot.items[2].title = 'api'
  for (const target of [b, b1]) {
    f.dispatch('dragstart', source)
    assert.equal(f.dispatch('drop', target).defaultPrevented, true)
    await setImmediate()
  }
  assert.deepEqual(f.requests, [postTo('sA', 'B', 'A'), postTo('sA', 'B1', 'A')])
})

test('a cross-workspace drop reports progress once, blocks repeats, and replaces progress with the result', async (t) => {
  const deferred = Promise.withResolvers()
  const f = fixture(t, 'zh', () => deferred.promise)
  const { source, a, b, b1, sameGroup } = f.rows
  f.dispatch('dragstart', source)
  f.dispatch('dragover', b)
  f.dispatch('dragend', source)
  assert.equal(f.progress().indicator, null)
  assert.equal(f.toast(), null)
  assert.deepEqual(f.requests, [])

  f.dispatch('dragstart', source)
  f.dispatch('dragover', b)
  f.dispatch('drop', b)
  const { status, indicator } = f.progress()
  assert.equal(status.props.role, 'status')
  assert.equal(status.props.style.pointerEvents, 'none')
  const [style, spinnerElement, text] = indicator.children
  assert.equal(text, '正在移动会话…')
  const spinner = spinnerElement.type(spinnerElement.props)
  assert.equal(spinner.type, 'svg')
  assert.equal(spinner.props['aria-hidden'], true)
  assert.equal(spinner.props.viewBox, '0 0 24 24')
  assert.equal(spinner.props.width, 18)
  assert.equal(spinner.props.height, 18)
  assert.match(style.children[0], /\.kabxx-session-move-spinner\s*\{[^}]*color: var\(--dsw-alias-toast-action\)/)
  assert.deepEqual(Array.from(spinner.children[0].children, ({ type, props }) => [type, props.r]), [
    ['circle', 9.5], ['circle', 9.5],
  ])
  assert.match(style.children[0], /kabxx-session-move-dash 1\.5s ease-in-out infinite/)
  assert.match(style.children[0], /prefers-reduced-motion: reduce/)

  f.dispatch('dragstart', source)
  assert.equal(f.dispatch('dragover', sameGroup).dataTransfer.dropEffect, 'move')
  assert.equal(f.dispatch('dragover', b1).dataTransfer.dropEffect, 'none')
  assert.equal(b1.style.outline, '')
  f.dispatch('drop', b1)
  f.dispatch('dragend', source)
  assert.deepEqual(f.requests, [postTo('sA', 'B', 'A')])
  assert.equal(f.progress().indicator.children[2], '正在移动会话…')
  assert.equal(f.toast(), null)

  deferred.resolve(Response.json({ moved: true }))
  await setImmediate()
  const completed = f.toast()
  assert.equal(completed.tone, 'success')
  assert.equal(f.progress().indicator, null)
  completed.onDone()
  assert.equal(f.toast(), null)

  f.snapshot.items[0].sessionIds = ['sA2']
  f.snapshot.items[1].sessionIds.push('sA')
  f.dispatch('dragstart', source)
  f.dispatch('drop', a)
  assert.deepEqual(f.requests, [postTo('sA', 'B', 'A'), postTo('sA', 'A', 'B')])
})

test('progress returns while another session is pending and clears on unload', async (t) => {
  const first = Promise.withResolvers()
  const second = Promise.withResolvers()
  let secondSignal
  const f = fixture(t, 'en', (request) => {
    if (f.requests.length === 1) return first.promise
    secondSignal = request.signal
    return second.promise
  })
  const { source, sameGroup, b } = f.rows
  f.dispatch('dragstart', source)
  f.dispatch('drop', b)
  f.dispatch('dragstart', sameGroup)
  f.dispatch('drop', b)
  assert.deepEqual(f.requests, [postTo('sA', 'B', 'A'), postTo('sA2', 'B', 'A')])

  first.reject(new Error('offline'))
  await setImmediate()
  const failure = f.toast()
  assert.equal(failure.text, 'Failed to move the session. Try again.')
  failure.onDone()
  assert.equal(f.progress().indicator.children[2], 'Moving session…')

  f.dispose()
  assert.equal(secondSignal.aborted, true)
  assert.equal(f.progress().indicator, null)
  assert.equal(f.toast(), null)
  second.resolve(Response.json({ moved: true }))
  await setImmediate()
  assert.equal(f.toast(), null)
})

test('concurrent results replace progress and are shown in order', async (t) => {
  const first = Promise.withResolvers()
  const second = Promise.withResolvers()
  const f = fixture(t, 'en', () => f.requests.length === 1 ? first.promise : second.promise)
  const { source, sameGroup, b, b1 } = f.rows
  f.dispatch('dragstart', source)
  f.dispatch('drop', b)
  assert.equal(f.progress().indicator.children[2], 'Moving session…')
  assert.equal(f.toast(), null)

  f.dispatch('dragstart', sameGroup)
  f.dispatch('drop', b1)
  first.reject(new Error('offline'))
  await setImmediate()
  const failure = f.toast()
  assert.equal(failure.tone, 'warning')
  second.resolve(Response.json({ moved: true }))
  await setImmediate()
  assert.equal(f.toast().seq, failure.seq)
  failure.onDone()
  const success = f.toast()
  assert.equal(success.tone, 'success')
  failure.onDone()
  assert.equal(f.toast().seq, success.seq)
  success.onDone()
  assert.equal(f.toast(), null)
})

test('an unavailable progress notification does not prevent the requested move', async (t) => {
  const f = fixture(t)
  const failure = new Error('notification subscriber failed')
  f.failNextToast(failure)
  f.dispatch('dragstart', f.rows.source)
  f.dispatch('drop', f.rows.b)
  assert.deepEqual(f.requests, [postTo('sA', 'B', 'A')])
  assert.deepEqual(f.toastErrors, [failure])
  await setImmediate()
  assert.equal(f.toast().tone, 'success')
})

test('drag feedback requires explicit host success and reports pending cleanup', async (t) => {
  const f = fixture(t)
  const drop = async (status, result) => {
    f.toast()?.onDone()
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

test('flat single-list sorting keeps native drag cursor and skips move interception', (t) => {
  const f = fixture(t)
  for (const containerOptions of [{ listArea: true, role: 'tree' }, { role: 'tree' }]) {
    const flatRoot = new RowElement(containerOptions)
    const flatA = flatRoot.child({ key: 'session:sA', draggable: true })
    const flatB = flatRoot.child({ key: 'session:sB', draggable: true })

    f.dispatch('dragstart', flatA)
    const overB = f.dispatch('dragover', flatB.child())
    assert.equal(overB.defaultPrevented, false)
    assert.equal(overB.stopped, false)
    assert.equal(overB.dataTransfer.dropEffect, 'move')
    const dropB = f.dispatch('drop', flatB.child())
    assert.equal(dropB.defaultPrevented, false)
    assert.equal(dropB.stopped, false)
    f.dispatch('dragend', flatA)
    assert.deepEqual(flatA.dispatched, [])
  }
  assert.deepEqual(f.requests, [])
})

function mockProjectionStore(initial = {}) {
  const rows = new Map(Object.entries(initial).map(([key, value]) => [key, { kind: 'sequenced', value }]))
  return {
    rows,
    clears: 0,
    clear() {
      this.clears++
      rows.clear()
    },
    applyCached(values) {
      for (const [key, value] of Object.entries(values)) {
        if (rows.get(key)?.kind === 'sequenced') continue
        rows.set(key, { kind: 'cached', value })
      }
    },
    seed(values) {
      for (const [key, row] of rows) if (row.kind === 'cached') rows.delete(key)
      for (const [key, value] of Object.entries(values)) rows.set(key, { kind: 'sequenced', value })
    },
    values: () => Object.fromEntries([...rows].map(([key, row]) => [key, row.value])),
  }
}

function mockSessionsFixture() {
  const bindings = new Map()
  const sessions = new Map()
  const rebinds = []
  const manager = {
    summaries: [],
    projectionStores: new Map(),
    projectionInflight: new Map(),
    projectionLoads: new Map(),
    handleSessionRemoved(id) {
      this.summaries = this.summaries.filter((item) => item.sessionId !== id)
      sessions.get(id)?.handleRemoved()
      this.projectionStores.delete(id)
      this.projectionInflight.get(id)?.controller?.abort?.()
      this.projectionInflight.delete(id)
      this.projectionLoads.delete(id)
    },
    handleSessionAdded(summary) {
      const id = summary.sessionId
      const existing = this.summaries.findIndex((item) => item.sessionId === id)
      if (existing >= 0) this.summaries[existing] = summary
      else this.summaries.push(summary)
      let store = this.projectionStores.get(id)
      if (!store) {
        store = mockProjectionStore()
        this.projectionStores.set(id, store)
      }
      if (summary.projections?.kind === 'cached') store.applyCached(summary.projections.values)
      else if (summary.projections?.kind === 'sequenced') store.seed(summary.projections.values)
    },
  }
  const originalRemove = manager.handleSessionRemoved
  const originalAdd = manager.handleSessionAdded
  const runtime = {
    manager,
    binding: (id) => bindings.get(id),
  }
  function mountSession(id, { openState = 'open', cwd = '/A', title = 'Original', attachmentIds = [], subagent = null, onResync } = {}) {
    const projections = mockProjectionStore({ title, workingDirectory: cwd })
    const session = {
      sessionId: id,
      openState,
      removed: false,
      subagent,
      projections,
      dirtyCount: 0,
      resyncCount: 0,
      notifier: { markDirty() { session.dirtyCount++ } },
      getSnapshot() { return { openState: this.openState, removed: this.removed, subagent: this.subagent } },
      handleRemoved() { this.removed = true; this.dirtyCount++ },
      async resync() {
        this.resyncCount++
        if (onResync) await onResync(this)
        else {
          this.openState = 'open'
          this.projections.seed({ title, workingDirectory: manager.summaries.find((item) => item.sessionId === id)?.cwd ?? cwd })
        }
      },
    }
    const conversation = {
      input: { for: () => ({ state: { getSnapshot: () => ({ attachmentIds }) } }) },
      rebindDraftFiles: (...args) => { rebinds.push(args) },
    }
    const binding = {
      sessionId: id,
      session,
      ctx: { get: (name) => name === 'conversation' ? conversation : undefined },
    }
    sessions.set(id, session)
    bindings.set(id, binding)
    manager.projectionStores.set(id, projections)
    manager.summaries.push({ sessionId: id, cwd, agentAvailable: true })
    return { session, binding }
  }
  return { runtime, manager, bindings, rebinds, mountSession, originalRemove, originalAdd }
}

test('moving or rolling back an open viewed session recovers input, rejoins projections, and deduplicates promotion', async (t) => {
  const s = mockSessionsFixture()
  const resyncGate = Promise.withResolvers()
  const { session } = s.mountSession('sA', {
    cwd: '/A',
    title: 'Active Chat',
    attachmentIds: ['draft-1'],
    async onResync(target) {
      target.openState = 'loading'
      await resyncGate.promise
      target.openState = 'open'
      target.projections.seed({ title: 'Active Chat', workingDirectory: '/B' })
    },
  })
  const f = fixture(t, 'zh', null, { sessions: s.runtime })

  s.manager.handleSessionRemoved('sA')
  assert.equal(session.removed, true)
  assert.equal(s.manager.projectionStores.has('sA'), false)

  // Cold re-addition emitted by move (or rollback) rejoins the store immediately
  // and starts one resync without losing the cached title while loading.
  s.manager.handleSessionAdded({
    sessionId: 'sA',
    cwd: '/B',
    agentAvailable: false,
    projections: { kind: 'cached', values: { title: 'Active Chat', workingDirectory: '/B' } },
  })
  assert.equal(s.manager.projectionStores.get('sA'), session.projections)
  assert.deepEqual(session.projections.values(), { title: 'Active Chat', workingDirectory: '/B' })
  assert.equal(session.removed, true)

  // Follow activation can emit a live addition while resync is still pending;
  // it must neither clear projections again nor trigger a duplicate resync.
  const clearsBeforePromotion = session.projections.clears
  s.manager.handleSessionAdded({
    sessionId: 'sA',
    cwd: '/B',
    agentAvailable: true,
    projections: { kind: 'sequenced', values: { title: 'Active Chat', workingDirectory: '/B' } },
  })
  assert.equal(session.projections.clears, clearsBeforePromotion)

  await setImmediate()
  assert.equal(session.resyncCount, 1)
  assert.deepEqual(s.rebinds, [['sA', ['draft-1'], true]])

  const dirtyBefore = session.dirtyCount
  resyncGate.resolve()
  await setImmediate()
  assert.equal(session.removed, false)
  assert.ok(session.dirtyCount > dirtyBefore)
  assert.deepEqual(session.projections.values(), { title: 'Active Chat', workingDirectory: '/B' })

  // Disposing the plugin restores the manager's original handlers.
  f.dispose()
  assert.equal(s.manager.handleSessionRemoved, s.originalRemove)
  assert.equal(s.manager.handleSessionAdded, s.originalAdd)
})

test('permanent deletion, mid-resync removal, and failed resync keep a viewed session removed until a valid retry', async (t) => {
  const s = mockSessionsFixture()
  let mode = 'error'
  let gate = null
  const { session } = s.mountSession('sA', {
    async onResync(target) {
      if (gate) await gate.promise
      target.openState = mode === 'ok' ? 'open' : 'error'
    },
  })
  fixture(t, 'zh', null, { sessions: s.runtime })

  // Real deletion never receives api-session/added.
  s.manager.handleSessionRemoved('sA')
  assert.equal(session.removed, true)

  // Failed resync keeps the session removed.
  s.manager.handleSessionAdded({ sessionId: 'sA', cwd: '/A', agentAvailable: false })
  await setImmediate()
  assert.equal(session.resyncCount, 1)
  assert.equal(session.removed, true)

  // A subsequent removal while resync is in flight invalidates that sync even if it resolves open.
  mode = 'ok'
  gate = Promise.withResolvers()
  s.manager.handleSessionAdded({ sessionId: 'sA', cwd: '/A', agentAvailable: false })
  await setImmediate()
  assert.equal(session.resyncCount, 2)
  s.manager.handleSessionRemoved('sA')
  gate.resolve()
  await setImmediate()
  assert.equal(session.removed, true)

  // A later valid addition recovers cleanly.
  gate = null
  s.manager.handleSessionAdded({ sessionId: 'sA', cwd: '/B', agentAvailable: false })
  await setImmediate()
  assert.equal(session.resyncCount, 3)
  assert.equal(session.removed, false)
})

test('cold retained sessions clear removed directly and open non-removed sessions resync on cwd change', async (t) => {
  const s = mockSessionsFixture()
  const { session: cold } = s.mountSession('sCold', { openState: 'cold', cwd: '/A' })
  const { session: openSub } = s.mountSession('sSub', { openState: 'open', cwd: '/A', subagent: { parentSessionId: 'sA' } })
  fixture(t, 'zh', null, { sessions: s.runtime })

  s.manager.handleSessionRemoved('sCold')
  assert.equal(cold.removed, true)
  s.manager.handleSessionAdded({
    sessionId: 'sCold',
    cwd: '/B',
    agentAvailable: false,
    projections: { kind: 'cached', values: { title: 'Original', workingDirectory: '/B' } },
  })
  assert.equal(cold.removed, false)
  assert.equal(cold.resyncCount, 0)
  assert.deepEqual(cold.projections.values(), { title: 'Original', workingDirectory: '/B' })

  s.manager.handleSessionAdded({ sessionId: 'sSub', cwd: '/B', agentAvailable: false })
  await setImmediate()
  assert.equal(openSub.resyncCount, 1)
  assert.equal(openSub.removed, false)
  assert.deepEqual(openSub.projections.values(), { title: 'Original', workingDirectory: '/B' })
})
