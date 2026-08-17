import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  bundledPythonPath,
  isActiveRootSeeded,
  isBundleUsable,
  type RunResult,
  seedBundledRuntime,
  type SeedDeps,
  venvPythonPath
} from './seed-bundled-runtime'

const BUNDLE = '/app/resources/agent-runtime'
const ACTIVE = '/home/u/.eternal/eternal-agent'
const VENV = path.join(ACTIVE, 'venv')

/** Every path a complete POSIX bundle contains, plus nothing else. */
function completeBundle(): string[] {
  return [
    path.join(BUNDLE, 'manifest.json'),
    path.join(BUNDLE, 'source', 'eternal_cli', 'main.py'),
    path.join(BUNDLE, 'wheels'),
    path.join(BUNDLE, 'python', 'bin', 'python3')
  ]
}

function makeDeps(present: string[], run?: SeedDeps['run']): SeedDeps & { calls: string[][] } {
  const existing = new Set(present)
  const calls: string[][] = []

  return {
    calls,
    copyDir: vi.fn(),
    existsSync: (target: string) => existing.has(target),
    mkdirSync: vi.fn(),
    now: (() => {
      let t = 0

      return () => (t += 1000)
    })(),
    platform: 'linux',
    run:
      run ||
      ((command: string, args: string[]): RunResult => {
        calls.push([command, ...args])

        // Model the real side effect: creating the venv makes its interpreter
        // exist, which the pip step then invokes.
        if (args[1] === 'venv') {
          existing.add(venvPythonPath(VENV, 'linux'))
        }

        return { status: 0 }
      })
  }
}

describe('bundle layout', () => {
  it('locates the interpreter per platform', () => {
    expect(bundledPythonPath(BUNDLE, 'linux')).toBe(path.join(BUNDLE, 'python', 'bin', 'python3'))
    expect(bundledPythonPath(BUNDLE, 'win32')).toBe(path.join(BUNDLE, 'python', 'python.exe'))
    expect(venvPythonPath(VENV, 'linux')).toBe(path.join(VENV, 'bin', 'python'))
    expect(venvPythonPath(VENV, 'win32')).toBe(path.join(VENV, 'Scripts', 'python.exe'))
  })

  it('accepts a complete bundle', () => {
    expect(isBundleUsable(BUNDLE, { existsSync: t => completeBundle().includes(t), platform: 'linux' })).toBe(true)
  })

  it('rejects a bundle missing any part, rather than half-installing it', () => {
    for (const omitted of completeBundle()) {
      const present = completeBundle().filter(p => p !== omitted)

      expect(isBundleUsable(BUNDLE, { existsSync: t => present.includes(t), platform: 'linux' })).toBe(false)
    }
  })

  it('treats a missing bundle directory as no bundle', () => {
    expect(isBundleUsable(null, { existsSync: () => true, platform: 'linux' })).toBe(false)
  })
})

describe('seedBundledRuntime', () => {
  it('installs source, venv and dependencies when nothing is present', () => {
    const deps = makeDeps(completeBundle())
    const result = seedBundledRuntime({ activeRoot: ACTIVE, bundleDir: BUNDLE, venvRoot: VENV }, deps)

    expect(result.outcome).toBe('seeded')
    expect(deps.copyDir).toHaveBeenCalledWith(path.join(BUNDLE, 'source'), ACTIVE)

    const [venvCall, pipCall] = deps.calls

    expect(venvCall).toEqual([bundledPythonPath(BUNDLE, 'linux'), '-m', 'venv', '--copies', VENV])

    // The offline guarantee: --no-index means a missing wheel fails loudly here
    // instead of silently fetching from PyPI on the user's first launch.
    expect(pipCall).toContain('--no-index')
    expect(pipCall).toContain(`--find-links=${path.join(BUNDLE, 'wheels')}`)
    expect(pipCall[0]).toBe(venvPythonPath(VENV, 'linux'))
  })

  it('is a no-op when a usable install already exists', () => {
    const deps = makeDeps([
      ...completeBundle(),
      path.join(ACTIVE, 'eternal_cli', 'main.py'),
      venvPythonPath(VENV, 'linux')
    ])

    expect(seedBundledRuntime({ activeRoot: ACTIVE, bundleDir: BUNDLE, venvRoot: VENV }, deps).outcome).toBe(
      'already-usable'
    )
    expect(deps.copyDir).not.toHaveBeenCalled()
    expect(deps.calls).toHaveLength(0)
  })

  it('re-seeds a half-built install that has source but no venv', () => {
    const deps = makeDeps([...completeBundle(), path.join(ACTIVE, 'eternal_cli', 'main.py')])

    expect(seedBundledRuntime({ activeRoot: ACTIVE, bundleDir: BUNDLE, venvRoot: VENV }, deps).outcome).toBe('seeded')
  })

  it('reports no-bundle when nothing shipped, leaving bootstrap to run', () => {
    const deps = makeDeps([])

    expect(seedBundledRuntime({ activeRoot: ACTIVE, bundleDir: null, venvRoot: VENV }, deps).outcome).toBe('no-bundle')
    expect(deps.copyDir).not.toHaveBeenCalled()
  })

  it('surfaces a venv failure without attempting the install', () => {
    const deps = makeDeps(completeBundle(), () => ({ status: 1, stderr: 'no space left on device' }))
    const result = seedBundledRuntime({ activeRoot: ACTIVE, bundleDir: BUNDLE, venvRoot: VENV }, deps)

    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('venv creation failed')
    expect(result.error).toContain('no space left on device')
  })

  it('surfaces an offline dependency failure', () => {
    const deps = makeDeps(completeBundle(), (_command, args) =>
      args[1] === 'venv'
        ? { status: 0 }
        : { status: 1, stderr: 'ERROR: No matching distribution found for cffi==2.1.1' }
    )

    const result = seedBundledRuntime({ activeRoot: ACTIVE, bundleDir: BUNDLE, venvRoot: VENV }, deps)

    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('offline dependency install failed')
    expect(result.error).toContain('cffi==2.1.1')
  })

  it('turns a thrown filesystem error into a failure instead of crashing launch', () => {
    const deps = makeDeps(completeBundle())

    deps.copyDir = () => {
      throw new Error('EACCES: permission denied')
    }

    const result = seedBundledRuntime({ activeRoot: ACTIVE, bundleDir: BUNDLE, venvRoot: VENV }, deps)

    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('EACCES')
  })
})

describe('isActiveRootSeeded', () => {
  it('requires both the source sentinel and the venv interpreter', () => {
    const both = [path.join(ACTIVE, 'eternal_cli', 'main.py'), venvPythonPath(VENV, 'linux')]

    expect(isActiveRootSeeded(ACTIVE, VENV, { existsSync: t => both.includes(t), platform: 'linux' })).toBe(true)

    for (const only of both) {
      expect(isActiveRootSeeded(ACTIVE, VENV, { existsSync: t => t === only, platform: 'linux' })).toBe(false)
    }
  })
})
