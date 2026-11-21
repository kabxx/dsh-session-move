import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rm, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import { readMoveEvents } from './inbox.js'
import { encodeSegment, LOCK_FILENAME, LOG_FILENAME, sessionDir } from './paths.js'
import { fail } from './plan.js'
import { acquirePathLock, acquireWindowsLock, assertPlainWindowsPath, publishPath, restorePath, syncDirectory } from './platform-fs.js'
import { readHeader, rewriteHeaderCwd, scanFrames } from './zstd-frame.js'

const windows = process.platform === 'win32'
const journalName = 'move-intent.json'
const checksum = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const isTicket = (value) => typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u.test(value)
const isHash = (value) => typeof value === 'string' && /^[\da-f]{64}$/u.test(value)

export async function lookup(path) {
  try { return await lstat(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function directory(path, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lookup(path)
  const actual = info?.isDirectory() && await realpath(path)
  const normalize = (value) => windows ? value.toLowerCase() : value
  if (!actual || normalize(actual) !== normalize(resolve(path))) throw fail('unsafe-path')
  assertPlainWindowsPath(path)
  return info
}

async function plainFile(path) {
  const info = await lookup(path)
  if (!info?.isFile() || info.nlink !== 1) throw fail('unsafe-path')
  assertPlainWindowsPath(path)
}

async function writeDurably(path, bytes) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    await publishPath(temporary, path, { replace: true })
    await syncDirectory(dirname(path))
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

async function renameDurably(from, to) {
  try { await restorePath(from, to) } catch (error) {
    if (error.code === 'EXDEV') throw fail('cross-device', error)
    throw error
  }
  await syncDirectory(dirname(from))
  if (dirname(to) !== dirname(from)) await syncDirectory(dirname(to))
}

// Match DSH's canonical positive version numbers and untagged generation zero.
function generation(name) {
  const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/u.exec(name)
  if (!match) return
  const version = Number(match[1] ?? 0)
  if (Number.isSafeInteger(version)) return { version, compressed: Boolean(match[2]) }
}

function isShadow(name) {
  const log = generation(name)
  return log?.compressed && log.version < 4
}

// The native reader selects v4 in a directory with older compressed generations.
// Preserve the historical artifacts but reject unsafe files and unsupported encodings.
async function validateTree(path, shadows = undefined) {
  await directory(path)
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (shadows && generation(entry.name)) {
      if (entry.name !== LOG_FILENAME && !isShadow(entry.name)) throw fail('unsupported')
      await plainFile(child)
      if (entry.name !== LOG_FILENAME) shadows.push(entry.name)
    } else if (entry.isDirectory()) await validateTree(child)
    else await plainFile(child)
  }
}

function hasPublishedPrefix(bytes, member) {
  if (member.nextBytes !== undefined) {
    return bytes.length >= member.nextBytes && digest(bytes.subarray(0, member.nextBytes)) === member.nextHash
  }
  if (digest(bytes) === member.nextHash) return true
  // Older journals recorded only the hash. Native appends start a new frame, so
  // one of the complete frame boundaries must match the published transcript.
  const hash = createHash('sha256')
  for (const { start, end } of scanFrames(bytes).frames) {
    hash.update(bytes.subarray(start, end))
    if (hash.copy().digest('hex') === member.nextHash) return true
  }
  return false
}

async function syncTree(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) await syncTree(child)
    else if (entry.name !== LOCK_FILENAME) {
      const file = await open(child, 'r+')
      try { await file.sync() } finally { await file.close() }
    }
  }
  await syncDirectory(path)
}

export function moveStorage(root, base, { checkpoint = async () => {} } = {}) {
  const journal = join(base, journalName)
  const backups = join(base, 'backups')

  function ticketDir(ticket) {
    if (!isTicket(ticket)) throw fail('unsafe-path')
    return join(backups, ticket)
  }

  function paths(state, member) {
    if (typeof member?.id !== 'string' || !member.id || typeof member.oldCwd !== 'string' || !member.oldCwd
      || typeof state.targetCwd !== 'string' || !state.targetCwd) throw fail('unsafe-path')
    const ticket = ticketDir(state.ticket)
    const name = encodeSegment(member.id)
    const oldDir = sessionDir(root, member.oldCwd, member.id)
    const nextDir = sessionDir(root, state.targetCwd, member.id)
    const unchanged = member.oldCwd === state.targetCwd
    const inPlace = !unchanged && oldDir === nextDir
    const shadows = member.shadows ?? []
    if (member.oldDir !== oldDir || member.nextDir !== nextDir || (!unchanged && !isHash(member.nextHash))
      || (inPlace && !isHash(member.oldHash)) || (member.oldHash !== undefined && !isHash(member.oldHash))
      || (member.nextBytes !== undefined && (!Number.isSafeInteger(member.nextBytes) || member.nextBytes <= 0))
      || (member.cwdChangeSeq !== undefined && (!Number.isSafeInteger(member.cwdChangeSeq) || member.cwdChangeSeq < 0))
      || !Array.isArray(shadows) || shadows.some((file) => typeof file !== 'string' || !isShadow(file))
      || new Set(shadows).size !== shadows.length || ((inPlace || unchanged) && shadows.length)) throw fail('unsafe-path')
    const stage = join(ticket, 'staged', name)
    return {
      id: member.id, oldDir, nextDir, unchanged, inPlace, shadows,
      oldFile: join(oldDir, LOG_FILENAME), nextFile: join(nextDir, LOG_FILENAME),
      stage, stageFile: join(stage, LOG_FILENAME), held: join(ticket, 'held', name),
      originalFile: join(ticket, 'original', name, LOG_FILENAME),
      heldShadows: join(ticket, 'held-shadows', name),
    }
  }

  async function hasJournal() {
    return Boolean(await lookup(journal))
  }

  async function readState() {
    if (!await hasJournal()) return
    await plainFile(journal)
    const state = JSON.parse(await readFile(journal, 'utf8'))
    if (state?.version !== 2 || !isTicket(state.ticket) || !['prepared', 'committed', 'rolled-back'].includes(state.phase)
      || !Array.isArray(state.members) || state.members.length === 0
      || new Set(state.members.map((member) => member?.id)).size !== state.members.length || !state.ledger) throw fail('restore-pending')
    state.members.forEach((member) => paths(state, member))
    return state
  }

  async function hasHeld(state) {
    for (const member of state.members) {
      const p = paths(state, member)
      if (p.unchanged) continue
      if (p.inPlace) {
        if (!await lookup(p.stageFile)) return true
      } else {
        if (await lookup(p.held)) return true
        for (const name of p.shadows) {
          if (await lookup(join(p.heldShadows, name))) return true
        }
      }
    }
    return false
  }

  async function withLock(run) {
    await directory(base, true)
    const { handle } = await acquirePathLock(join(base, 'move.lock'))
    try { return await run() } finally { await handle.close() }
  }

  async function save(state) {
    await writeDurably(journal, JSON.stringify(state))
  }

  async function removeTicket(ticket) {
    const target = ticketDir(ticket)
    if (await lookup(target)) {
      await directory(target)
      await rm(target, { recursive: true })
      await syncDirectory(backups)
    }
  }

  async function finish(state) {
    await removeTicket(state.ticket)
    await unlink(journal)
    await syncDirectory(base)
  }

  async function withSessionLocks(plan, run, { recovery = false } = {}) {
    const handles = []
    const lock = async (path, future = false) => {
      const result = future && windows ? acquireWindowsLock(path) : await acquirePathLock(path)
      handles.push(result.handle)
    }
    try {
      // Keep the source directory (including its lock inode) in place while we
      // hide and restore its log. A queued writer therefore cannot reopen it.
      for (const member of plan.members) {
        const { oldDir, nextDir } = member
        if (await lookup(oldDir)) {
          await directory(oldDir)
          await lock(join(oldDir, LOCK_FILENAME))
        } else if (!recovery) throw fail('changed')
        if (oldDir === nextDir) continue
        if (await lookup(nextDir)) {
          if (!recovery) throw fail('collision')
          await directory(nextDir)
          await lock(join(nextDir, LOCK_FILENAME))
        } else if (windows) {
          await lock(join(nextDir, LOCK_FILENAME), true)
        }
      }
      return await run(async (stage) => {
        if (!windows) await lock(join(stage, LOCK_FILENAME))
      })
    } finally {
      for (const handle of handles.reverse()) await handle.close()
    }
  }

  async function prepare(ctx, plan, ledger, lockStage) {
    // Check every family member under the native write leases before making
    // any backup. The event snapshots also determine the next sequence number.
    const cwdChangeSeqs = new Map()
    for (const member of plan.members) {
      const events = await readMoveEvents(ctx, member)
      if (member.oldCwd !== plan.targetCwd) cwdChangeSeqs.set(member.id, (events.at(-1)?.seq ?? -1) + 1)
    }

    const ticket = randomUUID()
    const home = ticketDir(ticket)
    const state = { version: 2, ticket, phase: 'prepared', ...plan, ledger, members: [] }
    const privateDirectories = ['original', 'staged', 'held', 'held-shadows']
    await directory(root)
    await directory(backups, true)
    await mkdir(home, { mode: 0o700 })
    try {
      for (const sub of privateDirectories) await directory(join(home, sub), true)
      for (const member of plan.members) {
        const { id, oldCwd, oldDir, oldFile, nextDir } = member
        if (oldDir !== sessionDir(root, oldCwd, id) || oldFile !== join(oldDir, LOG_FILENAME)
          || nextDir !== sessionDir(root, plan.targetCwd, id)) throw fail('unsupported')
        const entry = { id, oldCwd, oldDir, nextDir }
        if (oldCwd === plan.targetCwd) {
          state.members.push(entry)
          continue
        }
        const inPlace = oldDir === nextDir
        await directory(dirname(nextDir), true)
        await syncDirectory(root)
        if ((await directory(oldDir)).dev !== (await directory(home)).dev
          || (await directory(dirname(nextDir))).dev !== (await directory(home)).dev) throw fail('cross-device')
        if (!inPlace && await lookup(nextDir)) throw fail('collision')
        const shadows = []
        await validateTree(oldDir, shadows)
        const name = encodeSegment(id)
        const original = join(home, 'original', name)
        const stage = join(home, 'staged', name)
        const copyOptions = { recursive: true, force: false, errorOnExist: true, filter: (source) => source !== join(oldDir, LOCK_FILENAME) }
        await cp(oldDir, original, copyOptions)
        await syncTree(original)
        if (inPlace) await directory(stage, true)
        else await cp(original, stage, { recursive: true, force: false, errorOnExist: true })
        const bytes = await readFile(join(original, LOG_FILENAME))
        const scan = scanFrames(bytes)
        const header = readHeader(bytes)
        if (scan.tornStart !== undefined || header.id !== id || header.cwd !== oldCwd) throw fail('unsupported')
        const cwdChangeSeq = cwdChangeSeqs.get(id)
        // DSH turns this event into native runtime context on the next request.
        const cwdChange = {
          type: 'working-directory/change', seq: cwdChangeSeq, time: Date.now(), data: { cwd: plan.targetCwd },
        }
        const next = Buffer.concat([rewriteHeaderCwd(bytes, plan.targetCwd), zstdCompressSync(
          JSON.stringify(cwdChange) + '\n', checksum,
        )])
        await writeDurably(join(stage, LOG_FILENAME), next)
        if (!inPlace) {
          await lockStage(stage)
          if (shadows.length) {
            const holding = join(home, 'held-shadows', name)
            await directory(holding, true)
            await syncDirectory(holding)
          }
        }
        await syncTree(stage)
        state.members.push({
          ...entry, oldHash: digest(bytes), nextHash: digest(next), nextBytes: next.length,
          cwdChangeSeq, ...(!inPlace && shadows.length ? { shadows } : {}),
        })
      }
      for (const path of privateDirectories) await syncDirectory(join(home, path))
      await syncDirectory(home)
      await syncDirectory(backups)
      return state
    } catch (error) {
      await removeTicket(ticket).catch(() => {})
      throw error
    }
  }

  async function publish(state) {
    for (const member of state.members) {
      const p = paths(state, member)
      if (p.unchanged) continue
      await plainFile(p.oldFile)
      if (p.inPlace) {
        if (digest(await readFile(p.oldFile)) !== member.oldHash) throw fail('changed')
        // The original remains visible until a single replace publishes the new
        // log. Both headers derive the same physical path, and the lease stays put.
        await publishPath(p.stageFile, p.oldFile, { replace: true })
        await syncDirectory(p.stage)
        await syncDirectory(p.oldDir)
      } else {
        if (await lookup(p.nextDir)) throw fail('collision')
        // Keep the selected generation visible until its shadows are hidden.
        // Otherwise native lookup might select a historical source generation.
        for (const name of p.shadows) {
          await renameDurably(join(p.oldDir, name), join(p.heldShadows, name))
          await checkpoint('shadow-hidden', member)
        }
        await renameDurably(p.oldFile, p.held)
        await checkpoint('source-hidden', member)
        if ((await readdir(p.oldDir)).some(generation)) throw fail('changed')
        await renameDurably(p.stage, p.nextDir)
      }
      await checkpoint('destination-published', member)
    }
  }

  async function rollback(state) {
    const actions = []
    // Preflight under all native leases. A changed log in one member must not
    // leave the family split by undoing a different member first.
    for (const member of [...state.members].reverse()) {
      const p = paths(state, member)
      if (p.unchanged) continue
      if (p.inPlace) {
        await plainFile(p.oldFile)
        if (await lookup(p.stageFile)) continue
        const current = digest(await readFile(p.oldFile))
        if (current === member.oldHash) continue
        // Do not overwrite a log that acquired additional entries after publish.
        if (current !== member.nextHash) throw fail('changed')
        await plainFile(p.originalFile)
        const original = await readFile(p.originalFile)
        if (digest(original) !== member.oldHash) throw fail('changed')
        actions.push(() => writeDurably(p.oldFile, original))
        continue
      }
      if (await lookup(p.held)) {
        if (await lookup(p.oldFile)) throw fail('restore-pending')
        if (!await lookup(p.stage)) {
          await directory(p.nextDir)
          await plainFile(p.nextFile)
          if (digest(await readFile(p.nextFile)) !== member.nextHash) throw fail('changed')
          actions.push(() => renameDurably(p.nextDir, p.stage))
        }
        await plainFile(p.held)
        if (member.oldHash && digest(await readFile(p.held)) !== member.oldHash) throw fail('changed')
        actions.push(() => renameDurably(p.held, p.oldFile))
      } else {
        // The source was never hidden, or a prior recovery put it back.
        await plainFile(p.oldFile)
      }
      for (const name of p.shadows) {
        const shadow = join(p.heldShadows, name)
        const original = join(p.oldDir, name)
        if (await lookup(shadow)) {
          await plainFile(shadow)
          if (await lookup(original)) throw fail('changed')
          actions.push(() => renameDurably(shadow, original))
        }
      }
    }
    for (const action of actions) await action()
  }

  async function verifyPublished(state) {
    for (const member of state.members) {
      const p = paths(state, member)
      if (p.unchanged) continue
      if (await lookup(p.inPlace ? p.stageFile : p.stage)) throw fail('changed')
      await directory(p.nextDir)
      await plainFile(p.nextFile)
      if (!hasPublishedPrefix(await readFile(p.nextFile), member)) throw fail('changed')
    }
  }

  async function cleanCommitted(state) {
    for (const member of state.members) {
      const p = paths(state, member)
      await directory(p.nextDir)
      await plainFile(p.nextFile)
      if (p.unchanged || p.inPlace || !await lookup(p.oldDir)) continue
      await directory(p.oldDir)
      if ((await readdir(p.oldDir)).some(generation)) throw fail('changed')
      await rm(p.oldDir, { recursive: true })
      await syncDirectory(dirname(p.oldDir))
    }
    await finish(state)
  }

  return {
    hasJournal, readState, hasHeld, withLock, save, finish, withSessionLocks, prepare, publish, rollback, verifyPublished, cleanCommitted,
  }
}

/** Recover v0.1.0's incorrectly located log using the newest live file. */
export async function recoverLegacyDisk(root, base) {
  const journal = join(base, journalName)
  if (!await lookup(journal)) return
  await directory(base)
  await plainFile(journal)
  const state = JSON.parse(await readFile(journal, 'utf8'))
  if (state?.version !== 1 || !isTicket(state.ticket)) throw fail('restore-pending')
  if (state.phase === 'committed') return
  if (state.phase !== 'prepared' || !Array.isArray(state.members) || !state.members.length) throw fail('restore-pending')
  const holding = join(base, 'backups', state.ticket, 'legacy-recovery')
  await directory(holding, true)
  await syncDirectory(dirname(holding))
  for (const { id, oldCwd, oldDir, nextDir, oldFile, nextFile } of state.members) {
    if (typeof id !== 'string' || typeof oldCwd !== 'string' || typeof nextDir !== 'string') throw fail('unsafe-path')
    const escaped = encodeSegment(id)
    if (oldDir !== sessionDir(root, oldCwd, id) || oldFile !== join(oldDir, LOG_FILENAME)
      || dirname(dirname(nextDir)) !== root || !/^--.+--$/u.test(basename(dirname(nextDir)))
      || basename(nextDir) !== escaped || nextFile !== join(nextDir, LOG_FILENAME) || oldDir === nextDir) throw fail('unsafe-path')
    const held = join(holding, escaped)
    if (await lookup(oldDir)) {
      if (await lookup(nextDir) || await lookup(held)) throw fail('restore-pending')
      await plainFile(oldFile)
      continue
    }
    await directory(dirname(oldDir), true)
    if (!await lookup(held)) {
      await directory(nextDir)
      await plainFile(nextFile)
      await renameDurably(nextDir, held)
    }
    const file = join(held, LOG_FILENAME)
    await directory(held)
    await plainFile(file)
    const bytes = await readFile(file)
    if (readHeader(bytes).id !== id) throw fail('changed')
    await writeDurably(file, rewriteHeaderCwd(bytes, oldCwd))
    await renameDurably(held, oldDir)
  }
  // Keep the v0.1.0 backup for manual inspection. Its ledger order was not journaled.
  await renameDurably(journal, join(base, `recovered-${state.ticket}.json`))
}
