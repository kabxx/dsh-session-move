import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { storagePaths } from '../../src/config.js'
import { createSessionMove } from '../../src/move.js'
import * as recovery from '../../src/recovery.js'

export const parent = 'session-parent'
export const child = 'session-parent:spawn:1.2'
export const title = (id, seq, text) => ({ type: 'session/title', seq, time: 1, data: { title: `${id}: ${text}`, source: { kind: 'user' }, messageSeqs: [] } })

export async function openHost(home, { recover = true, nativeSessions = false } = {}) {
  const req = createRequire(join(process.env.DSH_INSTALL_DIR, 'package.json'))
  const load = (name) => import(pathToFileURL(req.resolve(`@deepseek-ai/${name}`)).href)
  const [cordis, workspace, storage, json, persistence, projection, driver] = await Promise.all([
    load('cordis'), load('dsh-workspace'), load('dsh-storage-domain'), load('dsh-storage-json'), load('dsh-session-persistence-jsonl'),
    load('dsh-session-projection'), load('dsh-agent-loop'),
  ])
  const ctx = new cordis.Context()
  const backend = new json.JsonStorageBackend(join(home, 'storages'))
  ctx.provide('storage', { backend: { get: () => backend } })
  const facility = new storage.DomainFacility(ctx, { backend: 'json' })
  ctx.provide('storageDomain', facility)
  ctx.provide('dshHomePath', (...parts) => join(home, ...parts))
  const residentSessions = new Map()
  const residentAgents = new Map()
  if (nativeSessions) await ctx.plugin((await load('dsh-session')).SessionStore)
  else ctx.provide('sessions', { list: () => [...residentSessions.values()], get: (id) => residentSessions.get(id) })
  ctx.provide('agents', { get: (id) => residentAgents.get(id), setFactory: () => () => {} })
  ctx.provide('llm', {})
  ctx.provide('tools', {})
  ctx.provide('systemPrompt', { variable() {} })
  await ctx.plugin(projection.SessionProjectionRegistry)
  await ctx.plugin(driver.AgentLoop)
  const paths = storagePaths(ctx)
  const persistenceFiber = ctx.plugin(persistence, { root: paths.root, compression: 'zstd' })
  await persistenceFiber
  if (recover) {
    class RegistryWithGate extends workspace.WorkspaceRegistry {
      static inject = ['storageDomain', 'sessionPersistence', 'sessionMoveRecovery']
    }
    const registryFiber = ctx.plugin(RegistryWithGate)
    await ctx.plugin(recovery)
    await registryFiber
  } else {
    await ctx.plugin(workspace.WorkspaceRegistry)
  }
  if (!ctx.workspaceRegistry) throw new Error('workspace did not activate')
  return { ctx, ...paths, residentSessions, residentAgents, async close() {
    await ctx.fiber.dispose()
    await facility.closeAll()
    await backend.close()
  } }
}

export function request(workspaceId, sourceWorkspaceId) {
  return new Request('http://test.local/api/session-move/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: parent, targetWorkspaceId: workspaceId, sourceWorkspaceId }),
  })
}

if (process.argv[2] === 'crash') {
  const [, , , home, targetWorkspaceId, sourceWorkspaceId, failAt] = process.argv
  const host = await openHost(home)
  const move = createSessionMove(host.ctx, { ...host, activity: async () => [], checkpoint: async (step) => {
    if (step === failAt) process.exit(93)
  } })
  const response = await move(request(targetWorkspaceId, sourceWorkspaceId))
  console.error(response.status, await response.text())
  process.exit(2)
}
