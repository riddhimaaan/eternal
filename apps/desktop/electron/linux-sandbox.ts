/**
 * Linux Chromium-sandbox fallback.
 *
 * Ubuntu 23.10+ and Debian 12+ ship AppArmor's
 * `apparmor_restrict_unprivileged_userns` hardening, which blocks Chromium's
 * user-namespace sandbox for unprivileged processes. Electron then requires a
 * root-owned, mode-4755 `chrome-sandbox` helper instead. electron-builder's
 * deb/rpm post-install sets that bit, but an AppImage is just a mounted
 * squashfs — nothing can make a file SUID root inside it — so a user who
 * double-clicks the AppImage on those distros gets Chromium's FATAL abort:
 *
 *     The SUID sandbox helper binary was found, but is not configured
 *     correctly. Rather than run without sandboxing I'm aborting now.
 *
 * The process exits before any window appears, and because a desktop launcher
 * discards stderr the user sees nothing at all -- the app simply never opens.
 *
 * `eternal desktop` already handled this in Python (main.py
 * `_desktop_linux_needs_no_sandbox`), but that path prompts for sudo and only
 * runs when the app is started from the CLI. This is the same decision made in
 * the app itself, so the packaged build survives a normal launch.
 *
 * Deliberately NOT applied for root: running Electron as root without a
 * sandbox is a qualitatively worse trade than doing so as a normal desktop
 * user, and should stay an explicit choice.
 */

export interface LinuxSandboxDeps {
  /** Reads a file as utf-8, or throws (mirrors fs.readFileSync). */
  readFileSync: (path: string, encoding: 'utf-8') => string
  /** lstat, or throws (mirrors fs.lstatSync). */
  lstatSync: (path: string) => { mode: number; uid: number }
  platform: NodeJS.Platform
  /** Effective uid; 0 means root. Undefined on platforms without getuid. */
  getuid?: () => number
  env: Record<string, string | undefined>
}

export type LinuxSandboxDecision =
  | { disableSandbox: false; reason: 'not-linux' | 'root' | 'userns-allowed' | 'helper-usable' }
  | { disableSandbox: true; reason: 'env-override' | 'userns-restricted' }

const USERNS_RESTRICTION_PATH = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'

const S_ISUID = 0o4000

/**
 * True when the host restricts unprivileged user namespaces.
 *
 * A missing file means the kernel has no such knob (Arch, Fedora, older
 * Ubuntu) and the namespace sandbox works — that is the common case and must
 * read as "not restricted" rather than as an error.
 */
export function usernsRestricted(deps: Pick<LinuxSandboxDeps, 'readFileSync'>): boolean {
  try {
    return deps.readFileSync(USERNS_RESTRICTION_PATH, 'utf-8').trim() === '1'
  } catch {
    return false
  }
}

/**
 * True when `chrome-sandbox` is present AND already root-owned + SUID, i.e.
 * Chromium can use it and no fallback is needed. A deb/rpm install lands here;
 * an AppImage never does.
 */
export function sandboxHelperUsable(helperPath: string, deps: Pick<LinuxSandboxDeps, 'lstatSync'>): boolean {
  try {
    const st = deps.lstatSync(helperPath)

    return st.uid === 0 && (st.mode & S_ISUID) !== 0
  } catch {
    return false
  }
}

/**
 * Decide whether this launch must pass `--no-sandbox`.
 *
 * Order matters: the env override wins so a user can force the fallback on a
 * host we misread, and the root check precedes everything else so we never
 * silently drop the sandbox for a root session.
 */
export function decideLinuxSandbox(helperPath: string, deps: LinuxSandboxDeps): LinuxSandboxDecision {
  if (deps.platform !== 'linux') {
    return { disableSandbox: false, reason: 'not-linux' }
  }

  if (deps.env.ELECTRON_DISABLE_SANDBOX === '1') {
    return { disableSandbox: true, reason: 'env-override' }
  }

  if (deps.getuid && deps.getuid() === 0) {
    return { disableSandbox: false, reason: 'root' }
  }

  if (!usernsRestricted(deps)) {
    return { disableSandbox: false, reason: 'userns-allowed' }
  }

  if (sandboxHelperUsable(helperPath, deps)) {
    return { disableSandbox: false, reason: 'helper-usable' }
  }

  return { disableSandbox: true, reason: 'userns-restricted' }
}
