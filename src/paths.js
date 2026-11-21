/**
 * Session log path derivation, mirroring
 * `@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts` exactly.
 *
 * Vendored instead of imported: the shipped module is TypeScript resolved from
 * the DSH install, and a profile-installed bundle must not depend on how that
 * install is laid out. `test/paths.test.js` pins this copy against the shipped
 * implementation so a drift in either side fails loudly.
 *
 * @module dsh-session-move/paths
 */

import { join } from 'node:path'

/** Escape one arbitrary string into a single safe path segment (`~XXXX` per code unit). */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/** Build the human-navigable project directory key for a project path. */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** The project directory a session with this cwd lives under. */
export function projectDir(root, cwd) {
  if (cwd === undefined) return join(root, '_no-cwd')
  return join(root, projectKey(cwd))
}

/** The directory owned by one session. */
export function sessionDir(root, cwd, id) {
  return join(projectDir(root, cwd), encodeSegment(id))
}

/** The current generation's log filename. */
export const LOG_FILENAME = 'session.v4.jsonl.zstd'

/** The write-lease file DSH keeps beside the log. */
export const LOCK_FILENAME = 'session.lock'
