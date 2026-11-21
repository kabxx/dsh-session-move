window.__ModuleLoader__.load({
  id: '@kabxx/dsh-session-move',
  factory(require) {
    const { useSyncExternalStore } = require('react')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')
    const namespace = 'sessionMove'
    const strings = {
      zh: {
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
        'restore-pending': '移动中断，会话待自动恢复，请稍后重试。',
        'cleanup-pending': '上一次移动仍在清理中，请稍后重试。',
        failed: '移动失败，请重试。',
      },
      en: {
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
        'restore-pending': 'The move was interrupted. Automatic restoration is pending; try again shortly.',
        'cleanup-pending': 'A previous move is still finishing cleanup. Try again shortly.',
        failed: 'Failed to move the session. Try again.',
      },
    }
    const known = new Set([
      'busy', 'locked', 'missing', 'target-missing', 'target-not-canonical', 'same-workspace', 'stale-source',
      'collision', 'changed', 'unsupported', 'restore-pending', 'cleanup-pending',
      'archived', 'subagent', 'unsafe-path', 'cross-device', 'restored', 'forbidden',
    ])
    const ROW_KEY = 'data-row-key'
    const WORKSPACE_PREFIX = 'workspace:'
    const SESSION_PREFIX = 'session:'

    return {
      inject: ['locale', 'slots', 'workspaces'],
      apply(ctx) {
        const t = ctx.locale.bind(namespace)
        const toast = createSnapshotStore(null)
        const lifetime = new AbortController()
        let sequence = 0
        let dragging = null
        let highlighted = null
        let savedStyle = null

        function notify(key, tone = 'warning', values) {
          toast.set({ key, tone, values, seq: ++sequence })
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
          if (!id || id === active.sourceWorkspaceId) return null
          const snapshot = ctx.workspaces.list.getSnapshot()
          if (snapshot.archivedSessionIds.includes(active.id)) return null
          const workspace = snapshot.items.find((item) => item.workspaceId === id)
          return workspace === undefined ? null : { row, workspace }
        }

        async function perform(sessionId, targetWorkspaceId, sourceWorkspaceId, title) {
          try {
            const response = await fetch('/api/session-move/session', {
              method: 'POST',
              credentials: 'same-origin',
              signal: lifetime.signal,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId, targetWorkspaceId, sourceWorkspaceId }),
            })
            const result = await response.json().catch(() => null)
            if (lifetime.signal.aborted) return
            if (!response.ok || result?.error || result?.moved !== true) {
              const code = result?.error
              if (known.has(code)) throw new Error(code)
              if (response.status === 401 || response.status === 403) throw new Error('forbidden')
              throw new Error('failed')
            }
            if (result.sidebarPending) notify('sidebar-pending')
            else if (result.cleanupPending) notify('pending')
            else notify('moved', 'success', { title: title ?? '' })
          } catch (error) {
            if (lifetime.signal.aborted) return
            notify(known.has(error.message) ? error.message : 'failed')
          }
        }

        function onDragStart(event) {
          clearDrag()
          const row = closestRow(event.target)
          const key = row?.getAttribute(ROW_KEY)
          if (!key?.startsWith(SESSION_PREFIX) || row.draggable !== true) return
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
          if (!current) return null
          return renderFactorySlot('workspace.toast.content', {
            seq: current.seq,
            text: t(current.key, current.values),
            tone: current.tone,
            onDone: () => {
              if (toast.getSnapshot() === current) toast.set(null)
            },
          })
        }

        ctx.effect(() => () => lifetime.abort())
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

        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'session-move.toast', locale: namespace,
        }, MoveToast)))
      },
    }
  },
})
