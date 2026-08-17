/**
 * seed-bundled-runtime.ts
 *
 * Materialises the agent runtime that ships inside the app (staged by
 * scripts/stage-agent-runtime.mjs) into ~/.eternal/eternal-agent, so a fresh
 * install never clones a repo or downloads an installer.
 *
 * This runs immediately BEFORE activeRuntimeState() in main.ts. Once seeding
 * succeeds, isActiveRuntimeUsable() sees a real source tree and a real venv, so
 * the normal launch path takes over and the network bootstrap is never reached.
 * Nothing downstream needs to know seeding happened — which is why this module
 * deliberately writes no bootstrap marker: classifyActiveRuntime() treats
 * runtime usability as authoritative, and claiming a bootstrap we did not run
 * would misreport provenance.
 *
 * The venv is created here rather than shipped because a venv records absolute
 * paths (pyvenv.cfg, script shebangs) and cannot be relocated. Everything it is
 * built from — interpreter and wheels — is bundled, so the install is offline.
 *
 * Every dependency is injectable so the whole flow is unit-testable without
 * Electron, a filesystem, or a Python.
 */

import path from 'node:path'

export type SeedOutcome =
  | 'already-usable'
  | 'no-bundle'
  | 'seeded'
  | 'failed'

export interface SeedResult {
  durationMs?: number
  error?: string
  outcome: SeedOutcome
}

export interface RunResult {
  status: number | null
  stderr?: string
  stdout?: string
}

export interface SeedDeps {
  copyDir: (from: string, to: string) => void
  existsSync: (target: string) => boolean
  log?: (message: string) => void
  mkdirSync: (target: string) => void
  now?: () => number
  platform?: NodeJS.Platform
  run: (command: string, args: string[]) => RunResult
}

export interface SeedOptions {
  activeRoot: string
  bundleDir: string | null | undefined
  venvRoot: string
}

/** The interpreter inside a staged bundle. */
export function bundledPythonPath(bundleDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? path.join(bundleDir, 'python', 'python.exe')
    : path.join(bundleDir, 'python', 'bin', 'python3')
}

/** The interpreter inside a venv, matching findPythonForRoot() in main.ts. */
export function venvPythonPath(venvRoot: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? path.join(venvRoot, 'Scripts', 'python.exe')
    : path.join(venvRoot, 'bin', 'python')
}

/**
 * A bundle is only usable when all three parts are present. A partial bundle
 * (an interrupted build, a packager that dropped a directory) must be ignored
 * rather than half-installed, so the app can still fall back to bootstrap.
 */
export function isBundleUsable(
  bundleDir: string | null | undefined,
  deps: Pick<SeedDeps, 'existsSync' | 'platform'>
): boolean {
  if (!bundleDir) {
    return false
  }

  const { existsSync, platform = process.platform } = deps

  return (
    existsSync(path.join(bundleDir, 'manifest.json')) &&
    // The same sentinel isEternalSourceRoot() checks for. If it is absent the
    // seeded tree would be rejected after we had already copied it.
    existsSync(path.join(bundleDir, 'source', 'eternal_cli', 'main.py')) &&
    existsSync(path.join(bundleDir, 'wheels')) &&
    existsSync(bundledPythonPath(bundleDir, platform))
  )
}

/** Is the on-disk install already good enough to launch? */
export function isActiveRootSeeded(
  activeRoot: string,
  venvRoot: string,
  deps: Pick<SeedDeps, 'existsSync' | 'platform'>
): boolean {
  const { existsSync, platform = process.platform } = deps

  return (
    existsSync(path.join(activeRoot, 'eternal_cli', 'main.py')) &&
    existsSync(venvPythonPath(venvRoot, platform))
  )
}

function describeFailure(step: string, result: RunResult): string {
  const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-4).join('\n')

  return `${step} failed (exit ${result.status})${detail ? `:\n${detail}` : ''}`
}

/**
 * Seed the active runtime from the bundle. Idempotent: an install that is
 * already usable is left completely alone.
 */
export function seedBundledRuntime(options: SeedOptions, deps: SeedDeps): SeedResult {
  const { activeRoot, bundleDir, venvRoot } = options
  const { copyDir, existsSync, log = () => {}, mkdirSync, now = () => Date.now(), platform = process.platform, run } = deps

  if (isActiveRootSeeded(activeRoot, venvRoot, { existsSync, platform })) {
    return { outcome: 'already-usable' }
  }

  if (!isBundleUsable(bundleDir, { existsSync, platform })) {
    return { outcome: 'no-bundle' }
  }

  const bundle = bundleDir as string
  const startedAt = now()

  try {
    log(`[seed] installing bundled runtime into ${activeRoot}`)
    mkdirSync(activeRoot)
    copyDir(path.join(bundle, 'source'), activeRoot)

    // Copy the interpreter OUT of the bundle before building the venv against
    // it. `venv --copies` copies the binary but pyvenv.cfg still records the
    // CREATING interpreter's path in `home`/`executable`, and CPython reads
    // `home` to locate its standard library. Building straight from
    // bundleDir therefore bakes the app's own directory into the venv.
    //
    // For an AppImage that is fatal rather than merely fragile: it mounts at a
    // fresh /tmp/.mount_XXXXXX every launch, so the path recorded on first run
    // is gone by the second. The venv's python then dies with "No module named
    // 'encodings'", the runtime reads as unusable, and the app drops back to
    // first-run setup on every subsequent launch -- it works exactly once.
    //
    // Copying to activeRoot/python first gives pyvenv.cfg a path that outlives
    // the mount. Costs ~80 MB on disk, which is the right trade for a runtime
    // that survives a restart.
    const stablePythonRoot = path.join(activeRoot, 'python')
    log('[seed] installing interpreter')
    copyDir(path.join(bundle, 'python'), stablePythonRoot)

    const bundledPython = bundledPythonPath(activeRoot, platform)

    log('[seed] creating venv')

    // --copies, not symlinks: a symlink back into the bundle would break for
    // the same reason described above.
    const venvResult = run(bundledPython, ['-m', 'venv', '--copies', venvRoot])

    if (venvResult.status !== 0) {
      return { error: describeFailure('venv creation', venvResult), outcome: 'failed' }
    }

    log('[seed] installing dependencies offline')

    // --no-index makes the offline guarantee explicit: if a wheel is missing
    // pip fails here rather than quietly reaching PyPI, which would turn a
    // packaging bug into a silent network dependency on first launch.
    const pipResult = run(venvPythonPath(venvRoot, platform), [
      '-m',
      'pip',
      'install',
      '--no-index',
      '--no-cache-dir',
      `--find-links=${path.join(bundle, 'wheels')}`,
      '--requirement',
      path.join(bundle, 'requirements.txt')
    ])

    if (pipResult.status !== 0) {
      return { error: describeFailure('offline dependency install', pipResult), outcome: 'failed' }
    }

    const durationMs = now() - startedAt

    log(`[seed] bundled runtime ready in ${Math.round(durationMs / 1000)}s`)

    return { durationMs, outcome: 'seeded' }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), outcome: 'failed' }
  }
}
