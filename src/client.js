window.__ModuleLoader__.load({
  id: '@kabxx/dsh-session-move',
  factory(require) {
    const { createElement, Fragment, useSyncExternalStore } = require('react')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')
    const namespace = 'sessionMove'
    const strings = {
      zh: {
        moving: '正在移动会话…',
        moved: '会话已移动到“{title}”',
        pending: '会话已移动，后续清理待完成。',
        'sidebar-pending': '会话已移动，侧栏暂未同步，请刷新页面。',
        busy: '会话正在运行或还有待处理指令，暂时无法移动。',
        locked: '会话正被占用，暂时无法移动。',
        archived: '会话已归档，请先取消归档。',
        subagent: '子智能体会话随父会话一起移动，无法单独移动。',
        'unsafe-path': '会话存储路径异常，无法安全移动。',
        'cross-device': '源会话与目标会话目录不在同一个文件系统，无法安全移动。',
        restored: '移动失败，会话记录已恢复到原目录。',
        forbidden: '当前连接无权移动会话。',
        missing: '未找到该会话。',
        'target-missing': '目标工作区目录不存在。',
        'target-not-canonical': '目标工作区路径不是规范路径，无法移入会话。',
        'same-workspace': '会话已经在该工作区中。',
        'stale-source': '会话所在工作区已变更，请从侧栏新位置重新拖动。',
        collision: '目标工作区中已存在同名会话记录。',
        changed: '会话状态已变更，请重试。',
        unsupported: '当前存储方式不支持移动会话。',
        'disk-space': '磁盘空间不足，无法暂存本次移动的日志、附件和备份。',
        'family-limit': '一次最多移动 128 个会话（含子智能体会话）。',
        'history-timeout': '移动准备超时（超过 180 秒），会话保留在原工作区。',
        'history-cancelled': '已取消移动准备。',
        'history-resource': '会话历史检查超出资源上限，无法安全移动。',
        'history-invalid': '会话或子智能体会话的历史记录未通过校验，无法移动。',
        'history-isolation-unavailable': '当前环境无法启动带内存限制的会话检查进程。',
        'history-busy': '已有其他会话移动正在检查中，请稍后重试。',
        'restore-pending': '移动中断，会话待自动恢复，请稍后重试。',
        'cleanup-pending': '上一次移动仍在清理中，请稍后重试。',
        failed: '移动失败，请重试。',
      },
      en: {
        moving: 'Moving session…',
        moved: 'Session moved to “{title}”',
        pending: 'Session moved; follow-up cleanup is still pending.',
        'sidebar-pending': 'Session moved, but the sidebar did not update. Refresh the page.',
        busy: 'Session is running or has pending instructions. It cannot be moved yet.',
        locked: 'Session is in use and cannot be moved right now.',
        archived: 'Unarchive this session before moving it.',
        subagent: 'Subagent sessions move with their parent and cannot be moved separately.',
        'unsafe-path': 'The session storage path cannot be moved safely.',
        'cross-device': 'The source and destination session directories are on different filesystems.',
        restored: 'The move failed. The session record was restored to its original location.',
        forbidden: 'This connection cannot move sessions.',
        missing: 'Session not found.',
        'target-missing': 'The target workspace directory is missing.',
        'target-not-canonical': 'The target workspace path is not canonical and cannot receive moved sessions.',
        'same-workspace': 'The session is already in that workspace.',
        'stale-source': 'The session’s workspace has changed. Drag it again from its new location.',
        collision: 'The target workspace already holds a record for this session.',
        changed: 'Session state changed. Try again.',
        unsupported: 'Moving sessions is not supported for this storage.',
        'disk-space': 'There is not enough disk space to stage the logs, attachments, and backups.',
        'family-limit': 'You can move up to 128 sessions at once, including subagent sessions.',
        'history-timeout': 'Move preparation timed out after 180 seconds. The session remains in its original workspace.',
        'history-cancelled': 'Move preparation was cancelled.',
        'history-resource': 'The session history check exceeded its resource limit.',
        'history-invalid': 'The session or a subagent session failed history validation and cannot be moved.',
        'history-isolation-unavailable': 'This environment could not start a memory-limited session history worker.',
        'history-busy': 'Another session move is being checked. Try again shortly.',
        'restore-pending': 'The move was interrupted. Automatic restoration is pending; try again shortly.',
        'cleanup-pending': 'A previous move is still finishing cleanup. Try again shortly.',
        failed: 'Failed to move the session. Try again.',
      },
    }
    const known = new Set([
      'busy', 'locked', 'missing', 'target-missing', 'target-not-canonical', 'same-workspace', 'stale-source',
      'collision', 'changed', 'unsupported', 'restore-pending', 'cleanup-pending',
      'archived', 'subagent', 'unsafe-path', 'cross-device', 'restored', 'forbidden', 'disk-space', 'family-limit',
      'history-timeout', 'history-cancelled', 'history-resource', 'history-invalid',
      'history-isolation-unavailable', 'history-busy',
    ])
    const ROW_KEY = 'data-row-key'
    const WORKSPACE_PREFIX = 'workspace:'
    const SESSION_PREFIX = 'session:'
    const LIST_AREA = '[data-sidebar-list-area]'
    const TREE_ROLE = '[role="tree"]'
    const WORKSPACE_ROW = `[${ROW_KEY}^="${WORKSPACE_PREFIX}"]`
    const original = Symbol.for('cordis.original')

    function replaceMethod(object, key, next) {
      const previous = Object.getOwnPropertyDescriptor(object, key)
      Object.defineProperty(object, key, { configurable: true, writable: true, value: next })
      return () => {
        if (object[key] !== next) return
        if (previous) Object.defineProperty(object, key, previous)
        else delete object[key]
      }
    }

    function sessionRuntime(ctx) {
      const service = ctx.get('sessions')
      return service?.[original] ?? service
    }

    function sessionView(sessions, sessionId) {
      const binding = sessions?.binding?.(sessionId)
      const session = binding?.session
      if (typeof session?.resync !== 'function' || typeof session.getSnapshot !== 'function'
        || typeof session.projections?.clear !== 'function') return undefined
      return binding
    }

    function rebindComposerAttachments(binding) {
      const conversation = binding.ctx?.get?.('conversation')
      if (typeof conversation?.rebindDraftFiles !== 'function') return
      const input = conversation.input?.for?.(binding.ctx)
      const attachmentIds = input?.state?.getSnapshot?.()?.attachmentIds
      if (Array.isArray(attachmentIds) && attachmentIds.length > 0) {
        // Reuse the browser File objects and draft IDs so upload receipts scoped
        // to the disposed Agent are replaced for the reopened Session.
        conversation.rebindDraftFiles(binding.sessionId, attachmentIds, binding.session.getSnapshot().subagent === null)
      }
    }

    function clearSessionProjections(manager, sessionId, projections) {
      manager.projectionInflight?.get(sessionId)?.controller?.abort?.()
      manager.projectionInflight?.delete(sessionId)
      manager.projectionLoads?.delete(sessionId)
      projections?.clear?.()
    }

    function watchSessionViews(sessions) {
      const manager = sessions?.manager
      const remove = manager?.handleSessionRemoved
      const add = manager?.handleSessionAdded
      if (typeof remove !== 'function' || typeof add !== 'function') return undefined
      const transitions = new WeakMap()
      let disposed = false

      const transitionFor = (binding) => {
        let transition = transitions.get(binding)
        if (!transition) {
          transition = { removal: 0, scheduled: -1, work: Promise.resolve() }
          transitions.set(binding, transition)
        }
        return transition
      }

      const undoRemove = replaceMethod(manager, 'handleSessionRemoved', function (id) {
        const binding = sessionView(sessions, id)
        const transition = binding && transitions.get(binding)
        if (transition) transition.removal++
        return remove.call(this, id)
      })

      let undoAdd
      try {
        undoAdd = replaceMethod(manager, 'handleSessionAdded', function (summary) {
          const id = summary.sessionId
          const binding = sessionView(sessions, id)
          const session = binding?.session
          const snapshotBefore = session?.getSnapshot()
          const wasRemoved = Boolean(snapshotBefore?.removed)
          const previousCwd = Array.isArray(manager.summaries)
            ? manager.summaries.find((item) => item.sessionId === id)?.cwd
            : undefined
          const activeTransition = binding && transitions.get(binding)
          const resyncInFlight = activeTransition !== undefined && activeTransition.scheduled === activeTransition.removal
          if (!disposed && wasRemoved) {
            // Native removal deletes the Manager's projection map entry while the
            // retained Session keeps its store. Rejoin and drop stale sequenced
            // entries before the replacement summary lands.
            if (manager.projectionStores?.get(id) !== session.projections) {
              manager.projectionStores?.set(id, session.projections)
            }
            if (!resyncInFlight) clearSessionProjections(manager, id, session.projections)
          }
          const result = add.call(this, summary)
          if (disposed || !binding) return result

          if (wasRemoved && session.removed === true && typeof session.notifier?.markDirty === 'function') {
            if (session.getSnapshot().openState === 'cold' && !resyncInFlight) {
              session.removed = false
              session.notifier.markDirty()
              return result
            }
            const transition = transitionFor(binding)
            const removal = transition.removal
            if (transition.scheduled === removal) return result
            transition.scheduled = removal
            const current = () => !disposed && sessions.binding(id) === binding && transition.removal === removal
            transition.work = transition.work.then(async () => {
              if (!current()) return
              rebindComposerAttachments(binding)
              manager.projectionInflight?.get(id)?.controller?.abort?.()
              manager.projectionInflight?.delete(id)
              manager.projectionLoads?.delete(id)
              await binding.session.resync()
              if (!current() || session.getSnapshot().openState !== 'open') return
              // rc.5's native removal flag is one-way on a retained Session.
              session.removed = false
              session.notifier.markDirty()
            }).catch(() => {
              // Keep the session unavailable on sync failure so a later addition can retry.
            }).finally(() => {
              if (transition.scheduled === removal) transition.scheduled = -1
            })
            return result
          }

          if (!wasRemoved && snapshotBefore?.openState === 'open' && previousCwd && summary.cwd && previousCwd !== summary.cwd) {
            const transition = transitionFor(binding)
            const removal = transition.removal
            const current = () => !disposed && sessions.binding(id) === binding && transition.removal === removal
            transition.work = transition.work.then(async () => {
              if (!current() || session.getSnapshot().removed || session.getSnapshot().openState !== 'open') return
              clearSessionProjections(manager, id, session.projections)
              await binding.session.resync()
            }).catch(() => {})
          }
          return result
        })
      } catch (error) {
        undoRemove()
        throw error
      }

      return {
        dispose() {
          disposed = true
          undoAdd()
          undoRemove()
        },
      }
    }
    const progressStyles = `
      .kabxx-session-move-progress {
        position: fixed;
        top: 40px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 1100;
        display: flex;
        align-items: center;
        gap: 10px;
        box-sizing: border-box;
        width: max-content;
        max-width: min(640px, calc(100vw - 48px));
        padding: 12px 16px;
        border-radius: var(--dsw-radius-lg);
        background: var(--dsw-alias-toast-bg);
        color: var(--dsw-alias-toast-label);
        box-shadow: var(--dsw-shadow-lv3);
        font-size: 14px;
        line-height: 22px;
      }
      /* DSH StateDot (ongoing), scoped to this slot. */
      .kabxx-session-move-spinner {
        flex: none;
        color: var(--dsw-alias-toast-action);
      }
      .kabxx-session-move-spinner-motion {
        transform-origin: center;
        animation: kabxx-session-move-spin 1.5s linear infinite;
      }
      .kabxx-session-move-spinner-track,
      .kabxx-session-move-spinner-arc {
        fill: none;
        stroke: currentColor;
        stroke-width: 2;
        stroke-linecap: round;
      }
      .kabxx-session-move-spinner-track { opacity: 0.25; }
      .kabxx-session-move-spinner-arc {
        stroke-dasharray: 12 150;
        animation: kabxx-session-move-dash 1.5s ease-in-out infinite;
      }
      @keyframes kabxx-session-move-spin { to { transform: rotate(360deg); } }
      @keyframes kabxx-session-move-dash {
        0%, 100% { stroke-dasharray: 12 150; stroke-dashoffset: 0; }
        50% { stroke-dasharray: 24 150; stroke-dashoffset: -6; }
      }
      @media (prefers-reduced-motion: reduce) {
        .kabxx-session-move-spinner-motion,
        .kabxx-session-move-spinner-arc { animation: none; }
        .kabxx-session-move-spinner-arc { stroke-dasharray: 18 150; stroke-dashoffset: -3; }
      }
    `

    function syncSpinner(node) {
      for (const animation of node?.getAnimations?.({ subtree: true }) ?? []) animation.startTime = 0
    }

    function MoveSpinner() {
      return createElement('svg', {
        ref: syncSpinner,
        onAnimationStart: (event) => syncSpinner(event.currentTarget),
        className: 'kabxx-session-move-spinner',
        'data-state': 'ongoing',
        width: 18,
        height: 18,
        viewBox: '0 0 24 24',
        'aria-hidden': true,
      }, createElement('g', { className: 'kabxx-session-move-spinner-motion' },
        createElement('circle', { className: 'kabxx-session-move-spinner-track', cx: 12, cy: 12, r: 9.5 }),
        createElement('circle', { className: 'kabxx-session-move-spinner-arc', cx: 12, cy: 12, r: 9.5 }),
      ))
    }

    return {
      inject: ['locale', 'slots', 'workspaces'],
      apply(ctx) {
        const t = ctx.locale.bind(namespace)
        const toast = createSnapshotStore(null)
        const lifetime = new AbortController()
        const inFlight = new Set()
        const notices = []
        let sequence = 0
        let dragging = null
        let highlighted = null
        let savedStyle = null

        function setToast(value) {
          try {
            toast.set(value)
          } catch (error) {
            console.warn('[dsh-session-move] Failed to update move feedback', error)
          }
        }

        function showNextToast(advance = false) {
          const current = toast.getSnapshot()
          if (!advance && current !== null && current.key !== 'moving') return
          if (notices.length) setToast({ ...notices.shift(), seq: ++sequence })
          else if (inFlight.size > 0 && (advance || current === null)) {
            setToast({ key: 'moving' })
          } else if (advance) setToast(null)
        }

        function notify(key, tone = 'warning', values) {
          notices.push({ key, tone, values })
          showNextToast()
        }

        function clearHighlight() {
          if (highlighted === null) return
          highlighted.style.outline = savedStyle.outline
          highlighted.style.outlineOffset = savedStyle.outlineOffset
          highlighted = null
          savedStyle = null
        }

        function highlight(element) {
          if (highlighted === element) return
          clearHighlight()
          highlighted = element
          savedStyle = { outline: element.style.outline, outlineOffset: element.style.outlineOffset }
          // Match the native insertion marker's color while outlining the drop target.
          element.style.outline = '2px solid var(--dsw-alias-state-business-primary)'
          element.style.outlineOffset = '-2px'
        }

        function workspaceIdForSession(snapshot, sessionId) {
          return snapshot.items.find((item) => item.sessionIds.includes(sessionId))?.workspaceId ?? null
        }

        function closestRow(target) {
          return target instanceof Element ? target.closest(`[${ROW_KEY}]`) : null
        }

        function dropTarget(element, active) {
          const row = closestRow(element)
          const key = row?.getAttribute(ROW_KEY)
          // WorkspaceBrowser renders each folder as its own row. A session row
          // may follow nested folders in DOM order while belonging to the parent.
          if (!key?.startsWith(WORKSPACE_PREFIX)) return null
          const id = key.slice(WORKSPACE_PREFIX.length)
          // The ungrouped bucket is represented by `workspace:` with no id.
          if (!id || id === active.sourceWorkspaceId || inFlight.has(active.id)) return null
          const snapshot = ctx.workspaces.list.getSnapshot()
          if (snapshot.archivedSessionIds.includes(active.id)) return null
          const workspace = snapshot.items.find((item) => item.workspaceId === id)
          return workspace === undefined ? null : { row, workspace }
        }

        async function perform(sessionId, targetWorkspaceId, sourceWorkspaceId, title) {
          if (lifetime.signal.aborted || inFlight.has(sessionId)) return
          inFlight.add(sessionId)
          showNextToast()
          let outcome
          try {
            const response = await fetch('/api/session-move/session', {
              method: 'POST',
              credentials: 'same-origin',
              signal: lifetime.signal,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId, targetWorkspaceId, sourceWorkspaceId }),
            })
            const result = await response.json().catch(() => null)
            if (!response.ok || result?.error || result?.moved !== true) {
              const code = result?.error
              if (known.has(code)) throw new Error(code)
              if (response.status === 401 || response.status === 403) throw new Error('forbidden')
              throw new Error('failed')
            }
            outcome = result.sidebarPending ? 'sidebar-pending' : result.cleanupPending ? 'pending' : 'moved'
          } catch (error) {
            outcome = known.has(error?.message) ? error.message : 'failed'
          } finally {
            inFlight.delete(sessionId)
          }
          if (lifetime.signal.aborted) return
          if (outcome === 'moved') notify(outcome, 'success', { title: title ?? '' })
          else notify(outcome)
        }

        function dragContainer(row) {
          return row.closest?.(LIST_AREA) ?? row.closest?.(TREE_ROLE) ?? null
        }

        function inFlatList(row) {
          const container = dragContainer(row)
          return container !== null && typeof container.querySelector === 'function'
            && container.querySelector(WORKSPACE_ROW) === null
        }

        function onDragStart(event) {
          clearDrag()
          const row = closestRow(event.target)
          const key = row?.getAttribute(ROW_KEY)
          if (!key?.startsWith(SESSION_PREFIX) || row.draggable !== true) return
          // DSH's flat "In one list" view renders no workspace folder rows and
          // natively reorders sessions across workspaces.
          if (inFlatList(row)) return
          const id = key.slice(SESSION_PREFIX.length)
          const snapshot = ctx.workspaces.list.getSnapshot()
          if (!id || snapshot.archivedSessionIds.includes(id)) return
          // Preserve the source the user saw if another window moves the session
          // during the gesture. The Host checks it before applying the move.
          dragging = { id, sourceWorkspaceId: workspaceIdForSession(snapshot, id), row }
        }

        function onDragOver(event) {
          if (dragging === null) return
          const target = dropTarget(event.target, dragging)
          if (target === null) {
            clearHighlight()
            return
          }
          event.preventDefault()
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
          highlight(target.row)
        }

        function showDropEffect(event) {
          if (dragging === null || !event.dataTransfer || dropTarget(event.target, dragging)) return
          const key = closestRow(event.target)?.getAttribute(ROW_KEY)
          if (key?.startsWith(SESSION_PREFIX)) {
            const id = key.slice(SESSION_PREFIX.length)
            if (workspaceIdForSession(ctx.workspaces.list.getSnapshot(), id) === dragging.sourceWorkspaceId) return
          }
          // The native document listener accepts all drags so it can finish
          // its own sorting gesture. Keep the cross-workspace cursor accurate.
          event.dataTransfer.dropEffect = 'none'
        }

        function onDragLeave(event) {
          if (highlighted === null || closestRow(event.target) !== highlighted) return
          if (!(event.relatedTarget instanceof Node) || !highlighted.contains(event.relatedTarget)) clearHighlight()
        }

        function cancelNativeSort(active) {
          // DSH commits its last hover marker on dragend, even without a drop.
          // A drop on the source row settles the native drag without reordering.
          if (active.row.isConnected && active.row.getAttribute(ROW_KEY) === `${SESSION_PREFIX}${active.id}`) {
            active.row.dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true }))
          }
        }

        function onDrop(event) {
          const active = dragging
          if (active === null) return
          const target = dropTarget(event.target, active)
          const wasHighlighted = highlighted !== null && closestRow(event.target) === highlighted
          // Let DSH handle actual sort drops. Keep tracking the gesture so
          // dragend can discard any marker left by a rejected drop instead.
          if (target === null && !wasHighlighted) return
          clearDrag()
          event.preventDefault()
          event.stopPropagation()
          cancelNativeSort(active)
          if (target === null) {
            notify('changed')
            return
          }
          const { workspace } = target
          void perform(active.id, workspace.workspaceId, active.sourceWorkspaceId, workspace.title || workspace.path)
        }

        function clearDrag() {
          const active = dragging
          dragging = null
          clearHighlight()
          return active
        }

        function onDragEnd() {
          const active = clearDrag()
          // Capture runs before DSH's row-level dragend. If a valid sort drop
          // already committed, DSH ignores the redundant source-row drop.
          if (active !== null) cancelNativeSort(active)
        }

        function MoveToast({ t, renderFactorySlot }) {
          const current = useSyncExternalStore(toast.subscribe, toast.getSnapshot)
          const moving = current?.key === 'moving'
          const progress = createElement('div', { role: 'status', style: { pointerEvents: 'none' } },
            moving ? createElement('div', { className: 'kabxx-session-move-progress' },
              createElement('style', null, progressStyles),
              createElement(MoveSpinner),
              t(current.key, current.values),
            ) : null,
          )
          const outcome = current && !moving ? renderFactorySlot('workspace.toast.content', {
            seq: current.seq,
            text: t(current.key, current.values),
            tone: current.tone,
            onDone: () => {
              if (toast.getSnapshot() === current) showNextToast(true)
            },
          }) : null
          return createElement(Fragment, null, progress, outcome)
        }

        ctx.effect(() => () => {
          lifetime.abort()
          inFlight.clear()
          notices.length = 0
          setToast(null)
        })
        ctx.effect(() => ctx.locale.register(namespace, strings))

        ctx.effect(() => {
          const listeners = [
            ['dragstart', onDragStart, true],
            ['dragover', onDragOver, true],
            ['dragleave', onDragLeave, true],
            ['drop', onDrop, true],
            ['dragend', onDragEnd, true],
          ]
          for (const [type, listener, capture] of listeners) {
            document.addEventListener(type, listener, capture)
          }
          window.addEventListener('dragover', showDropEffect)
          return () => {
            window.removeEventListener('dragover', showDropEffect)
            for (const [type, listener, capture] of listeners) {
              document.removeEventListener(type, listener, capture)
            }
            clearDrag()
          }
        })

        if (typeof ctx.inject === 'function') {
          ctx.inject(['sessions'], (scoped) => scoped.effect(() => {
            const views = watchSessionViews(sessionRuntime(scoped))
            return () => { views?.dispose() }
          }))
        }

        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'session-move.toast', locale: namespace,
        }, MoveToast)))
      },
    }
  },
})
