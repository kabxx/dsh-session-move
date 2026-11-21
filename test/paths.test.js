import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeSegment, projectKey, projectDir, sessionDir } from '../src/paths.js'

test('encodeSegment leaves safe characters literal', () => {
  assert.equal(encodeSegment('abc-123_x.y'), 'abc-123_x.y')
})

test('encodeSegment escapes separators and traversal', () => {
  assert.equal(encodeSegment('a:b'), 'a~003Ab')
  assert.equal(encodeSegment('a/b'), 'a~002Fb')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('~'), '~007E')
})

test('encodeSegment matches the observed spawn id layout', () => {
  assert.equal(
    encodeSegment('session-84a94f8d-2468-44db-a0ef-d1bacc806f00:spawn:1.27.4'),
    'session-84a94f8d-2468-44db-a0ef-d1bacc806f00~003Aspawn~003A1.27.4',
  )
})

test('projectKey collapses separator runs into one dash', () => {
  assert.equal(
    projectKey('/mnt/c/users/jxz/desktop/vibe/project/other'),
    '--mnt-c-users-jxz-desktop-vibe-project-other--',
  )
  assert.equal(projectKey('C:\\Users\\JXZ\\code'), '--C-Users-JXZ-code--')
})

test('projectKey falls back to root for a bare separator', () => {
  assert.equal(projectKey('/'), '--root--')
})

test('projectDir and sessionDir compose the documented layout', () => {
  const root = '/home/u/.dsh/sessions'
  assert.equal(
    projectDir(root, '/w/p'),
    '/home/u/.dsh/sessions/--w-p--',
  )
  assert.equal(
    sessionDir(root, '/w/p', 'id-1'),
    '/home/u/.dsh/sessions/--w-p--/id-1',
  )
  assert.equal(projectDir(root, undefined), '/home/u/.dsh/sessions/_no-cwd')
})

test('vendored derivation agrees with the shipped JSONL backend', async (t) => {
  // The shipped module is TypeScript inside the DSH install; when the runtime
  // cannot load it, the fixed expectations above still pin this copy.
  const candidates = [
    '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts',
  ]
  for (const specifier of candidates) {
    let shipped
    try {
      shipped = await import(specifier)
    } catch {
      continue
    }
    for (const cwd of ['/w/p', 'C:\\Users\\JXZ\\code', '/', '/a b/c~d']) {
      assert.equal(projectKey(cwd), shipped.projectKey(cwd), `projectKey(${cwd})`)
    }
    for (const id of ['a:b', 'x/y', '..', 'plain', '~t']) {
      assert.equal(encodeSegment(id), shipped.encodeSegment(id), `encodeSegment(${id})`)
    }
    return
  }
  t.diagnostic('shipped format module not importable here; fixed expectations only')
})
