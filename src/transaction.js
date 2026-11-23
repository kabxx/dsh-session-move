import { createHash, randomUUID } from 'node:crypto'
import { constants as fsFlags } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rm, statfs, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { constants, createZstdDecompress, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { assertPreparing, inspectMoveHistory } from './history.js'
import { encodeSegment, LOCK_FILENAME, LOG_FILENAME, sessionDir } from './paths.js'
import { fail } from './plan.js'
import { acquirePathLock, acquireWindowsLock, assertPlainWindowsPath, publishPath, restorePath, syncDirectory } from './platform-fs.js'
import { createFrameScanner } from './zstd-frame.js'

const windows = process.platform === 'win32'
const journalName = 'move-intent.json'
const checksum = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const chunkBytes = 128 * 1024
const tornBatchBytes = 512 * 1024
const maxHeaderBytes = 16 * 1024 * 1024
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
  const info = await lstat(path, { bigint: true }).catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
  if (!info?.isFile() || info.nlink !== 1n) throw fail('unsafe-path')
  assertPlainWindowsPath(path)
  return info
}

function sameRevision(left, right) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => left[key] === right[key])
}

async function withPlainInput(path, run) {
  const before = await plainFile(path)
  const file = await open(path, fsFlags.O_RDONLY | (fsFlags.O_NOFOLLOW ?? 0) | (fsFlags.O_NONBLOCK ?? 0))
  try {
    const opened = await file.stat({ bigint: true })
    const size = Number(opened.size)
    if (!opened.isFile() || opened.nlink !== 1n || !sameRevision(before, opened) || !Number.isSafeInteger(size)) {
      throw fail('changed')
    }
    const result = await run(file, size, opened)
    if (!sameRevision(opened, await plainFile(path))) throw fail('changed')
    return result
  } finally {
    await file.close()
  }
}

/** Chunks borrow one buffer. Use each chunk before advancing the iterator. */
async function* readChunks(file, size) {
  const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, size))
  let offset = 0
  while (offset < size) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - offset), offset)
    if (bytesRead === 0) throw fail('changed')
    offset += bytesRead
    yield buffer.subarray(0, bytesRead)
  }
}

async function digestFrom(file, size) {
  const hash = createHash('sha256')
  for await (const chunk of readChunks(file, size)) hash.update(chunk)
  return hash.digest('hex')
}

function digestFile(path) {
  return withPlainInput(path, digestFrom)
}

async function writeDurably(path, bytes) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    let result
    try {
      result = typeof bytes === 'function' ? await bytes(file) : await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    await publishPath(temporary, path, { replace: true })
    await syncDirectory(dirname(path))
    return result
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

function rewriteFirstFrame(frame, { id, oldCwd, targetCwd, allowTorn }) {
  let text
  let header
  let newline
  try {
    text = zstdDecompressSync(frame, { maxOutputLength: maxHeaderBytes }).toString('utf8')
    newline = text.indexOf('\n')
    header = JSON.parse(newline === -1 ? text : text.slice(0, newline))
  } catch (error) {
    throw fail('unsupported', error)
  }
  if (header?.type !== 'session' || header.id !== id || (oldCwd !== undefined && header.cwd !== oldCwd)) {
    throw fail(allowTorn ? 'changed' : 'unsupported')
  }
  if (header.cwd === targetCwd) return frame
  header.cwd = targetCwd
  return zstdCompressSync(JSON.stringify(header) + (newline === -1 ? '' : text.slice(newline)), checksum)
}

async function writeAll(file, chunk) {
  for (let offset = 0; offset < chunk.length;) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset)
    if (bytesWritten <= 0) throw fail('EIO')
    offset += bytesWritten
  }
}

async function makeWritable(path) {
  const info = await lookup(path)
  if (!info) return
  if (info.isDirectory()) {
    await chmod(path, 0o700).catch(() => {})
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      await makeWritable(join(path, entry.name))
    }
  } else if (info.isFile()) {
    await chmod(path, 0o600).catch(() => {})
  }
}

async function removeTree(path) {
  try {
    await rm(path, { recursive: true })
  } catch (error) {
    if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error
    await makeWritable(path)
    await rm(path, { recursive: true })
  }
}

async function copyFileDurably(source, target, { signal, preserveMode = true } = {}) {
  return withPlainInput(source, async (input, size, opened) => {
    assertPreparing(signal)
    const output = await open(target, 'wx', 0o600)
    try {
      for await (const chunk of readChunks(input, size)) {
        assertPreparing(signal)
        await writeAll(output, chunk)
      }
      await output.sync()
    } finally {
      await output.close()
    }
    if (preserveMode) {
      const mode = Number(opened.mode) & 0o777
      const needsMode = windows ? (mode & 0o200) === 0 : mode !== 0o600
      if (needsMode) await chmod(target, mode)
    }
  })
}

async function copyTree(source, target, { skip = () => false, signal, preserveMode = true, top = true } = {}) {
  assertPreparing(signal)
  const sourceInfo = await directory(source)
  await mkdir(target, { mode: 0o700 })
  await directory(target)
  for (const entry of await readdir(source, { withFileTypes: true })) {
    assertPreparing(signal)
    if (skip(entry.name, top)) continue
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) await copyTree(from, to, { skip, signal, preserveMode, top: false })
    else await copyFileDurably(from, to, { signal, preserveMode })
  }
  await syncDirectory(target)
  if (!top && preserveMode) {
    const mode = Number(sourceInfo.mode) & 0o777
    const needsMode = windows ? (mode & 0o200) === 0 : mode !== 0o700
    if (needsMode) await chmod(target, mode)
  }
}

async function repairTornTail(input, truncateTo, size, expectedCount, write, signal) {
  const stream = input.createReadStream({ start: truncateTo, end: size - 1, autoClose: false, highWaterMark: chunkBytes })
  const decoder = createZstdDecompress({
    chunkSize: chunkBytes,
    finishFlush: constants.ZSTD_e_flush,
    params: { [constants.ZSTD_d_windowLogMax]: 27 },
  })
  const transport = pipeline(stream, decoder).then(() => undefined, (error) => error)
  let fragments = []
  let lineBytes = 0
  let batch = []
  let batchBytes = 0
  let recovered = 0
  async function flushBatch() {
    if (!batchBytes) return
    const compressed = zstdCompressSync(Buffer.concat(batch, batchBytes), checksum)
    batch = []
    batchBytes = 0
    await write(compressed)
  }
  try {
    try {
      for await (const chunk of decoder) {
        assertPreparing(signal)
        let cursor = 0
        while (cursor < chunk.length) {
          const newline = chunk.indexOf(0x0a, cursor)
          const part = chunk.subarray(cursor, newline < 0 ? chunk.length : newline + 1)
          lineBytes += part.length
          if (lineBytes > maxHeaderBytes) throw fail('history-resource')
          if (newline < 0) fragments.push(Buffer.from(part))
          else {
            const line = fragments.length ? Buffer.concat([...fragments, part], lineBytes) : Buffer.from(part)
            fragments = []
            lineBytes = 0
            try { JSON.parse(line.toString('utf8')) } catch (error) { throw fail('unsupported', error) }
            recovered++
            batch.push(line)
            batchBytes += line.length
            if (batchBytes >= tornBatchBytes) await flushBatch()
          }
          cursor += part.length
        }
      }
      const transportError = await transport
      if (transportError) {
        assertPreparing(signal)
        if (recovered > 0) throw fail('unsupported', transportError)
      }
    } catch (error) {
      assertPreparing(signal)
      if (error?.code === 'history-resource' || error?.code === 'unsupported') throw error
      if (recovered > 0) throw fail('unsupported', error)
    }
  } finally {
    decoder.destroy()
    stream.destroy()
    await transport
  }
  await flushBatch()
  if (recovered !== expectedCount) throw fail('changed')
}

/** Replace just the independent header frame and copy all original body bytes. */
function rewriteLog(source, target, options) {
  return writeDurably(target, (output) => withPlainInput(source, async (input, size) => {
    const truncateTo = options.tornTruncateTo
    if (truncateTo !== undefined && (!Number.isSafeInteger(truncateTo) || truncateTo <= 0 || truncateTo >= size)) {
      throw fail('changed')
    }
    const scanner = createFrameScanner()
    const oldHash = createHash('sha256')
    const nextHash = createHash('sha256')
    let nextBytes = 0
    let offset = 0
    let headerLength = 0
    let headerWritten = false
    let headerParts = []
    async function write(chunk) {
      if (!chunk.length) return
      await writeAll(output, chunk)
      nextHash.update(chunk)
      nextBytes += chunk.length
    }
    for await (const chunk of readChunks(input, size)) {
      assertPreparing(options.signal)
      oldHash.update(chunk)
      const active = truncateTo === undefined ? chunk
        : offset >= truncateTo ? chunk.subarray(0, 0) : chunk.subarray(0, Math.min(chunk.length, truncateTo - offset))
      if (active.length) {
        let headerEnd
        scanner.write(active, headerWritten ? undefined : ({ end }) => { headerEnd ??= end })
        if (headerWritten) {
          await write(active)
        } else {
          const headerInChunk = headerEnd === undefined ? active.length : headerEnd - offset
          headerLength += headerInChunk
          if (headerLength > maxHeaderBytes) throw fail('unsupported')
          headerParts.push(Buffer.from(active.subarray(0, headerInChunk)))
          if (headerEnd !== undefined) {
            await write(rewriteFirstFrame(Buffer.concat(headerParts, headerLength), options))
            headerParts = []
            headerWritten = true
            await write(active.subarray(headerInChunk))
          }
        }
      }
      offset += chunk.length
    }
    if (!headerWritten || (!options.allowTorn && scanner.finish() !== undefined)) throw fail('unsupported')
    if (truncateTo !== undefined) {
      await repairTornTail(input, truncateTo, size, options.tornRecoveredCount ?? 0, write, options.signal)
    }
    if (options.append) await write(zstdCompressSync(JSON.stringify(options.append) + '\n', checksum))
    return { oldHash: oldHash.digest('hex'), nextHash: nextHash.digest('hex'), nextBytes }
  }))
}

function restoreOriginal(source, target, expected) {
  return writeDurably(target, (output) => withPlainInput(source, async (input, size) => {
    const hash = createHash('sha256')
    for await (const chunk of readChunks(input, size)) {
      hash.update(chunk)
      await writeAll(output, chunk)
    }
    if (hash.digest('hex') !== expected) throw fail('changed')
  }))
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
async function planCopies(plan, backups, signal, summaries, readSpace = statfs) {
  const volume = await directory(backups)
  const space = await readSpace(backups, { bigint: true })
  const block = space.frsize > 0n ? space.frsize : space.bsize
  if (block <= 0n || space.bavail < 0n) throw fail('disk-space')
  // Reserve journal metadata plus per-member headroom for the rewritten header
  // delta and appended directory event, rather than the 16 MiB decode ceiling.
  let required = 1024n * 1024n + 8n * block
  const round = (size) => ((size + block - 1n) / block) * block
  const cwdHeadroom = BigInt(Buffer.byteLength(plan.targetCwd)) * 2n + 64n * 1024n
  const trees = new Map()
  for (const { id, oldCwd, oldDir, nextDir } of plan.members) {
    if (oldCwd === plan.targetCwd) continue
    const shadows = []
    const inPlace = oldDir === nextDir
    const nextParent = dirname(nextDir)
    const targetVolume = await lookup(nextParent) ? await directory(nextParent) : await directory(dirname(nextParent))
    if (targetVolume.dev !== volume.dev) throw fail('cross-device')
    const tornTruncateTo = summaries?.get(id)?.tornTruncateTo
    required += round(cwdHeadroom) + 4n * block
    await inspectTree(oldDir, '', shadows, inPlace, tornTruncateTo)
    trees.set(id, shadows)
  }
  if (required > space.bavail * block) throw fail('disk-space')
  return trees

  async function inspectTree(path, relative, shadows, inPlace, tornTruncateTo) {
    assertPreparing(signal)
    if ((await directory(path)).dev !== volume.dev) throw fail('cross-device')
    required += inPlace ? block : 2n * block
    for (const entry of await readdir(path, { withFileTypes: true })) {
      assertPreparing(signal)
      const child = join(path, entry.name)
      const top = relative === ''
      if (top && entry.name === LOCK_FILENAME) continue
      if (top && generation(entry.name)) {
        if (entry.name !== LOG_FILENAME && !isShadow(entry.name)) throw fail('unsupported')
        if (entry.name !== LOG_FILENAME) shadows.push(entry.name)
      } else if (entry.isDirectory()) {
        await inspectTree(child, entry.name, shadows, inPlace, tornTruncateTo)
        continue
      }
      const info = await plainFile(child)
      if (info.dev !== BigInt(volume.dev)) throw fail('cross-device')
      const copies = !inPlace || (top && entry.name === LOG_FILENAME) ? 2n : 1n
      required += copies * (round(info.size) + block)
      if (top && entry.name === LOG_FILENAME && tornTruncateTo !== undefined && info.size > BigInt(tornTruncateTo)) {
        required += round(info.size - BigInt(tornTruncateTo))
      }
    }
  }
}

function hasPublishedPrefix(path, { nextBytes, nextHash }, exact) {
  return withPlainInput(path, async (file, size) => {
    if (nextBytes !== undefined) {
      if (size < nextBytes || (exact && size !== nextBytes)) return false
      return await digestFrom(file, nextBytes) === nextHash
    }
    if (await digestFrom(file, size) === nextHash) return true
    if (exact) return false
    // Older journals recorded only the digest. Native appends start a new
    // frame, so check the digest at each complete boundary.
    const hash = createHash('sha256')
    const scanner = createFrameScanner()
    let offset = 0
    let matched = false
    for await (const chunk of readChunks(file, size)) {
      let cursor = 0
      scanner.write(chunk, ({ end }) => {
        if (matched) return
        const boundary = end - offset
        hash.update(chunk.subarray(cursor, boundary))
        cursor = boundary
        matched = hash.copy().digest('hex') === nextHash
      })
      if (!matched) hash.update(chunk.subarray(cursor))
      offset += chunk.length
    }
    return matched
  })
}

export function moveStorage(root, base, { checkpoint = async () => {}, statfs: readSpace = statfs } = {}) {
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
      await removeTree(target)
      await syncDirectory(backups)
    }
  }

  async function discardPrepared(ticket) {
    if (await hasJournal()) return false
    await removeTicket(ticket)
    return true
  }

  async function hasOrphans() {
    const info = await lookup(backups)
    if (!info?.isDirectory()) return false
    const entries = await readdir(backups, { withFileTypes: true })
    return entries.some((entry) => entry.isDirectory() && isTicket(entry.name))
  }

  async function sweepOrphans() {
    if (await hasJournal()) return 0
    if (!await lookup(backups)) return 0
    await directory(backups)
    let removed = 0
    for (const entry of await readdir(backups, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isTicket(entry.name)) continue
      await removeTicket(entry.name)
      removed++
    }
    return removed
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

  async function prepare(_ctx, plan, ledger, lockStage, { signal, summaries = new Map() } = {}) {
    // The leases pin this exact cut until commit. Keep only the bounded
    // projection values, and use the same cut for the appended event.
    for (const member of plan.members) {
      assertPreparing(signal)
      summaries.set(member.id, await inspectMoveHistory({ path: member.oldFile, id: member.id,
        cwd: member.oldCwd, checkInbox: true }, { signal }))
    }
    await directory(root)
    await directory(backups, true)
    const sourceTrees = await planCopies(plan, backups, signal, summaries, readSpace)
    assertPreparing(signal)

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
        const shadows = sourceTrees.get(id)
        const name = encodeSegment(id)
        const original = join(home, 'original', name)
        const stage = join(home, 'staged', name)
        await copyTree(oldDir, original, { skip: (file, top) => top && file === LOCK_FILENAME, signal })
        if (inPlace) await directory(stage, true)
        else await copyTree(original, stage, { skip: (file, top) => top && file === LOG_FILENAME, signal })
        assertPreparing(signal)
        const cut = summaries.get(id)
        const cwdChangeSeq = cut.lastSeq + 1
        // DSH turns this event into native runtime context on the next request.
        const cwdChange = {
          type: 'working-directory/change', seq: cwdChangeSeq, time: Date.now(), data: { cwd: plan.targetCwd },
        }
        const fingerprints = await rewriteLog(join(original, LOG_FILENAME), join(stage, LOG_FILENAME), {
          id, oldCwd, targetCwd: plan.targetCwd, append: cwdChange, signal,
          tornTruncateTo: cut.tornTruncateTo, tornRecoveredCount: cut.tornRecoveredCount,
        })
        if (!inPlace) {
          await lockStage(stage)
          if (shadows.length) {
            const holding = join(home, 'held-shadows', name)
            await directory(holding, true)
            await syncDirectory(holding)
          }
        }
        await syncDirectory(stage)
        state.members.push({
          ...entry, ...fingerprints,
          cwdChangeSeq, ...(!inPlace && shadows.length ? { shadows } : {}),
        })
      }
      for (const path of privateDirectories) await syncDirectory(join(home, path))
      await syncDirectory(home)
      await syncDirectory(backups)
      assertPreparing(signal)
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
        if (await digestFile(p.oldFile) !== member.oldHash) throw fail('changed')
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
        const current = await digestFile(p.oldFile)
        if (current === member.oldHash) continue
        // Do not overwrite a log that acquired additional entries after publish.
        if (current !== member.nextHash) throw fail('changed')
        if (await digestFile(p.originalFile) !== member.oldHash) throw fail('changed')
        actions.push(() => restoreOriginal(p.originalFile, p.oldFile, member.oldHash))
        continue
      }
      if (await lookup(p.held)) {
        if (await lookup(p.oldFile)) throw fail('restore-pending')
        if (!await lookup(p.stage)) {
          await directory(p.nextDir)
          if (await digestFile(p.nextFile) !== member.nextHash) throw fail('changed')
          actions.push(() => renameDurably(p.nextDir, p.stage))
        }
        if (member.oldHash) {
          if (await digestFile(p.held) !== member.oldHash) throw fail('changed')
        } else await plainFile(p.held)
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

  async function verifyPublished(state, { exact = false } = {}) {
    for (const member of state.members) {
      const p = paths(state, member)
      if (p.unchanged) continue
      if (await lookup(p.inPlace ? p.stageFile : p.stage)) throw fail('changed')
      await directory(p.nextDir)
      if (!await hasPublishedPrefix(p.nextFile, member, exact)) throw fail('changed')
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
      await removeTree(p.oldDir)
      await syncDirectory(dirname(p.oldDir))
    }
    await finish(state)
  }

  return {
    hasJournal, readState, hasHeld, hasOrphans, sweepOrphans, discardPrepared,
    withLock, save, finish, withSessionLocks, prepare, publish, rollback, verifyPublished, cleanCommitted,
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
    await rewriteLog(file, file, { id, targetCwd: oldCwd, allowTorn: true })
    await renameDurably(held, oldDir)
  }
  // Keep the v0.1.0 backup for manual inspection. Its ledger order was not journaled.
  await renameDurably(journal, join(base, `recovered-${state.ticket}.json`))
}
