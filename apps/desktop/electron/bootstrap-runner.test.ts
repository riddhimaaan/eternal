import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import {
  buildPinArgs,
  buildPosixPinArgs,
  cachedScriptPath,
  canDownloadInstallScript,
  hasExistingGitCheckout,
  installedAgentInstallScript,
  installRefForStamp,
  isPinnedCommit,
  packagedRepairMessage,
  resolveInstallScript,
  resolveMarkerPinnedCommit,
  runBootstrap
} from './bootstrap-runner'

const SCRIPT_NAME = process.platform === 'win32' ? 'install.ps1' : 'install.sh'
const ZERO_COMMIT = '0000000000000000000000000000000000000000'

function mkTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eternal-bootstrap-test-'))
}

test('runBootstrap bails immediately when the signal is already aborted', async () => {
  const controller = new AbortController()
  controller.abort()

  const events = []

  const result = await runBootstrap({
    installStamp: null,
    activeRoot: '/tmp/eternal-runner-test',
    sourceRepoRoot: null,
    eternalHome: '/tmp/eternal-runner-test',
    logRoot: '/tmp/eternal-runner-test',
    onEvent: ev => events.push(ev),
    abortSignal: controller.signal
  })

  // Cancelled before any install script is spawned.
  assert.deepEqual(result, { ok: false, cancelled: true })
  assert.ok(
    events.some(ev => ev.type === 'failed' && /cancelled/i.test(ev.error)),
    'should emit a cancelled failure event'
  )
})

test('installedAgentInstallScript resolves the installer in the agent checkout', () => {
  const home = mkTmpHome()

  try {
    assert.equal(installedAgentInstallScript(home), null, 'absent before the checkout exists')

    const scriptsDir = path.join(home, 'eternal-agent', 'scripts')
    fs.mkdirSync(scriptsDir, { recursive: true })
    const scriptPath = path.join(scriptsDir, SCRIPT_NAME)
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho hi\n')

    assert.equal(installedAgentInstallScript(home), scriptPath)
    assert.equal(installedAgentInstallScript(null), null, 'null home -> null')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('existing checkout detection requires git metadata', () => {
  const home = mkTmpHome()

  try {
    const activeRoot = path.join(home, 'eternal-agent')
    assert.equal(hasExistingGitCheckout(activeRoot), false)

    fs.mkdirSync(path.join(activeRoot, '.git'), { recursive: true })
    assert.equal(hasExistingGitCheckout(activeRoot), true)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('fresh bootstrap args include the packaged commit pin', () => {
  const installStamp = { commit: 'a'.repeat(40), branch: 'main' }

  assert.deepEqual(buildPinArgs(installStamp), ['-Commit', installStamp.commit, '-Branch', 'main'])
  assert.deepEqual(
    buildPosixPinArgs({
      installStamp,
      activeRoot: '/tmp/eternal-agent',
      eternalHome: '/tmp/eternal'
    }),
    ['--dir', '/tmp/eternal-agent', '--eternal-home', '/tmp/eternal', '--branch', 'main', '--commit', installStamp.commit]
  )
})

test('existing-checkout bootstrap args keep branch but skip the packaged commit pin', () => {
  const installStamp = { commit: 'a'.repeat(40), branch: 'main' }

  assert.deepEqual(buildPinArgs(installStamp, { pinCommit: false }), ['-Branch', 'main'])
  assert.deepEqual(
    buildPosixPinArgs({
      installStamp,
      activeRoot: '/tmp/eternal-agent',
      eternalHome: '/tmp/eternal',
      pinCommit: false
    }),
    ['--dir', '/tmp/eternal-agent', '--eternal-home', '/tmp/eternal', '--branch', 'main']
  )
})

test('fallback install stamps use an unpinned branch ref', () => {
  const stamp = { commit: ZERO_COMMIT, branch: 'main' }

  assert.equal(isPinnedCommit(ZERO_COMMIT), false)
  assert.deepEqual(installRefForStamp(stamp), {
    ref: 'main',
    cacheKey: 'fallback-main',
    pinned: false
  })
  // Must NOT pass -Commit / --commit for the all-zero placeholder.
  assert.deepEqual(buildPinArgs(stamp), ['-Branch', 'main'])
  assert.deepEqual(
    buildPosixPinArgs({
      installStamp: stamp,
      activeRoot: '/tmp/eternal',
      eternalHome: '/tmp/home'
    }),
    ['--dir', '/tmp/eternal', '--eternal-home', '/tmp/home', '--branch', 'main']
  )
})

test('resolveMarkerPinnedCommit prefers real HEAD over fallback stamp zeros', () => {
  const realHead = 'c'.repeat(40)
  assert.equal(
    resolveMarkerPinnedCommit({ commit: ZERO_COMMIT, branch: 'main' }, '/tmp/checkout', {
      resolveHead: () => realHead
    }),
    realHead
  )
  assert.equal(
    resolveMarkerPinnedCommit({ commit: 'd'.repeat(40), branch: 'main' }, '/tmp/checkout', {
      resolveHead: () => realHead
    }),
    'd'.repeat(40),
    'packaged real pin wins over checkout HEAD'
  )
  assert.equal(
    resolveMarkerPinnedCommit({ commit: ZERO_COMMIT, branch: 'main' }, '/tmp/missing', {
      resolveHead: () => null
    }),
    null
  )
})

test('resolveInstallScript downloads fallback stamps by branch instead of zero commit', async () => {
  const home = mkTmpHome()

  try {
    const logs = []
    const refs = []

    const result = await resolveInstallScript({
      installStamp: { commit: ZERO_COMMIT, branch: 'main' },
      sourceRepoRoot: null,
      eternalHome: home,
      emit: ev => logs.push(ev),
      _download: async (ref, destPath) => {
        refs.push(ref)
        fs.mkdirSync(path.dirname(destPath), { recursive: true })
        fs.writeFileSync(destPath, '#!/bin/sh\necho fallback branch\n')

        return destPath
      }
    })

    assert.deepEqual(refs, ['main'])
    assert.equal(result.source, 'download')
    assert.equal(result.commit, null)
    assert.equal(result.path, cachedScriptPath(home, 'fallback-main'))
    assert.ok(
      logs.some(ev => /fallback, unpinned/.test(ev.line || '')),
      'emits an unpinned fallback log line'
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('resolveInstallScript prefers a cached script without touching the network', async () => {
  const home = mkTmpHome()

  try {
    const commit = 'a'.repeat(40)
    const cached = cachedScriptPath(home, commit)
    fs.mkdirSync(path.dirname(cached), { recursive: true })
    fs.writeFileSync(cached, '#!/bin/sh\necho cached\n')

    const logs = []

    const result = await resolveInstallScript({
      installStamp: { commit },
      sourceRepoRoot: null,
      eternalHome: home,
      emit: ev => logs.push(ev)
    })

    assert.equal(result.source, 'cache')
    assert.equal(result.path, cached)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('resolveInstallScript falls back to the installed agent checkout on a 404', async () => {
  const home = mkTmpHome()

  try {
    const commit = 'a'.repeat(40)
    // Seed the installed agent checkout so the fallback has something to resolve.
    const scriptsDir = path.join(home, 'eternal-agent', 'scripts')
    fs.mkdirSync(scriptsDir, { recursive: true })
    const installed = path.join(scriptsDir, SCRIPT_NAME)
    fs.writeFileSync(installed, '#!/bin/sh\necho fallback\n')

    const logs = []

    const result = await resolveInstallScript({
      installStamp: { commit },
      sourceRepoRoot: null,
      eternalHome: home,
      emit: ev => logs.push(ev),
      // Simulate GitHub returning a 404 for the pinned commit.
      _download: async () => {
        throw new Error('Failed to download install.sh: HTTP 404')
      }
    })

    assert.equal(result.source, 'installed-agent')
    // It should have copied the installer into the bootstrap cache.
    assert.equal(result.path, cachedScriptPath(home, commit))
    assert.ok(fs.existsSync(result.path), 'fallback script copied into cache')
    assert.ok(
      logs.some(ev => /falling back to installed agent/.test(ev.line || '')),
      'emits a fallback log line'
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('resolveInstallScript rethrows when the 404 fallback is unavailable', async () => {
  const home = mkTmpHome()

  try {
    const commit = 'a'.repeat(40)
    // No installed agent checkout seeded -> nothing to fall back to.
    await assert.rejects(
      resolveInstallScript({
        installStamp: { commit },
        sourceRepoRoot: null,
        eternalHome: home,
        emit: () => {},
        _download: async () => {
          throw new Error('Failed to download install.sh: HTTP 404')
        }
      }),
      /HTTP 404|Failed to download/
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// --- packaged builds never fetch from the private source repo -------------
//
// riddhimaaan/eternal is private, so raw.githubusercontent.com 404s for every
// customer. A packaged build that asks anyway spends a round-trip to produce
// an error the user cannot act on.

test('canDownloadInstallScript allows a source run and refuses a packaged build', () => {
  assert.equal(canDownloadInstallScript({ isPackaged: false }), true)
  assert.equal(canDownloadInstallScript({ isPackaged: undefined }), true)
  assert.equal(canDownloadInstallScript({ isPackaged: true }), false)
})

test('packagedRepairMessage names the public releases page and reassures about data', () => {
  const message = packagedRepairMessage()

  assert.match(message, /eternal-releases/)
  assert.doesNotMatch(message, /raw\.githubusercontent/)
  // The private source repo must never be named in something a customer reads.
  assert.doesNotMatch(message, /github\.com\/riddhimaaan\/eternal(?![-\w])/)
  assert.match(message, /not affected/)
})

test('resolveInstallScript does not touch the network in a packaged build', async () => {
  const home = mkTmpHome()

  try {
    let downloadCalls = 0
    const logs = []

    await assert.rejects(
      resolveInstallScript({
        installStamp: { commit: 'a'.repeat(40) },
        sourceRepoRoot: null,
        eternalHome: home,
        emit: ev => logs.push(ev),
        isPackaged: true,
        _download: async () => {
          downloadCalls += 1
          throw new Error('Failed to download install.sh: HTTP 404')
        }
      }),
      /Reinstall Eternal from .*eternal-releases/
    )

    assert.equal(downloadCalls, 0, 'a packaged build must not attempt the download')
    assert.ok(
      logs.some(ev => /not fetching .* packaged build, source repo is private/.test(ev.line || '')),
      'explains in the log why the download was skipped'
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('resolveInstallScript still repairs a packaged build from an installed agent checkout', async () => {
  const home = mkTmpHome()

  try {
    // A damaged venv with the agent checkout still present: recoverable
    // locally, so the reinstall message would be wrong here.
    const scriptsDir = path.join(home, 'eternal-agent', 'scripts')
    fs.mkdirSync(scriptsDir, { recursive: true })
    fs.writeFileSync(path.join(scriptsDir, SCRIPT_NAME), '#!/bin/sh\necho installed\n')

    let downloadCalls = 0

    const result = await resolveInstallScript({
      installStamp: { commit: 'a'.repeat(40) },
      sourceRepoRoot: null,
      eternalHome: home,
      emit: () => {},
      isPackaged: true,
      _download: async () => {
        downloadCalls += 1
        throw new Error('should not be reached')
      }
    })

    assert.equal(result.source, 'installed-agent')
    assert.equal(downloadCalls, 0)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('resolveInstallScript prefers the cache over the reinstall message in a packaged build', async () => {
  const home = mkTmpHome()

  try {
    const commit = 'a'.repeat(40)
    const cached = cachedScriptPath(home, commit)
    fs.mkdirSync(path.dirname(cached), { recursive: true })
    fs.writeFileSync(cached, '#!/bin/sh\necho cached\n')

    const result = await resolveInstallScript({
      installStamp: { commit },
      sourceRepoRoot: null,
      eternalHome: home,
      emit: () => {},
      isPackaged: true
    })

    assert.equal(result.source, 'cache')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('a packaged build with no install stamp asks for a reinstall, not a build-stamp lecture', async () => {
  const home = mkTmpHome()

  try {
    await assert.rejects(
      resolveInstallScript({
        installStamp: null,
        sourceRepoRoot: null,
        eternalHome: home,
        emit: () => {},
        isPackaged: true
      }),
      /Reinstall Eternal from .*eternal-releases/
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('a source run with no install stamp still gets the developer-facing explanation', async () => {
  const home = mkTmpHome()

  try {
    await assert.rejects(
      resolveInstallScript({
        installStamp: null,
        sourceRepoRoot: null,
        eternalHome: home,
        emit: () => {},
        isPackaged: false
      }),
      /valid build-time stamp/
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
