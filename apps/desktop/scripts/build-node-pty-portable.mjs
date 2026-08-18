#!/usr/bin/env node
// build-node-pty-portable.mjs — compile pty.node against an old glibc.
//
// node-pty ships prebuilt binaries for macOS and Windows but not Linux, so
// `npm install` compiles it here, against this machine's glibc. Build on a
// rolling distro and the result demands a glibc newer than any mainstream
// distribution ships; because electron/main.ts imports node-pty at the top,
// the packaged app then dies before drawing a window on a normal user's
// machine, with nothing on screen to explain why.
//
// glibc symbol versioning is backward compatible: a binary compiled against an
// old glibc runs on every newer one. So the fix is to compile it somewhere old.
// Debian 11 (glibc 2.31) covers every distribution in current use, and the
// resulting binary asks for no more than glibc 2.28.
//
// Deliberately NOT a Dockerfile: this needs no build context, no image to
// publish, and no layer cache — one container, one compile, one artifact out.
//
//   node scripts/build-node-pty-portable.mjs

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { exceedsCeiling, formatVersion, GLIBC_CEILING, maxGlibcRequirement } from './portable-glibc.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..')
const repoRoot = resolve(appRoot, '..', '..')

/** Debian 11. Old enough to cover everything current, still receiving updates. */
const BUILD_IMAGE = 'docker.io/library/node:20-bullseye-slim'

function fail(message) {
  console.error(`[node-pty] error: ${message}`)
  process.exit(1)
}

function log(message) {
  console.log(`[node-pty] ${message}`)
}

/** Podman first: it is rootless, so it needs no daemon and no privileges. */
function findContainerRunner() {
  for (const runner of ['podman', 'docker']) {
    const probe = spawnSync(runner, ['--version'], { encoding: 'utf8' })

    if (probe.status === 0) {
      return runner
    }
  }

  return null
}

function electronVersion() {
  const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'))
  const version = pkg.devDependencies?.electron || pkg.dependencies?.electron

  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`could not read an exact electron version from apps/desktop/package.json (got ${version})`)
  }

  return version
}

const runner = findContainerRunner()

if (!runner) {
  fail(
    'neither podman nor docker is available.\n' +
      '  One of them is required to compile against an older glibc than this machine has.\n' +
      '  Without it the packaged app only starts on distributions as new as this one.'
  )
}

const target = electronVersion()
const source = join(repoRoot, 'node_modules', 'node-pty')
const addonApi = join(repoRoot, 'node_modules', 'node-addon-api')

for (const [label, path] of [['node-pty', source], ['node-addon-api', addonApi]]) {
  if (!existsSync(path)) {
    fail(`${label} is missing from node_modules — run npm install first`)
  }
}

const work = mkdtempSync(join(tmpdir(), 'eternal-node-pty-'))

try {
  const staged = join(work, 'node-pty')

  // A copy rather than a mount of node_modules: the container compiles as root
  // and would otherwise leave root-owned build output in the real tree.
  cpSync(source, staged, { recursive: true })
  rmSync(join(staged, 'build'), { force: true, recursive: true })
  mkdirSync(join(staged, 'node_modules'), { recursive: true })
  // binding.gyp resolves node-addon-api with a bare require, so it has to sit
  // in a node_modules directory the container can see.
  cpSync(addonApi, join(staged, 'node_modules', 'node-addon-api'), { recursive: true })

  log(`compiling for electron ${target} inside ${BUILD_IMAGE} (via ${runner})`)

  const build = spawnSync(
    runner,
    [
      'run', '--rm',
      '-v', `${work}:/work:Z`,
      '-w', '/work/node-pty',
      BUILD_IMAGE,
      'bash', '-c',
      'set -e; ' +
        'apt-get update -qq >/dev/null && apt-get install -y -qq python3 make g++ >/dev/null; ' +
        'npm install -g node-gyp@11 >/dev/null; ' +
        `node-gyp rebuild --target=${target} --dist-url=https://electronjs.org/headers --arch=x64`
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )

  if (build.status !== 0) {
    fail(`the container build failed:\n${(build.stderr || build.stdout || '').split('\n').slice(-15).join('\n')}`)
  }

  const built = join(staged, 'build', 'Release', 'pty.node')

  if (!existsSync(built)) {
    fail('the container build reported success but produced no pty.node')
  }

  const needed = maxGlibcRequirement(readFileSync(built))

  if (exceedsCeiling(needed)) {
    fail(
      `the container produced a binary needing glibc ${formatVersion(needed)}, ` +
        `above the ${formatVersion(GLIBC_CEILING)} ceiling — the build image is too new`
    )
  }

  const destination = join(source, 'build', 'Release', 'pty.node')
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(built, destination)

  log(`installed ${destination}`)
  log(`needs glibc ${formatVersion(needed)} — runs on Debian 10+, Ubuntu 18.10+, RHEL 8+`)
  log('note: npm install recompiles this locally; re-run this script after one')
} finally {
  rmSync(work, { force: true, recursive: true })
}
