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
 * The core dependencies are staged, plus the few extras in BUNDLED_EXTRAS that
 * the desktop app cannot work without. Every other extra stays lazy — see
 * tools/lazy_deps.py — because bundling them all would add ~250 MB for features
 * most users never enable.
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

import { compareVersions, formatVersion, GLIBC_CEILING } from './portable-glibc.mjs'
import { isMain } from './utils.mjs'

const APP_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const REPO_ROOT = path.resolve(APP_ROOT, '../..')

// python-build-standalone supplies relocatable CPython builds. Bump both
// together; the asset name is derived from them, so a bad pair fails loudly at
// download rather than producing a half-staged bundle.
//
// The pair is ALSO constrained by the SQLite the artifact links: assertSafeSqlite
// below refuses anything carrying the WAL-reset corruption bug. 3.11.13+20250818
// linked SQLite 3.49.1 and shipped every install with WAL disabled; 3.11.14 is no
// better (every published artifact for it links 3.50.4). 3.11.15 is the first
// patch whose builds link a fixed SQLite (3.53.1). Verify with a real download,
// never by reading version numbers — PBS re-releases the same CPython patch
// version with different builds.
const PBS_RELEASE = process.env.ETERNAL_PBS_RELEASE || '20260728'
const PY_VERSION = process.env.ETERNAL_PY_VERSION || '3.11.15'

// Platforms whose bundle has actually been built and launched. The staging and
// seeding code is written for the others, but none of it has been run, and the
// interpreter trim list only maps the Linux layout — so a Windows or macOS
// build would ship an untrimmed, unverified runtime that fails at the user's
// first launch rather than at build time. Refuse instead, and make opting in an
// explicit act.
const VERIFIED_PLATFORMS = new Set(['linux'])
const UNVERIFIED_OVERRIDE = 'ETERNAL_ALLOW_UNVERIFIED_PLATFORM'

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

// Extras from pyproject.toml's [project.optional-dependencies] that ship in the
// bundle instead of being lazy-installed.
//
//  * mcp — the MCP client library. Without it every MCP server the user adds
//    fails ("requires HTTP transport but mcp.client.streamable_http is not
//    available"), and nothing installs it on demand: tools/mcp_tool.py only
//    checks whether the package is present, it never asks lazy_deps for it.
//    It is also small (~10 wheels, a few MB), unlike the extras kept lazy.
//
// The specs are read from pyproject.toml, never copied here, so bumping the
// pin there is all it takes to bump what ships.
export const BUNDLED_EXTRAS = Object.freeze(['mcp'])

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
    'print(json.dumps({"dependencies":d["project"]["dependencies"],"extras":d["project"].get("optional-dependencies",{}),"packages":pkgs,"pyModules":st.get("py-modules",[])}))'
  ].join(';')

  const result = spawnSync(pythonForBuild(), ['-c', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  })

  if (result.status !== 0) {
    fail(`could not read pyproject.toml:\n${result.stderr || result.stdout}`)
  }

  const meta = JSON.parse(result.stdout)

  try {
    meta.requested = requestedSpecs(meta)
  } catch (err) {
    fail(err.message)
  }

  return meta
}

/**
 * The specs of the extras named in `names`, exactly as pyproject.toml lists
 * them. Throws rather than skipping a missing extra: a renamed extra must fail
 * the build, not quietly ship an app whose MCP support is gone again.
 */
export function bundledExtraSpecs(extras, names = BUNDLED_EXTRAS) {
  const specs = []

  for (const name of names) {
    const list = extras?.[name]

    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`pyproject.toml has no [project.optional-dependencies] "${name}" extra to bundle`)
    }

    for (const spec of list) {
      // A self-reference ("eternal-agent[...]") would make pip download the
      // project itself, which is not on PyPI under that name.
      if (/^eternal-agent\b/i.test(spec.trim())) {
        throw new Error(`bundled extra "${name}" refers back to the project (${spec}); list its packages directly`)
      }

      specs.push(spec)
    }
  }

  return specs
}

/** Everything pip is asked to download: the core dependencies plus the bundled extras. */
export function requestedSpecs(meta, names = BUNDLED_EXTRAS) {
  return [...meta.dependencies, ...bundledExtraSpecs(meta.extras, names)]
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

  log(
    `downloading ${meta.dependencies.length} core dependencies + bundled extras ` +
      `(${BUNDLED_EXTRAS.join(', ')}) as wheels`
  )
  rmrf(dest)
  fs.mkdirSync(dest, { recursive: true })

  const args = [
    '-m',
    'pip',
    'download',
    '--dest',
    dest,
    '--only-binary=:all:',
    ...meta.requested
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

  const tags = targetPlatformTags(opts)

  if (canUseStaged) {
    log(`  resolving against the bundled interpreter (${PY_VERSION})`)

    // Left to itself pip picks the newest wheel THIS machine can run. On a
    // rolling distro that is a wheel needing a glibc no user has — it picked
    // cryptography's manylinux_2_34 build here — and the offline install then
    // fails on Debian 11 / Ubuntu 20.04 with nothing on disk to fall back to.
    // Listing the platform tags caps it at GLIBC_CEILING instead.
    if (opts.platform === 'linux') {
      if (!tags) {
        fail(`no manylinux platform tags for linux-${opts.arch}`)
      }

      log(`  capping wheels at glibc ${formatVersion(GLIBC_CEILING)}`)
      args.push(...tags.flatMap(tag => ['--platform', tag]))
    }
  } else {
    // Cross-staging, or no interpreter staged yet: pin the full target ABI by
    // hand. pip cannot build sdists for a foreign target, hence --only-binary.
    if (!tags) {
      fail(`cannot cross-stage wheels for ${opts.platform}-${opts.arch}`)
    }

    const [major, minor] = PY_VERSION.split('.')

    log(`  cross-resolving for ${tags[0]} / cp${major}${minor}`)
    args.push(
      ...tags.flatMap(tag => ['--platform', tag]),
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

  // The tags above decide what pip prefers; this proves what landed. A wheel
  // published only for a newer glibc would otherwise ship and fail offline at
  // the user's first launch.
  if (opts.platform === 'linux') {
    const tooNew = wheels.filter(name => !wheelFitsGlibcCeiling(name))

    if (tooNew.length > 0) {
      fail(
        `these wheels need a newer glibc than ${formatVersion(GLIBC_CEILING)} (Debian 11 / Ubuntu 20.04):\n` +
          tooNew.map(name => `  ${name}`).join('\n')
      )
    }
  }

  stageRequirements(outDir, wheels, bundledExtraSpecs(meta.extras))

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
function stageRequirements(outDir, wheels, mustInclude = []) {
  const pins = pinsFromWheels(wheels)

  if (pins.length !== wheels.length) {
    fail(`could not derive a pin for every wheel (${pins.length} of ${wheels.length})`)
  }

  const missing = missingPins(pins, mustInclude)

  if (missing.length > 0) {
    fail(`requirements.txt would not pin the bundled extras' packages: ${missing.join(', ')}`)
  }

  fs.writeFileSync(
    path.join(outDir, 'requirements.txt'),
    `# Generated by stage-agent-runtime.mjs — installed offline from wheels/.\n${pins.join('\n')}\n`
  )

  log(`  wrote requirements.txt (${pins.length} pins)`)
}

/** `name==version` for every wheel filename, sorted. Unparseable names are dropped. */
export function pinsFromWheels(wheels) {
  return wheels
    .map(name => {
      const parts = name.slice(0, -'.whl'.length).split('-')

      return parts.length >= 2 ? `${parts[0]}==${parts[1]}` : null
    })
    .filter(Boolean)
    .sort()
}

/** PEP 503 name normalisation, so `pydantic-settings` matches `pydantic_settings`. */
function normalizeName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

/**
 * The exact-version specs (`name==1.2.3`) in `specs` that `pins` does not
 * contain. Range specs are skipped: only an exact pin says which wheel must be
 * present.
 */
export function missingPins(pins, specs) {
  const have = new Set(
    pins.map(pin => {
      const [name, version] = pin.split('==')

      return `${normalizeName(name)}==${version}`
    })
  )

  return specs
    .map(spec => spec.split(';')[0].trim())
    .map(spec => /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*==\s*([^\s,]+)$/.exec(spec))
    .filter(Boolean)
    .filter(([, name, version]) => !have.has(`${normalizeName(name)}==${version}`))
    .map(([, name, version]) => `${name}==${version}`)
}

/**
 * Every Linux platform tag a wheel may carry and still run on GLIBC_CEILING,
 * newest first. pip only widens the legacy `manylinux2014`/`2010` aliases on
 * its own, so a `--platform manylinux_2_31_x86_64` alone would reject the many
 * wheels tagged only manylinux_2_17 or manylinux_2_28.
 */
export function manylinuxPlatformTags(arch, ceiling = GLIBC_CEILING) {
  const machine = { arm64: 'aarch64', x64: 'x86_64' }[arch]

  if (!machine || ceiling[0] !== 2) {
    return null
  }

  // manylinux on aarch64 starts at glibc 2.17; x86_64 goes back to 2.5.
  const oldest = machine === 'x86_64' ? 5 : 17
  const tags = []

  for (let minor = ceiling[1]; minor >= oldest; minor -= 1) {
    tags.push(`manylinux_2_${minor}_${machine}`)
  }

  tags.push(`manylinux2014_${machine}`)

  if (machine === 'x86_64') {
    tags.push(`manylinux2010_${machine}`, `manylinux1_${machine}`)
  }

  return tags
}

const LEGACY_MANYLINUX = { manylinux1: [2, 5], manylinux2010: [2, 12], manylinux2014: [2, 17] }

/**
 * True when a wheel can install on a glibc no newer than `ceiling`: it is pure
 * Python, or at least one of its platform tags asks for that glibc or older.
 * A wheel filename ends `-{python}-{abi}-{platform}.whl`, and the platform
 * field may hold several tags joined with dots.
 */
export function wheelFitsGlibcCeiling(filename, ceiling = GLIBC_CEILING) {
  const platforms = filename.slice(0, -'.whl'.length).split('-').pop().split('.')

  return platforms.some(tag => {
    if (tag === 'any') {
      return true
    }

    const modern = /^manylinux_(\d+)_(\d+)_/.exec(tag)
    const needed = modern ? [Number(modern[1]), Number(modern[2])] : LEGACY_MANYLINUX[tag.split('_')[0]]

    return Boolean(needed) && compareVersions(needed, ceiling) <= 0
  })
}

/** The platform tags pip should resolve for, or null when the target is unmapped. */
function targetPlatformTags(opts) {
  if (opts.platform === 'linux') {
    return manylinuxPlatformTags(opts.arch)
  }

  const tag = wheelPlatformTag(opts)

  return tag ? [tag] : null
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

/**
 * Refuse to bundle an interpreter whose linked SQLite has the WAL-reset bug.
 *
 * Eternal detects this at runtime and protects itself by falling back to
 * journal_mode=DELETE, so a bad interpreter does not corrupt anyone's data — it
 * quietly makes every install slower, forever, and then advises the user to run
 * `eternal update`, which cannot repair a packaged app. Build time is the only
 * place the fix is cheap, so refuse here rather than warn there.
 *
 * The rule is deliberately NOT reimplemented in JS: this calls
 * eternal_cli.sqlite_runtime (stdlib-only by design, so it imports on a bare
 * staged interpreter), which keeps the bundle and the runtime from ever
 * disagreeing about what counts as vulnerable. And it probes the artifact that
 * was actually downloaded — PBS re-publishes the same CPython patch version with
 * different builds, so PY_VERSION alone proves nothing.
 */
function assertSafeSqlite(interpreter) {
  const script = [
    'import json, sqlite3',
    'from eternal_cli.sqlite_runtime import is_sqlite_wal_reset_vulnerable',
    'print(json.dumps({',
    '    "version": sqlite3.sqlite_version,',
    '    "vulnerable": bool(is_sqlite_wal_reset_vulnerable(sqlite3.sqlite_version_info)),',
    '}))'
  ].join('\n')

  const probe = spawnSync(interpreter, ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT }
  })

  if (probe.status !== 0) {
    fail(`could not read the staged interpreter's SQLite version:\n${probe.stderr || probe.stdout}`)
  }

  let result

  try {
    result = JSON.parse(String(probe.stdout).trim().split('\n').pop())
  } catch {
    fail(`unexpected SQLite probe output from the staged interpreter:\n${probe.stdout}`)
  }

  if (result.vulnerable) {
    fail(
      `the staged CPython links SQLite ${result.version}, which carries the WAL-reset ` +
        'corruption bug (https://sqlite.org/wal.html#walresetbug).\n' +
        '  Every install built from this bundle would run with WAL disabled.\n' +
        '  Choose a python-build-standalone pair whose SQLite is 3.51.3+ (or the\n' +
        '  3.50.7 / 3.44.6 backports) and bump ETERNAL_PY_VERSION / ETERNAL_PBS_RELEASE:\n' +
        '  https://github.com/astral-sh/python-build-standalone/releases'
    )
  }

  log(`  SQLite ${result.version} — clear of the WAL-reset bug`)
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
 * Does a manifest describe wheels staged for this target AND this dependency
 * list? The list is part of the key because wheels/ is reused on a cache hit:
 * keyed on platform alone, a machine that staged once would keep shipping its
 * old wheels forever, and adding mcp to the bundle would never reach a build
 * there. Manifests written before the list was recorded never match.
 */
export function manifestMatches(manifest, opts, requested) {
  return (
    manifest.arch === opts.arch &&
    manifest.platform === opts.platform &&
    manifest.pythonVersion === PY_VERSION &&
    Array.isArray(manifest.requested) &&
    JSON.stringify([...manifest.requested].sort()) === JSON.stringify([...requested].sort()) &&
    JSON.stringify(manifest.glibcCeiling) === JSON.stringify(GLIBC_CEILING)
  )
}

/**
 * True when a previous run already staged this exact target. Packaging runs on
 * every `npm run dist`, and re-downloading ~220 MB each time would make routine
 * builds unusable. `--force` re-stages regardless.
 */
function isAlreadyStaged(opts, meta) {
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

  if (!manifestMatches(manifest, opts, meta.requested)) {
    return false
  }

  return (
    fs.existsSync(path.join(opts.out, 'source', 'eternal_cli', 'main.py')) &&
    fs.existsSync(path.join(opts.out, 'requirements.txt')) &&
    fs.existsSync(bundledInterpreterPath(opts.out, opts.platform))
  )
}

/**
 * Check the interpreter that will actually be packaged, whatever produced it.
 *
 * Deliberately not folded into stagePython: routine builds hit the
 * already-staged path and never download an interpreter at all, so a check that
 * lived beside the download would quietly never run — worse than no check,
 * because the build would still look verified. This runs on every invocation and
 * inspects what is on disk.
 *
 * A missing interpreter is not this function's business; the staging paths and
 * the seeder each report that in their own terms.
 */
function verifyStagedInterpreter(opts) {
  const interpreter = bundledInterpreterPath(opts.out, opts.platform)

  if (!fs.existsSync(interpreter)) {
    return
  }

  assertSafeSqlite(interpreter)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (!VERIFIED_PLATFORMS.has(opts.platform) && !process.env[UNVERIFIED_OVERRIDE]) {
    fail(
      `staging is only verified on ${[...VERIFIED_PLATFORMS].join(', ')}; refusing to build a ${opts.platform} bundle.\n` +
        '  Nothing about the non-Linux path has been run end-to-end, and the\n' +
        '  interpreter trim list only maps the Linux layout, so the result would\n' +
        '  ship unverified and fail at a user\'s first launch instead of here.\n' +
        `  Set ${UNVERIFIED_OVERRIDE}=1 to stage one anyway and test it yourself.`
    )
  }

  const meta = readPackagingMetadata()

  if (!opts.force && isAlreadyStaged(opts, meta)) {
    // The cache key is platform/arch/pythonVersion plus the dependency list
    // (see manifestMatches) — it says nothing about the SOURCE. Returning here outright meant every Python change silently
    // failed to reach the bundle: you could fix a backend bug, rebuild, ship,
    // and users would still run the tree that was staged first. That is how a
    // rebuilt AppImage kept serving a provider that had been deleted from the
    // repo hours earlier.
    //
    // Python and wheels are the expensive parts (an 80 MB interpreter download
    // and ~40 MB of wheels resolved against it), and they genuinely are keyed
    // by platform/arch/version/dependency list — keep caching those. Source is a 42 MB local copy
    // that takes well under a second, so re-stage it unconditionally rather
    // than trying to guess whether it changed.
    if (opts.skipSource) {
      log(`already staged for ${opts.platform}-${opts.arch} (Python ${PY_VERSION}); --skip-source given, leaving source as-is`)
      verifyStagedInterpreter(opts)

      return
    }

    log(`already staged for ${opts.platform}-${opts.arch} (Python ${PY_VERSION}) — refreshing source, reusing interpreter + wheels`)
    stageSource(opts.out, meta)
    verifyStagedInterpreter(opts)

    return
  }

  fs.mkdirSync(opts.out, { recursive: true })

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

  verifyStagedInterpreter(opts)

  // The manifest describes what is on disk, so only rewrite it when this run
  // actually staged something. Skipping every stage and still stamping the
  // manifest relabels an existing bundle as a platform it was never built for,
  // which then reads as up-to-date to isAlreadyStaged().
  if (opts.skipSource && opts.skipWheels && opts.skipPython) {
    log('nothing staged; leaving the existing manifest untouched')

    return
  }

  // What wheels/ was resolved from is only recorded when this run resolved it.
  // After --skip-wheels nobody knows what is in there, so leave it unrecorded
  // and let the next run re-stage rather than vouch for it.
  const wheelsKey = opts.skipWheels
    ? {}
    : { bundledExtras: [...BUNDLED_EXTRAS], glibcCeiling: [...GLIBC_CEILING], requested: meta.requested }

  const manifest = {
    arch: opts.arch,
    dependencyCount: meta.requested.length,
    platform: opts.platform,
    pythonVersion: PY_VERSION,
    schemaVersion: 1,
    stagedAt: new Date().toISOString(),
    ...wheelsKey
  }

  fs.writeFileSync(path.join(opts.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  log(`done — ${(directorySize(opts.out) / 1e6).toFixed(0)} MB at ${opts.out}`)
}

if (isMain(import.meta.url)) {
  await main()
}
