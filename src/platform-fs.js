// Adapted from @kabxx/dsh-session-delete for the same pinned DSH host.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { lstat, open, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, parse, resolve, toNamespacedPath } from 'node:path';
import { pathToFileURL } from 'node:url';

const conflictExit = 73;
const windows = process.platform === 'win32';
const jsonlManifest = '@deepseek-ai/dsh-session-persistence-jsonl/package.json';
const windowLockPrefix = 'Local\\dsh-session-lock-';
const MOVEFILE_REPLACE_EXISTING = 0x01;
const MOVEFILE_WRITE_THROUGH = 0x08;
const INVALID_FILE_ATTRIBUTES = 0xffffffff;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 0x102;
const DRIVE_FIXED = 3;
let windowsBindings;
let darwinFlock;
let exclusiveRename;

function failure(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { code });
}

/** Resolve from the host, including an ASAR inside Electron and pnpm package layouts. */
export function sessionRequire() {
  const anchors = [process.env.DSH_INSTALL_DIR];
  if (process.versions.electron) {
    // The Desktop CLI can boot a profile in Electron without exporting DSH_INSTALL_DIR.
    const resources = process.resourcesPath ?? (process.platform === 'darwin'
      ? join(dirname(process.execPath), '..', 'Resources')
      : join(dirname(process.execPath), 'resources'));
    anchors.push(join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'));
  }
  // The npm shims launch the declared entry point, possibly through a symlink.
  // Check that exact shape instead of looking for arbitrary packages above cwd.
  let cliEntry;
  try {
    if (process.argv[1]) cliEntry = realpathSync(process.argv[1]);
  } catch { /* Depend on the other verified anchors. */ }
  const cliRoot = cliEntry && basename(cliEntry) === 'bin.js' && basename(dirname(cliEntry)) === 'lib'
    ? dirname(dirname(cliEntry)) : undefined;
  let cause;
  for (const directory of new Set([...anchors, cliRoot])) {
    if (!directory || !isAbsolute(directory)) continue;
    try {
      const hostRequire = createRequire(join(directory, 'package.json'));
      const hostManifest = hostRequire('./package.json');
      if (hostManifest.name !== '@deepseek-ai/dsh') throw new Error('Invalid DSH install');
      if (directory === cliRoot && resolve(directory, hostManifest.bin?.dsh ?? '') !== cliEntry) {
        throw new Error('Unexpected DSH CLI entry point');
      }
      const manifest = hostRequire.resolve(jsonlManifest);
      if (hostRequire(manifest).version !== '0.2.2-rc.5') throw new Error('Unexpected DSH session lease version');
      return createRequire(manifest);
    } catch (error) {
      cause = error;
    }
  }
  throw failure('unsupported', 'Cannot locate the shipped DSH session lock implementation', cause);
}

function windowsApi() {
  if (windowsBindings) return windowsBindings;
  try {
    const koffi = sessionRequire()('koffi');
    const kernel32 = koffi.load('kernel32.dll');
    const bind = (name, type, args) => kernel32.func('__stdcall', name, type, args);
    windowsBindings = {
      create: bind('CreateSemaphoreW', 'intptr', ['void*', 'int', 'int', 'str16']),
      wait: bind('WaitForSingleObject', 'uint', ['intptr', 'uint']),
      release: bind('ReleaseSemaphore', 'int', ['intptr', 'int', 'void*']),
      close: bind('CloseHandle', 'int', ['intptr']),
      move: bind('MoveFileExW', 'int', ['str16', 'str16', 'uint']),
      attributes: bind('GetFileAttributesW', 'uint', ['str16']),
      driveType: bind('GetDriveTypeW', 'uint', ['str16']),
      lastError: bind('GetLastError', 'uint', []),
    };
    return windowsBindings;
  } catch (error) {
    throw failure('unsupported', 'Cannot load the DSH Windows filesystem bindings', error);
  }
}

function win32Failure(method, number) {
  const code = { 2: 'ENOENT', 3: 'ENOENT', 5: 'EACCES', 17: 'cross-device', 32: 'locked',
    33: 'locked', 80: 'collision', 123: 'unsafe-path', 183: 'collision' }[number] ?? 'EIO';
  return failure(code, `${method} failed (Win32 ${number})`);
}

function win32Identity(path) {
  // This is the exact case-folded semaphore key used by DSH's JSONL backend.
  const digest = createHash('sha256').update(resolve(path).toLowerCase()).digest('hex');
  return { dev: 'win32-semaphore', ino: digest };
}

export function acquireWindowsLock(path) {
  const api = windowsApi();
  const lockedIdentity = win32Identity(path);
  const nativeHandle = api.create(null, 1, 1, `${windowLockPrefix}${lockedIdentity.ino}`);
  if (nativeHandle === 0 || nativeHandle === 0n) throw win32Failure('CreateSemaphoreW', api.lastError());
  const status = api.wait(nativeHandle, 0);
  if (status !== WAIT_OBJECT_0) {
    const code = status === WAIT_TIMEOUT ? 32 : api.lastError();
    api.close(nativeHandle);
    throw win32Failure('WaitForSingleObject', code);
  }
  let closed = false;
  return { lockedIdentity, handle: { async close() {
    if (closed) return;
    closed = true;
    const released = api.release(nativeHandle, 1, null);
    const releaseError = released ? undefined : api.lastError();
    const didClose = api.close(nativeHandle);
    if (!released) throw win32Failure('ReleaseSemaphore', releaseError);
    if (!didClose) throw win32Failure('CloseHandle', api.lastError());
  } } };
}

function kernelFlockLinux(fd) {
  return new Promise((done, reject) => {
    // The inherited descriptor shares the parent's open file description.
    const child = spawn('/usr/bin/flock', ['-xn', '-E', String(conflictExit), '3'], {
      stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 3000,
    });
    child.once('error', (error) => reject(failure('unsupported', 'Cannot execute flock', error)));
    child.once('close', (code) => {
      if (code === 0) done();
      else reject(failure(code === conflictExit ? 'locked' : 'unsupported', 'Cannot acquire the DSH session flock'));
    });
  });
}

async function kernelFlockDarwin(fd) {
  try {
    const { tryLockExclusive } = await (darwinFlock ??= import(pathToFileURL(sessionRequire()
      .resolve('@deepseek-ai/node-addon-system/flock')).href));
    await tryLockExclusive(fd);
  } catch (error) {
    const contention = error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK';
    throw failure(contention ? 'locked' : 'unsupported', 'Cannot acquire the DSH session flock', error);
  }
}

async function statExisting(path) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function identity(info) {
  return { dev: String(info.dev), ino: String(info.ino) };
}

export async function verifyPathLock(path, expected) {
  let actual;
  if (windows) {
    actual = win32Identity(path);
  } else {
    const info = await statExisting(path);
    if (info?.isFile() && info.nlink === 1n) actual = identity(info);
  }
  if (!actual || actual.dev !== expected?.dev || actual.ino !== expected?.ino) {
    throw failure('collision', 'The DSH lock path no longer matches the acquired lock');
  }
}

export async function acquirePathLock(path, device) {
  if (windows) return acquireWindowsLock(path);
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw failure('unsupported', 'DSH session locking is unavailable on this platform');
  }
  const existing = await statExisting(path);
  const safeFile = (info) => info.isFile() && info.nlink === 1n && (device === undefined || info.dev === device);
  if (existing && !safeFile(existing)) throw failure('unsafe-path', 'Unsafe DSH lock path');
  const handle = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const held = await handle.stat({ bigint: true });
    if (!safeFile(held)) throw failure('unsafe-path', 'Unsafe DSH lock descriptor');
    const flock = process.platform === 'darwin' ? kernelFlockDarwin : kernelFlockLinux;
    await flock(handle.fd);
    const lockedIdentity = identity(held);
    await verifyPathLock(path, lockedIdentity);
    return { handle, lockedIdentity };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Inspect an existing local Windows path without following its terminal reparse point. */
export function isWindowsReparsePoint(path) {
  if (!windows) return false;
  const api = windowsApi();
  const root = parse(path).root;
  if (!/^[A-Za-z]:\\$/u.test(root) || api.driveType(root) !== DRIVE_FIXED) {
    throw failure('unsupported', 'DSH session movement requires a local Windows volume');
  }
  const attributes = api.attributes(path === root ? root : toNamespacedPath(path));
  if (attributes === INVALID_FILE_ATTRIBUTES) throw win32Failure('GetFileAttributesW', api.lastError());
  return Boolean(attributes & FILE_ATTRIBUTE_REPARSE_POINT);
}

export function assertPlainWindowsPath(path) {
  if (isWindowsReparsePoint(path)) throw failure('unsafe-path', 'Windows reparse point in the session storage path');
}

export async function syncDirectory(path) {
  // On Windows the journal and detach renames use MoveFileExW WRITE_THROUGH.
  if (windows) return;
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

/** Restore into a live namespace without replacing even an empty directory. */
export async function restorePath(source, dest) {
  if (windows) return publishPath(source, dest);
  if (!exclusiveRename) {
    try {
      const koffi = sessionRequire()('koffi');
      const libc = koffi.load(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6');
      if (process.platform === 'darwin') {
        const renamex = libc.func('int renamex_np(const char *, const char *, unsigned int)');
        exclusiveRename = (from, to) => renamex(from, to, 0x04);
      } else {
        const renameAt = libc.func('int renameat2(int, const char *, int, const char *, unsigned int)');
        exclusiveRename = (from, to) => renameAt(-100, from, -100, to, 1);
      }
    } catch (error) {
      throw failure('unsupported', 'Cannot load the native no-replace rename', error);
    }
  }
  if (exclusiveRename(source, dest) !== 0) {
    throw failure(await statExisting(dest) ? 'collision' : 'EIO', 'Cannot publish without replacing the destination');
  }
}

export async function publishPath(source, dest, { replace = false } = {}) {
  if (!windows) {
    // The transaction directory is private, and only the current operation writes to it.
    if (!replace && await statExisting(dest)) throw failure('collision', 'The target path already exists');
    return rename(source, dest);
  }
  const api = windowsApi();
  const flags = MOVEFILE_WRITE_THROUGH | (replace ? MOVEFILE_REPLACE_EXISTING : 0);
  if (!api.move(toNamespacedPath(source), toNamespacedPath(dest), flags)) {
    throw win32Failure('MoveFileExW', api.lastError());
  }
}
