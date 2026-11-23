import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { watch } from 'node:fs'
import { copyFile, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const linux = process.platform === 'linux'
const prlimit = linux ? spawnSync('sh', ['-c', 'command -v prlimit'], { encoding: 'utf8' }).stdout?.trim() : undefined
const supported = process.platform === 'win32' || Boolean(prlimit)

async function fixture(t) {
  const root = await realpath(tmpdir())
  const directory = await mkdtemp(join(root, 'dsh-move-history-test-'))
  t.after(async () => {
    const resolved = await realpath(directory)
    assert.equal(resolved, directory)
    assert.equal(dirname(resolved), root)
    await rm(resolved, { force: true, recursive: true })
  })
  const launcher = join(directory, 'history-process.js')
  await copyFile(new URL('../src/history-process.js', import.meta.url), launcher)
  await writeFile(join(directory, 'package.json'), '{"type":"module"}')
  await writeFile(join(directory, 'history-worker.js'), `
    import { writeFileSync } from 'node:fs'
    import { historyMessageBytes, historyReady, verifyHistoryIsolation } from './history-process.js'
    const mode = process.argv[3]
    await verifyHistoryIsolation(mode)
    process.stdout.write(historyReady.slice(0, 1))
    setTimeout(() => process.stdout.write(historyReady.slice(1)), 10)
    const input = []
    for await (const part of process.stdin) input.push(part)
    const request = JSON.parse(Buffer.concat(input).toString())
    if (request.pidFile) writeFileSync(request.pidFile, String(process.pid))
    if (request.task === 'hang') setInterval(() => {}, 1000)
    if (request.task === 'memory') {
      const memory = []
      for (;;) memory.push(Array(1024 ** 2).fill(1))
    }
    if (request.task === 'oversize') process.stdout.write(Buffer.alloc(historyMessageBytes, 32))
    else if (request.task === 'invalid') process.stdout.write('\\xff')
    else if (request.task === 'busy') process.stdout.write(JSON.stringify({ ok: false, code: 'busy', message: 'inbox not empty' }))
    else if (request.task !== 'hang') process.stdout.write(JSON.stringify({ ok: true, value: { mode, options: process.env.NODE_OPTIONS } }))
  `)
  return { directory, ...await import(pathToFileURL(launcher).href) }
}

function awaitPid(path) {
  return new Promise((resolve, reject) => {
    let deadline
    const watcher = watch(dirname(path), async (_, name) => {
      if (name !== 'pid') return
      try {
        const pid = Number(await readFile(path, 'utf8'))
        if (pid > 0) {
          clearTimeout(deadline)
          watcher.close()
          resolve(pid)
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          clearTimeout(deadline)
          watcher.close()
          reject(error)
        }
      }
    })
    deadline = setTimeout(() => {
      watcher.close()
      reject(new Error('Worker did not report its process ID'))
    }, 5000)
  })
}

test('launches a memory-limited worker, splitting the ready marker across reads', { skip: !supported }, async t => {
  const { runHistory } = await fixture(t)
  const value = await runHistory({ task: 'inspect' })
  assert.ok((linux ? ['cgroup', 'rlimit'] : ['v8']).includes(value.mode))
  assert.equal(value.options, undefined)
  await assert.rejects(runHistory({ task: 'busy' }), { code: 'busy' })
  await assert.rejects(runHistory({ task: 'invalid' }), { code: 'history-protocol' })
})

test('uses the address-space limit when the cgroup launcher fails', { skip: !prlimit }, async t => {
  const { directory, runHistory } = await fixture(t)
  await writeFile(join(directory, 'systemd-run'), '#!/bin/sh\nexit 42\n', { mode: 0o700 })
  await symlink(prlimit, join(directory, 'prlimit'))
  const search = process.env.PATH
  process.env.PATH = directory
  try {
    assert.equal((await runHistory({ task: 'inspect' })).mode, 'rlimit')
  } finally {
    process.env.PATH = search
  }
})

test('limits IPC in both directions before accepting a response', { skip: !supported }, async t => {
  const { historyMessageBytes, runHistory } = await fixture(t)
  await assert.rejects(runHistory({ text: 'a'.repeat(historyMessageBytes) }), { code: 'history-ipc-limit' })
  await assert.rejects(runHistory({ task: 'oversize' }), { code: 'history-ipc-limit' })
  await runHistory({ task: 'inspect' })
})

test('enforces one worker, then removes a running worker on abort', { skip: !supported }, async t => {
  const { directory, runHistory } = await fixture(t)
  const pidFile = join(directory, 'pid')
  const pidPromise = awaitPid(pidFile)
  const control = new AbortController()
  const request = runHistory({ task: 'hang', pidFile }, { signal: control.signal })
  const rejection = assert.rejects(request, { code: 'history-cancelled' })
  try {
    const pid = await pidPromise
    await assert.rejects(runHistory({ task: 'inspect' }), { code: 'history-busy' })
    control.abort()
    await rejection
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    await runHistory({ task: 'inspect' })
  } finally {
    control.abort()
    await Promise.allSettled([rejection, pidPromise])
  }
})

test('ends a timed-out request and survives a worker memory failure', { skip: !supported }, async t => {
  const { runHistory } = await fixture(t)
  await assert.rejects(runHistory({ task: 'hang' }, { timeoutMs: 200 }), { code: 'history-timeout' })
  await assert.rejects(runHistory({ task: 'memory' }, { timeoutMs: 10_000 }), { code: 'history-resource' })
  await runHistory({ task: 'inspect' })
})
