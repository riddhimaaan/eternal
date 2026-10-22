import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'

import {
  BUNDLED_EXTRAS,
  bundledExtraSpecs,
  manifestMatches,
  manylinuxPlatformTags,
  missingPins,
  pinsFromWheels,
  requestedSpecs,
  wheelFitsGlibcCeiling
} from './stage-agent-runtime.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const MCP_EXTRA = ['mcp==1.28.1', 'starlette==1.3.1']
const CORE = ['openai==2.24.0', 'pydantic==2.13.4', "tzdata==2025.3; sys_platform == 'win32'"]

// ─── which extras ship in the bundle ───────────────────────────────

test('the mcp extra is bundled, so MCP servers work on a fresh install', () => {
  assert.ok(BUNDLED_EXTRAS.includes('mcp'))
})

test('pyproject.toml still has an mcp extra with an exact mcp pin', () => {
  // A regex rather than a TOML parser: the test must not need Python, and the
  // extra is a single line by convention. If that ever changes this fails
  // loudly, which is the point.
  const pyproject = fs.readFileSync(path.join(REPO_ROOT, 'pyproject.toml'), 'utf8')
  const line = /^mcp = \[(.*)\]/m.exec(pyproject)

  assert.ok(line, 'no `mcp = [...]` line in pyproject.toml')

  const specs = [...line[1].matchAll(/"([^"]+)"/g)].map(match => match[1])

  assert.ok(
    specs.some(spec => /^mcp==\d/.test(spec)),
    `mcp extra does not pin mcp exactly: ${specs.join(', ')}`
  )
  assert.deepEqual(bundledExtraSpecs({ mcp: specs }), specs)
})

test('bundledExtraSpecs returns the extra exactly as pyproject lists it', () => {
  assert.deepEqual(bundledExtraSpecs({ mcp: MCP_EXTRA, web: ['fastapi==1'] }), MCP_EXTRA)
})

test('a missing or empty bundled extra fails instead of quietly shipping without it', () => {
  assert.throws(() => bundledExtraSpecs({}), /no \[project.optional-dependencies\] "mcp"/)
  assert.throws(() => bundledExtraSpecs({ mcp: [] }), /"mcp"/)
  assert.throws(() => bundledExtraSpecs(undefined), /"mcp"/)
})

test('a bundled extra that points back at the project is rejected', () => {
  assert.throws(() => bundledExtraSpecs({ mcp: ['eternal-agent[web]'] }), /refers back to the project/)
})

test('pip is asked for the core dependencies plus the bundled extras', () => {
  assert.deepEqual(requestedSpecs({ dependencies: CORE, extras: { mcp: MCP_EXTRA } }), [...CORE, ...MCP_EXTRA])
})

// ─── glibc ceiling ─────────────────────────────────────────────────

test('x86_64 tags run from the ceiling down to the oldest manylinux, never above it', () => {
  const tags = manylinuxPlatformTags('x64', [2, 31])

  assert.equal(tags[0], 'manylinux_2_31_x86_64')
  assert.ok(tags.includes('manylinux_2_28_x86_64'))
  assert.ok(tags.includes('manylinux_2_17_x86_64'))
  assert.ok(tags.includes('manylinux_2_5_x86_64'))
  assert.ok(tags.includes('manylinux2014_x86_64'))
  assert.ok(tags.includes('manylinux2010_x86_64'))
  assert.ok(tags.includes('manylinux1_x86_64'))
  assert.ok(!tags.includes('manylinux_2_32_x86_64'))
  assert.ok(!tags.includes('manylinux_2_34_x86_64'))
})

test('aarch64 tags stop at manylinux_2_17, where aarch64 wheels begin', () => {
  const tags = manylinuxPlatformTags('arm64', [2, 31])

  assert.equal(tags[0], 'manylinux_2_31_aarch64')
  assert.equal(tags.at(-1), 'manylinux2014_aarch64')
  assert.ok(!tags.includes('manylinux_2_16_aarch64'))
  assert.ok(!tags.some(tag => tag.startsWith('manylinux1')))
})

test('an unmapped arch yields no tags', () => {
  assert.equal(manylinuxPlatformTags('ia32'), null)
})

test('a wheel needing glibc 2.34 is refused; the 2.28 build of the same release is fine', () => {
  // The real case: on a rolling-distro build machine pip picked this one.
  assert.equal(wheelFitsGlibcCeiling('cryptography-50.0.0-cp311-abi3-manylinux_2_34_x86_64.whl', [2, 31]), false)
  assert.equal(wheelFitsGlibcCeiling('cryptography-50.0.0-cp311-abi3-manylinux_2_28_x86_64.whl', [2, 31]), true)
})

test('pure-Python and legacy-tagged wheels fit the ceiling', () => {
  assert.equal(wheelFitsGlibcCeiling('mcp-1.28.1-py3-none-any.whl'), true)
  assert.equal(
    wheelFitsGlibcCeiling('rpds_py-2026.9.1-cp311-cp311-manylinux_2_17_x86_64.manylinux2014_x86_64.whl'),
    true
  )
  assert.equal(wheelFitsGlibcCeiling('websockets-15.0.1-cp311-cp311-manylinux1_x86_64.whl'), true)
})

test('a wheel fits when any one of its compressed tags fits', () => {
  assert.equal(
    wheelFitsGlibcCeiling('charset_normalizer-3.5.2-cp311-cp311-manylinux_2_35_x86_64.manylinux_2_28_x86_64.whl', [2, 31]),
    true
  )
})

test('musl, bare-linux and other-OS wheels do not fit a glibc target', () => {
  assert.equal(wheelFitsGlibcCeiling('x-1.0-cp311-cp311-musllinux_1_2_x86_64.whl'), false)
  assert.equal(wheelFitsGlibcCeiling('x-1.0-cp311-cp311-linux_x86_64.whl'), false)
  assert.equal(wheelFitsGlibcCeiling('x-1.0-cp311-cp311-macosx_11_0_arm64.whl'), false)
})

// ─── requirements.txt pins ─────────────────────────────────────────

test('pins come from wheel filenames, sorted', () => {
  assert.deepEqual(
    pinsFromWheels([
      'mcp-1.28.1-py3-none-any.whl',
      'attrs-26.1.0-py3-none-any.whl',
      'pydantic_settings-2.16.1-py3-none-any.whl'
    ]),
    ['attrs==26.1.0', 'mcp==1.28.1', 'pydantic_settings==2.16.1']
  )
})

test('missingPins notices when the mcp wheel did not make it into the bundle', () => {
  const pins = ['attrs==26.1.0', 'starlette==1.3.1']

  assert.deepEqual(missingPins(pins, MCP_EXTRA), ['mcp==1.28.1'])
  assert.deepEqual(missingPins([...pins, 'mcp==1.28.1'], MCP_EXTRA), [])
})

test('missingPins matches names the way pip does and skips specs that are not exact', () => {
  const pins = ['pydantic_settings==2.16.1', 'ruamel.yaml==0.18.17']

  assert.deepEqual(
    missingPins(pins, ['pydantic-settings==2.16.1', 'Ruamel_Yaml==0.18.17', 'fastapi>=0.104,<1']),
    []
  )
  assert.deepEqual(missingPins(pins, ["uvicorn[standard]==0.41.0; sys_platform != 'win32'"]), ['uvicorn==0.41.0'])
  assert.deepEqual(missingPins(pins, ['pydantic-settings==2.17.0']), ['pydantic-settings==2.17.0'])
})

// ─── build cache ───────────────────────────────────────────────────

const OPTS = { arch: 'x64', platform: 'linux' }

function manifest(overrides = {}) {
  return {
    arch: 'x64',
    glibcCeiling: [2, 31],
    platform: 'linux',
    pythonVersion: '3.11.15',
    requested: [...CORE, ...MCP_EXTRA],
    ...overrides
  }
}

test('a bundle staged from the same dependency list is reused', () => {
  assert.equal(manifestMatches(manifest(), OPTS, [...CORE, ...MCP_EXTRA]), true)
  assert.equal(manifestMatches(manifest(), OPTS, [...MCP_EXTRA, ...CORE]), true)
})

test('a bundle staged before mcp was bundled is re-staged, not reused', () => {
  // Exactly the machine that built 0.17.0: its manifest predates the list.
  const { requested: _requested, glibcCeiling: _ceiling, ...old } = manifest()

  assert.equal(manifestMatches(old, OPTS, [...CORE, ...MCP_EXTRA]), false)
  assert.equal(manifestMatches(manifest({ requested: CORE }), OPTS, [...CORE, ...MCP_EXTRA]), false)
})

test('a bundle staged for another glibc ceiling, platform or Python is re-staged', () => {
  const requested = [...CORE, ...MCP_EXTRA]

  assert.equal(manifestMatches(manifest({ glibcCeiling: [2, 34] }), OPTS, requested), false)
  assert.equal(manifestMatches(manifest({ arch: 'arm64' }), OPTS, requested), false)
  assert.equal(manifestMatches(manifest({ pythonVersion: '3.11.13' }), OPTS, requested), false)
})
