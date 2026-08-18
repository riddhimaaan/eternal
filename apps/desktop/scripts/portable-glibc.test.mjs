import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'vitest'

import {
  compareVersions,
  exceedsCeiling,
  formatVersion,
  GLIBC_CEILING,
  maxGlibcRequirement
} from './portable-glibc.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

test('picks the highest version, not the last or first seen', () => {
  assert.deepEqual(maxGlibcRequirement('GLIBC_2.14 GLIBC_2.42 GLIBC_2.2.5 GLIBC_2.28'), [2, 42])
})

test('compares numerically rather than as text', () => {
  // The trap: "2.9" sorts above "2.42" as a string.
  assert.deepEqual(maxGlibcRequirement('GLIBC_2.9 GLIBC_2.42'), [2, 42])
  assert.equal(compareVersions([2, 9], [2, 42]), -1)
  assert.equal(compareVersions([2, 31], [2, 31]), 0)
  assert.equal(compareVersions([3, 0], [2, 99]), 1)
})

test('returns null when the file names no glibc version', () => {
  assert.equal(maxGlibcRequirement('a statically linked thing'), null)
  assert.equal(maxGlibcRequirement(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00])), null)
})

test('a null requirement is never treated as a failure', () => {
  assert.equal(exceedsCeiling(null), false)
})

test('flags exactly the versions that would not start on the oldest supported distro', () => {
  assert.equal(exceedsCeiling([2, 42]), true, '2.42 is newer than any mainstream distro ships')
  assert.equal(exceedsCeiling([2, 34]), true)
  assert.equal(exceedsCeiling(GLIBC_CEILING), false, 'the ceiling itself must pass')
  assert.equal(exceedsCeiling([2, 28]), false, 'what the containerised build produces')
})

test('formats for humans', () => {
  assert.equal(formatVersion([2, 28]), '2.28')
  assert.equal(formatVersion(null), 'none')
})

test('the pty.node about to be packaged would run on the oldest supported distro', () => {
  // The regression this whole module exists for. Skipped when node-pty has not
  // been built yet, so a fresh checkout does not fail on a missing artifact.
  const binary = path.join(REPO_ROOT, 'node_modules', 'node-pty', 'build', 'Release', 'pty.node')

  if (!fs.existsSync(binary)) {
    return
  }

  const needed = maxGlibcRequirement(fs.readFileSync(binary))
  assert.equal(
    exceedsCeiling(needed),
    false,
    `pty.node needs glibc ${formatVersion(needed)}, above the ${formatVersion(GLIBC_CEILING)} ceiling. ` +
      'Rebuild it with scripts/build-node-pty-portable.mjs.'
  )
})
