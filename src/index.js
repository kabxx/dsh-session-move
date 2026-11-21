import { createSessionMove } from './move.js'
import { storagePaths } from './config.js'

export const inject = [
  'connection', 'workspaceRegistry', 'sessions', 'agents', 'sessionController', 'sessionPersistence', 'sessionProjections', 'dshHomePath', 'sessionMoveRecovery',
]

export function apply(ctx) {
  const move = createSessionMove(ctx, storagePaths(ctx))
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/session-move/session',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: move,
  }))
}
