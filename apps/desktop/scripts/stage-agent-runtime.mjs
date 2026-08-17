#!/usr/bin/env node
/**
 * stage-agent-runtime.mjs
 *
 * Builds the self-contained agent runtime that ships inside the desktop app,
 * so a fresh install never clones a repo or reaches the network.
 *
 * Output: apps/desktop/build/agent-runtime/
 *
 *   manifest.json   what was staged, and for which platform
 *   source/         the agent source tree (packages + single-file modules)
 *   wheels/         every core dependency as a wheel, for an offline install
 *   python/         a standalone CPython interpreter
 *
 * On first launch the app copies source/ to ~/.eternal/eternal-agent, builds a
 * venv there with python/, and pip-installs from wheels/ with --no-index. The
 * venv is created ON the user's machine because a venv records absolute paths
 * and cannot be relocated; everything it is built FROM is bundled, so no step
 * needs a network.
 *
 * Only the 32 core dependencies are staged. The 44 extras stay lazy — see
 * tools/lazy_deps.py — so bundling them would add ~250 MB for features most
 * users never enable.
 *
 * Usage:
 *   node scripts/stage-agent-runtime.mjs [--skip-python] [--skip-wheels]
 *                                        [--skip-source] [--platform <p>]
 *                                        [--arch <a>] [--out <dir>]
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const REPO_ROOT = path.resolve(APP_ROOT, '../..')

// python-build-standalone supplies relocatable CPython builds. Bump both
// together; the asset name is derived from them, so a bad pair fails loudly at
// download rather than producing a half-staged bundle.
const PBS_RELEASE = process.env.ETERNAL_PBS_RELEASE || '20250818'
const PY_VERSION = process.env.ETERNAL_PY_VERSION || '3.11.13'

const PBS_TRIPLES = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc'
}

// Directories that must never enter the bundle: the desktop app itself, the
// docs site, the dev venv, and everything git/test related. Keeping these out
// is what takes the source tree from ~2.6 GB to tens of megabytes.
const SOURCE_EXCLUDE_DIRS = new Set([
  '.git',
  '.github',
  '.mypy_cache',
  '.pytest_cache',
  '.pytest-cache',
  '.ruff_cache',
  '__pycache__',
  'apps',
  'contributors',
  'docker',
  'docs',
  'e2e',
  'node_modules',
  'release',
  'tests',
  'venv',
  'website'
])

// Files copied alongside the code. LICENSE and NOTICE travel with the runtime
// because the MIT notice must be present wherever the software is.
const SOURCE_EXTRA_FILES = ['pyproject.toml', 'LICENSE', 'NOTICE', 'README.md']

function log(message) {
  process.stdout.write(`[stage-agent-runtime] ${message}\n`)
}

function fail(message) {
  process.stderr.write(`[stage-agent-runtime] error: ${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const opts = {
    arch: process.arch,
    force: false,
    out: path.join(APP_ROOT, 'build', 'agent-runtime'),
    platform: process.platform,
    skipPython: false,
    skipSource: false,
    skipWheels: false
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--force') opts.force = true
    else if (arg === '--skip-python') opts.skipPython = true
    else if (arg === '--skip-wheels') opts.skipWheels = true
    else if (arg === '--skip-source') opts.skipSource = true
    else if (arg === '--platform') opts.platform = argv[++i]
    else if (arg === '--arch') opts.arch = argv[++i]
    else if (arg === '--out') opts.out = path.resolve(argv[++i])
    else fail(`unknown argument: ${arg}`)
  }

  return opts
}

/**
 * Read the packaging metadata that decides what source ships. Derived from
 * pyproject.toml rather than a hand-written list so adding a package to the
 * project cannot silently omit it from the bundle.
 */
function readPackagingMetadata() {
  // Joined with ';' so every element must be a single complete statement.
  const script = [
    'import json,tomllib',
    'd=tomllib.load(open("pyproject.toml","rb"))',
    'st=d.get("tool",{}).get("setuptools",{})',
    'inc=st.get("packages",{}).get("find",{}).get("include",[])',
    'pkgs=sorted({p.split(".")[0] for p in inc})',
    'print(json.dumps({"dependencies":d["project"]["dependencies"],"packages":pkgs,"pyModules":st.get("py-modules",[])}))'
  ].join(';')

  const result = spawnSync(pythonForBuild(), ['-c', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  })

  if (result.status !== 0) {
    fail(`could not read pyproject.toml:\n${result.stderr || result.stdout}`)
  }

  return JSON.parse(result.stdout)
}

let cachedBuildPython = null

/**
 * A Python good enough to read TOML *and* drive pip. Build-time only.
 *
 * Both capabilities are probed together: the repo's own venv can import
 * tomllib but ships no pip, so probing for tomllib alone selects an
 * interpreter that then fails several minutes later inside pip download.
 */
function pythonForBuild() {
  if (cachedBuildPython) {
    return cachedBuildPython
  }

  const candidates = [
    process.env.ETERNAL_BUILD_PYTHON,
    path.join(REPO_ROOT, 'venv', 'bin', 'python'),
    path.join(REPO_ROOT, 'venv', 'Scripts', 'python.exe'),
    'python3',
    'python'
  ].filter(Boolean)

  const rejected = []

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import tomllib, pip'], { encoding: 'utf8' })

    if (probe.status === 0) {
      cachedBuildPython = candidate

      return candidate
    }

    rejected.push(`  ${candidate}: ${(probe.stderr || 'not runnable').trim().split('\n').pop()}`)
  }

  fail(`no Python 3.11+ with pip found to drive staging (set ETERNAL_BUILD_PYTHON)\n${rejected.join('\n')}`)

  return ''
}

function rmrf(target) {
  fs.rmSync(target, { force: true, recursive: true })
}

/**
 * Copy a directory, dropping excluded directories and compiled artefacts.
 * Returns the number of files written.
 */
function copyTree(from, to) {
  let count = 0

  const walk = (src, dest) => {
    const entries = fs.readdirSync(src, { withFileTypes: true })

    fs.mkdirSync(dest, { recursive: true })

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SOURCE_EXCLUDE_DIRS.has(entry.name)) {
          continue
        }

        walk(path.join(src, entry.name), path.join(dest, entry.name))

        continue
      }

      if (!entry.isFile()) {
        continue
      }

      if (entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo')) {
        continue
      }

      fs.copyFileSync(path.join(src, entry.name), path.join(dest, entry.name))
      count += 1
    }
  }

  walk(from, to)

  return count
}

function stageSource(outDir, meta) {
  const dest = path.join(outDir, 'source')

  log('staging source tree')
  rmrf(dest)
  fs.mkdirSync(dest, { recursive: true })

  let files = 0

  for (const pkg of meta.packages) {
    const src = path.join(REPO_ROOT, pkg)

    if (!fs.existsSync(src)) {
      log(`  skip package ${pkg} (not present)`)
      continue
    }

    files += copyTree(src, path.join(dest, pkg))
  }

  for (const mod of meta.pyModules) {
    const src = path.join(REPO_ROOT, `${mod}.py`)

    if (!fs.existsSync(src)) {
      log(`  skip module ${mod}.py (not present)`)
      continue
    }

    fs.copyFileSync(src, path.join(dest, `${mod}.py`))
    files += 1
  }

  for (const extra of SOURCE_EXTRA_FILES) {
    const src = path.join(REPO_ROOT, extra)

    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(dest, extra))
      files += 1
    }
  }

  // The launch gate proves a runtime is real by looking for this exact file
  // (isEternalSourceRoot in electron/main.ts). If it is missing the seeded
  // install is silently ignored and the app falls back to network bootstrap,
  // so fail the build instead of shipping a bundle that cannot be used.
  const sentinel = path.join(dest, 'eternal_cli', 'main.py')

  if (!fs.existsSync(sentinel)) {
    fail(`staged source is missing ${path.relative(dest, sentinel)} — the app would reject this runtime`)
  }

  log(`  staged ${files} files`)

  return files
}

function stageWheels(outDir, meta, opts, stagedPython) {
  const dest = path.join(outDir, 'wheels')

  log(`downloading ${meta.dependencies.length} core dependencies as wheels`)
  rmrf(dest)
  fs.mkdirSync(dest, { recursive: true })

  const args = [
    '-m',
    'pip',
    'download',
    '--dest',
    dest,
    '--only-binary=:all:',
    ...meta.dependencies
  ]

  // Download WITH the interpreter the wheels will be installed into. The build
  // machine's Python is a different version (3.14 here vs the bundled 3.11), so
  // resolving against it yields cp314 wheels that the bundled interpreter then
  // refuses with "no matching distribution" — offline, at first launch, on the
  // user's machine. Using the staged interpreter makes the ABI match by
  // construction rather than by keeping flags in sync.
  const native = opts.platform === process.platform && opts.arch === process.arch
  const canUseStaged = native && stagedPython && fs.existsSync(stagedPython)
  const interpreter = canUseStaged ? stagedPython : pythonForBuild()

  if (canUseStaged) {
    log(`  resolving against the bundled interpreter (${PY_VERSION})`)
  } else {
    // Cross-staging, or no interpreter staged yet: pin the full target ABI by
    // hand. pip cannot build sdists for a foreign target, hence --only-binary.
    const tag = wheelPlatformTag(opts)

    if (!tag) {
      fail(`cannot cross-stage wheels for ${opts.platform}-${opts.arch}`)
    }

    const [major, minor] = PY_VERSION.split('.')

    log(`  cross-resolving for ${tag} / cp${major}${minor}`)
    args.push(
      '--platform',
      tag,
      '--python-version',
      `${major}.${minor}`,
      '--implementation',
      'cp',
      '--abi',
      `cp${major}${minor}`
    )
  }

  const result = spawnSync(interpreter, args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'inherit' })

  if (result.status !== 0) {
    fail('pip download failed — see output above')
  }

  const wheels = fs.readdirSync(dest).filter(name => name.endsWith('.whl'))

  log(`  staged ${wheels.length} wheels`)
  stageRequirements(outDir, wheels)

  return wheels.length
}

/**
 * Pin every staged wheel into requirements.txt, which the first-run seeder
 * installs with --no-index.
 *
 * `pip download` has already resolved the full transitive set, so pinning the
 * resolved filenames means the offline install repeats that exact resolution
 * instead of re-solving against whatever happens to be in wheels/. A wheel
 * filename is `{name}-{version}-{tags...}.whl`, so the first two
 * hyphen-separated fields are what we need.
 */
function stageRequirements(outDir, wheels) {
  const pins = wheels
    .map(name => {
      const parts = name.slice(0, -'.whl'.length).split('-')

      return parts.length >= 2 ? `${parts[0]}==${parts[1]}` : null
    })
    .filter(Boolean)
    .sort()

  if (pins.length !== wheels.length) {
    fail(`could not derive a pin for every wheel (${pins.length} of ${wheels.length})`)
  }

  fs.writeFileSync(
    path.join(outDir, 'requirements.txt'),
    `# Generated by stage-agent-runtime.mjs — installed offline from wheels/.\n${pins.join('\n')}\n`
  )

  log(`  wrote requirements.txt (${pins.length} pins)`)
}

function wheelPlatformTag(opts) {
  const key = `${opts.platform}-${opts.arch}`

  return {
    'darwin-arm64': 'macosx_11_0_arm64',
    'darwin-x64': 'macosx_10_12_x86_64',
    'linux-arm64': 'manylinux2014_aarch64',
    'linux-x64': 'manylinux2014_x86_64',
    'win32-x64': 'win_amd64'
  }[key]
}

// Parts of the standalone distribution a headless agent never uses. Each entry
// is justified, because a wrong guess here fails at the user's first launch:
//
//  * libpython3.11.so — the shipped `python3.11` is statically linked and no
//    stdlib extension in lib-dynload links it. manylinux wheels are forbidden
//    from linking libpython too, so nothing in wheels/ can need it either.
//  * tcl/tk, tkinter, idlelib, turtledemo — the GUI toolkit and its demos. The
//    backend runs headless; no core dependency imports tkinter.
//  * terminfo — the bundled ncurses terminal database. Every OS ships its own
//    at /usr/share/terminfo (or /lib/terminfo), which ncurses finds by default.
//  * man pages — documentation.
//
// `include/` and `config-3.11-*` are deliberately KEPT: lazy_deps.py pip-installs
// optional extras at runtime, and building a C extension needs both.
const PYTHON_TRIM_PATHS = [
  'lib/libpython3.11.so.1.0',
  'lib/libtcl8.6.so',
  'lib/libtk8.6.so',
  'lib/tcl8',
  'lib/tcl8.6',
  'lib/tk8.6',
  'lib/itcl4.2.4',
  'lib/python3.11/tkinter',
  'lib/python3.11/idlelib',
  'lib/python3.11/turtledemo',
  'share/terminfo',
  'share/man'
]

// Imports proving the trim did not remove something load-bearing. Covers the
// C extensions most likely to break (TLS, FFI, compression, sqlite) plus the
// terminal stack that terminfo removal could plausibly affect.
const PYTHON_TRIM_PROBE =
  'import ssl, ctypes, sqlite3, zlib, lzma, bz2, hashlib, curses, readline, socket, decimal'

/**
 * Drop the parts of the interpreter a headless agent cannot use, then prove the
 * remainder still imports. Trimming without the probe would move a packaging
 * mistake to the user's first launch, where it is far more expensive to find.
 */
function trimPython(pythonDir, opts) {
  if (opts.platform !== 'linux') {
    // The path list above is the POSIX/Linux layout. Other platforms ship a
    // different tree; trimming them blind would delete the wrong things.
    log('  skipping trim (only mapped for linux)')

    return
  }

  let freed = 0

  for (const relative of PYTHON_TRIM_PATHS) {
    const target = path.join(pythonDir, relative)

    if (!fs.existsSync(target)) {
      continue
    }

    freed += directorySize(target)
    rmrf(target)
  }

  const interpreter = path.join(pythonDir, 'bin', 'python3')
  const probe = spawnSync(interpreter, ['-c', PYTHON_TRIM_PROBE], { encoding: 'utf8' })

  if (probe.status !== 0) {
    fail(`trimmed interpreter fails to import core modules:\n${probe.stderr || probe.stdout}`)
  }

  log(`  trimmed ${(freed / 1e6).toFixed(0)} MB from the interpreter`)
}

/** Where the staged interpreter lives. Mirrors bundledPythonPath() in electron/seed-bundled-runtime.ts. */
function bundledInterpreterPath(outDir, platform) {
  return platform === 'win32'
    ? path.join(outDir, 'python', 'python.exe')
    : path.join(outDir, 'python', 'bin', 'python3')
}

async function stagePython(outDir, opts) {
  const dest = path.join(outDir, 'python')
  const key = `${opts.platform}-${opts.arch}`
  const triple = PBS_TRIPLES[key]

  if (!triple) {
    fail(`no standalone CPython mapping for ${key}`)
  }

  const asset = `cpython-${PY_VERSION}+${PBS_RELEASE}-${triple}-install_only.tar.gz`
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${asset}`

  log(`downloading standalone CPython ${PY_VERSION} (${triple})`)
  rmrf(dest)
  fs.mkdirSync(dest, { recursive: true })

  const archive = path.join(outDir, asset)
  const response = await fetch(url, { redirect: 'follow' })

  if (!response.ok) {
    fail(
      `could not download ${asset} (HTTP ${response.status}).\n` +
        `  Bump ETERNAL_PBS_RELEASE / ETERNAL_PY_VERSION to a pair that exists:\n` +
        '  https://github.com/astral-sh/python-build-standalone/releases'
    )
  }

  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()))

  // --strip-components=1 drops the archive's own `python/` wrapper so the
  // interpreter lands at <dest>/bin/python3, matching what the seeder expects.
  execFileSync('tar', ['-xzf', archive, '-C', dest, '--strip-components=1'], { stdio: 'inherit' })
  fs.rmSync(archive, { force: true })

  trimPython(dest, opts)

  const interpreter = bundledInterpreterPath(outDir, opts.platform)

  if (!fs.existsSync(interpreter)) {
    fail(`extracted CPython is missing ${path.relative(dest, interpreter)}`)
  }

  log('  staged standalone CPython')

  return interpreter
}

function directorySize(target) {
  let total = 0

  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        total += fs.statSync(full).size
      }
    }
  }

  if (!fs.existsSync(target)) {
    return 0
  }

  // Callers pass both directories and single files (the trim list has both),
  // and readdirSync throws ENOTDIR on a file.
  if (!fs.statSync(target).isDirectory()) {
    return fs.statSync(target).size
  }

  walk(target)

  return total
}

/**
 * True when a previous run already staged this exact target. Packaging runs on
 * every `npm run dist`, and re-downloading ~220 MB each time would make routine
 * builds unusable. `--force` re-stages regardless.
 */
function isAlreadyStaged(opts) {
  const manifestPath = path.join(opts.out, 'manifest.json')

  if (!fs.existsSync(manifestPath)) {
    return false
  }

  let manifest

  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    return false
  }

  if (
    manifest.arch !== opts.arch ||
    manifest.platform !== opts.platform ||
    manifest.pythonVersion !== PY_VERSION
  ) {
    return false
  }

  return (
    fs.existsSync(path.join(opts.out, 'source', 'eternal_cli', 'main.py')) &&
    fs.existsSync(path.join(opts.out, 'requirements.txt')) &&
    fs.existsSync(bundledInterpreterPath(opts.out, opts.platform))
  )
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (!opts.force && isAlreadyStaged(opts)) {
    log(`already staged for ${opts.platform}-${opts.arch} (Python ${PY_VERSION}) — use --force to re-stage`)

    return
  }

  fs.mkdirSync(opts.out, { recursive: true })

  const meta = readPackagingMetadata()

  if (!opts.skipSource) {
    stageSource(opts.out, meta)
  }

  // Python BEFORE wheels: stageWheels resolves against the staged interpreter
  // so the downloaded ABI matches what will install them. When --skip-python is
  // passed, reuse an interpreter staged by an earlier run if one is there.
  let stagedPython = bundledInterpreterPath(opts.out, opts.platform)

  if (!opts.skipPython) {
    stagedPython = await stagePython(opts.out, opts)
  } else if (!fs.existsSync(stagedPython)) {
    stagedPython = null
  }

  if (!opts.skipWheels) {
    stageWheels(opts.out, meta, opts, stagedPython)
  }

  const manifest = {
    arch: opts.arch,
    dependencyCount: meta.dependencies.length,
    platform: opts.platform,
    pythonVersion: PY_VERSION,
    schemaVersion: 1,
    stagedAt: new Date().toISOString()
  }

  fs.writeFileSync(path.join(opts.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  log(`done — ${(directorySize(opts.out) / 1e6).toFixed(0)} MB at ${opts.out}`)
}

await main()
