import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

export const historyMessageBytes = 8 * 1024 * 1024
export const historyTimeoutMs = 180_000
export const historyWorkerArg = 'dsh-session-move-history-worker'
export const historyReady = 'H1\n'

const entry = fileURLToPath(new URL('./history-worker.js', import.meta.url))
const workerKey = Symbol.for('dsh-session-move.history-process')
const readyPrefix = Buffer.from(historyReady)
const v8Only = process.platform === 'win32' || process.platform === 'darwin'
const oldSpaceMiB = 128
const memoryMiB = 256
const virtualBytes = 1024 ** 3
const unitPrefix = 'dsh-session-move-history-'
const unitPattern = /\/dsh-session-move-history-[a-f0-9-]+\.scope$/u

function failure(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { code })
}

/** Called by the child before it tells the Host that it can accept input. */
export async function verifyHistoryIsolation(mode) {
  const heapBounded = process.execArgv.includes(`--max-old-space-size=${oldSpaceMiB}`)
  if (heapBounded && mode === 'v8' && v8Only) return
  if (heapBounded && process.platform === 'linux') {
    if (mode === 'cgroup') {
      const groups = await readFile('/proc/self/cgroup', 'utf8')
      const group = groups.split('\n').find(line => line.startsWith('0::'))?.slice(3)
      if (group?.startsWith('/') && unitPattern.test(group)) {
        const directory = join('/sys/fs/cgroup', group)
        const memory = Number((await readFile(join(directory, 'memory.max'), 'utf8')).trim())
        const swap = (await readFile(join(directory, 'memory.swap.max'), 'utf8')).trim()
        if (Number.isSafeInteger(memory) && memory > 0 && memory <= memoryMiB * 1024 ** 2 && swap === '0') return
      }
    } else if (mode === 'rlimit') {
      const limits = await readFile('/proc/self/limits', 'utf8')
      const addresses = /^Max address space\s+(\d+)\s+(\d+)\s+bytes/mu.exec(limits)
      if (addresses && Number(addresses[1]) <= virtualBytes && Number(addresses[2]) <= virtualBytes) return
    }
  }
  throw failure('history-isolation-unavailable', 'Session history worker could not verify its memory limits')
}

function killWorker(child) {
  if (child.pid && process.platform === 'linux') {
    try { process.kill(-child.pid, 'SIGKILL'); return } catch { /* The wrapper may already have exited. */ }
  }
  child.kill('SIGKILL')
}

function readResult(buffer) {
  let result
  try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) } catch (cause) {
    return { error: failure('history-protocol', 'Invalid session history response', cause) }
  }
  if (result?.ok === true && Object.hasOwn(result, 'value')) return { value: result.value }
  if (result?.ok === false && typeof result.code === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(result.code)) {
    const message = typeof result.message === 'string' ? result.message.slice(0, 512) : 'Session history operation failed'
    return { error: failure(result.code, message) }
  }
  return { error: failure('history-protocol', 'Incomplete session history response') }
}

function runProcess(command, args, request, { signal, remaining, installDirectory }) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'NODE_OPTIONS'))
  if (installDirectory) env.DSH_INSTALL_DIR = installDirectory
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return new Promise(resolve => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform === 'linux', windowsHide: true, env,
    })
    const output = []
    const prefix = Buffer.alloc(readyPrefix.length)
    let bytes = 0
    let ready = false
    let failureCause
    let stopped
    const terminate = error => {
      if (stopped) return
      stopped = error
      killWorker(child)
    }
    const cancel = () => terminate(failure('history-cancelled', 'Session history preparation was cancelled'))
    const deadline = setTimeout(() => {
      terminate(failure('history-timeout', 'Session history preparation timed out'))
    }, Math.max(1, remaining))

    child.once('error', error => { failureCause ??= error })
    child.stdout.on('error', error => { failureCause ??= error })
    child.stdout.on('data', chunk => {
      if (stopped) return
      if (bytes + chunk.length > historyMessageBytes) {
        terminate(failure('history-ipc-limit', 'Session history response exceeds the IPC size limit'))
        return
      }
      if (!ready) {
        chunk.copy(prefix, bytes, 0, Math.min(chunk.length, readyPrefix.length - bytes))
        if (bytes + chunk.length >= readyPrefix.length) {
          ready = prefix.equals(readyPrefix)
          if (!ready) {
            terminate(failure('history-protocol', 'Invalid session history ready marker'))
            return
          }
          // Deliver filesystem paths only after the worker proves its limits.
          child.stdin.end(request)
        }
      }
      bytes += chunk.length
      output.push(chunk)
    })
    child.stdin.on('error', error => { failureCause ??= error })
    child.once('close', (code, exitSignal) => {
      clearTimeout(deadline)
      signal?.removeEventListener('abort', cancel)
      if (stopped) {
        resolve({ error: stopped })
      } else if (!ready) {
        resolve({ unavailable: true, error: failure('history-isolation-unavailable', 'Unable to start a memory-limited session history worker', failureCause) })
      } else if (failureCause || code !== 0) {
        const detail = exitSignal ? `signal ${exitSignal}` : `exit code ${code}`
        resolve({ error: failure('history-resource', `Session history worker exited with ${detail}`, failureCause) })
      } else {
        resolve(readResult(Buffer.concat(output, bytes).subarray(readyPrefix.length)))
      }
    })
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
  })
}

/** Launch one worker at a time and enforce a single deadline across launcher fallbacks. */
export async function runHistory(request, { signal, timeoutMs = historyTimeoutMs, installDirectory } = {}) {
  if (signal?.aborted) throw failure('history-cancelled', 'Session history preparation was cancelled')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > historyTimeoutMs) {
    throw failure('history-timeout', 'Invalid session history preparation deadline')
  }
  if (globalThis[workerKey]) throw failure('history-busy', 'A session history worker is already running')
  if (process.platform !== 'linux' && !v8Only) {
    throw failure('history-isolation-unavailable', 'Session history isolation is unavailable on this platform')
  }

  const start = performance.now()
  let encoded
  try { encoded = JSON.stringify(request) } catch (cause) {
    throw failure('history-protocol', 'Invalid session history request', cause)
  }
  if (encoded === undefined) throw failure('history-protocol', 'Missing session history request')
  if (Buffer.byteLength(encoded) > historyMessageBytes) {
    throw failure('history-ipc-limit', 'Session history request exceeds the IPC size limit')
  }

  const remaining = () => timeoutMs - (performance.now() - start)
  const launch = (command, args) => {
    if (signal?.aborted) throw failure('history-cancelled', 'Session history preparation was cancelled')
    const timeLeft = remaining()
    if (timeLeft <= 0) throw failure('history-timeout', 'Session history preparation timed out')
    return runProcess(command, args, encoded, { signal, remaining: timeLeft, installDirectory })
  }
  const node = [process.execPath, `--max-old-space-size=${oldSpaceMiB}`]
  globalThis[workerKey] = true
  try {
    let result
    if (process.platform === 'linux') {
      result = await launch('systemd-run', [
        '--user', '--scope', '--quiet', '--collect', `--unit=${unitPrefix}${randomUUID()}`,
        '-p', `MemoryMax=${memoryMiB}M`, '-p', 'MemorySwapMax=0', '--',
        'prlimit', '--core=0', '--', ...node, entry, historyWorkerArg, 'cgroup',
      ])
      if (result.unavailable) {
        // V8 reserves code address space independently of its old-generation heap.
        result = await launch('prlimit', [
          `--as=${virtualBytes}`, '--core=0', '--', ...node, '--jitless', entry, historyWorkerArg, 'rlimit',
        ])
      }
    } else {
      // Native Windows and macOS still get a separate Node process and heap cap.
      result = await launch(process.execPath, [node[1], entry, historyWorkerArg, 'v8'])
    }
    if (result.error) throw result.error
    return result.value
  } finally {
    delete globalThis[workerKey]
  }
}
