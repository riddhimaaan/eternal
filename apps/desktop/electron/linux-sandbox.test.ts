import { describe, expect, it } from 'vitest'

import { decideLinuxSandbox, sandboxHelperUsable, usernsRestricted } from './linux-sandbox'

const HELPER = '/opt/Eternal/chrome-sandbox'

/** Deps for a host that does NOT restrict user namespaces (Arch, Fedora, older Ubuntu). */
function permissiveHost(over: Record<string, unknown> = {}) {
  return {
    env: {} as Record<string, string | undefined>,
    getuid: () => 1000,
    lstatSync: () => {
      throw new Error('ENOENT')
    },
    platform: 'linux' as NodeJS.Platform,
    readFileSync: () => {
      throw new Error('ENOENT')
    },
    ...over
  }
}

/** Deps for Ubuntu 23.10+/Debian 12+: userns restricted, AppImage helper not SUID. */
function restrictedHost(over: Record<string, unknown> = {}) {
  return permissiveHost({
    lstatSync: () => ({ mode: 0o755, uid: 1000 }),
    readFileSync: () => '1\n',
    ...over
  })
}

describe('usernsRestricted', () => {
  it('reads a restricted host as restricted', () => {
    expect(usernsRestricted({ readFileSync: () => '1\n' })).toBe(true)
  })

  it('reads an explicit 0 as permissive', () => {
    expect(usernsRestricted({ readFileSync: () => '0\n' })).toBe(false)
  })

  it('treats a missing knob as permissive, not as an error', () => {
    // Arch/Fedora have no such file. Reading that as "restricted" would strip
    // the sandbox on every distro that does not need it.
    expect(
      usernsRestricted({
        readFileSync: () => {
          throw new Error('ENOENT')
        }
      })
    ).toBe(false)
  })
})

describe('sandboxHelperUsable', () => {
  it('accepts a root-owned SUID helper (what deb/rpm post-install produces)', () => {
    expect(sandboxHelperUsable(HELPER, { lstatSync: () => ({ mode: 0o104755, uid: 0 }) })).toBe(true)
  })

  it('rejects a helper that is not SUID (what an AppImage always ships)', () => {
    expect(sandboxHelperUsable(HELPER, { lstatSync: () => ({ mode: 0o100755, uid: 0 }) })).toBe(false)
  })

  it('rejects a SUID helper not owned by root', () => {
    expect(sandboxHelperUsable(HELPER, { lstatSync: () => ({ mode: 0o104755, uid: 1000 }) })).toBe(false)
  })

  it('rejects a missing helper', () => {
    expect(
      sandboxHelperUsable(HELPER, {
        lstatSync: () => {
          throw new Error('ENOENT')
        }
      })
    ).toBe(false)
  })
})

describe('decideLinuxSandbox', () => {
  it('disables the sandbox on a restricted host with a non-SUID helper', () => {
    // The case that made the AppImage refuse to open on Ubuntu 24.04 at all.
    expect(decideLinuxSandbox(HELPER, restrictedHost())).toEqual({
      disableSandbox: true,
      reason: 'userns-restricted'
    })
  })

  it('keeps the sandbox when the host allows unprivileged user namespaces', () => {
    expect(decideLinuxSandbox(HELPER, permissiveHost())).toEqual({
      disableSandbox: false,
      reason: 'userns-allowed'
    })
  })

  it('keeps the sandbox when a usable SUID helper exists', () => {
    // deb/rpm install on a restricted host: the helper works, so the sandbox
    // must stay on rather than being dropped for everyone on that distro.
    expect(
      decideLinuxSandbox(HELPER, restrictedHost({ lstatSync: () => ({ mode: 0o104755, uid: 0 }) }))
    ).toEqual({ disableSandbox: false, reason: 'helper-usable' })
  })

  it('never disables the sandbox for root, even on a restricted host', () => {
    // Running Electron as root without a sandbox is a worse trade than doing
    // so unprivileged; it stays an explicit choice.
    expect(decideLinuxSandbox(HELPER, restrictedHost({ getuid: () => 0 }))).toEqual({
      disableSandbox: false,
      reason: 'root'
    })
  })

  it('honours ELECTRON_DISABLE_SANDBOX=1 ahead of every probe', () => {
    expect(
      decideLinuxSandbox(HELPER, permissiveHost({ env: { ELECTRON_DISABLE_SANDBOX: '1' } }))
    ).toEqual({ disableSandbox: true, reason: 'env-override' })
  })

  it('is a no-op off Linux', () => {
    expect(decideLinuxSandbox(HELPER, restrictedHost({ platform: 'win32' }))).toEqual({
      disableSandbox: false,
      reason: 'not-linux'
    })
  })
})
