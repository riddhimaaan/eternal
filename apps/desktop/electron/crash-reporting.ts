/**
 * Whether crash reports may be sent, and what they may contain.
 *
 * Eternal's entire proposition is that a user's work stays on their machine.
 * Crash reports are the one thing that deliberately leaves it, so both
 * questions below are answered here, in one small tested place, rather than
 * being spread through the code that talks to the reporting service.
 *
 * The destination is deliberately not this module's business. It takes a DSN
 * from configuration and never hard-codes one, so the same build can report to
 * a self-hosted GlitchTip, a hosted service, or nowhere at all.
 */

export interface CrashReportingInputs {
  /** What the user chose. Undefined means they have not been asked yet. */
  consent?: boolean
  /** Where reports go. Empty or missing means nothing is configured. */
  dsn?: string
  env: Record<string, string | undefined>
  /** False for a developer running from source. */
  isPackaged: boolean
}

export type CrashReportingDecision =
  | { enabled: false; reason: 'no-consent' | 'not-asked' | 'no-dsn' | 'disabled-by-env' | 'dev-build' }
  | { enabled: true; dsn: string }

/** Lets a user turn reporting off without opening the app. */
export const DISABLE_ENV = 'ETERNAL_DISABLE_CRASH_REPORTS'

/** Lets a developer opt a source build in, which is otherwise never reported. */
export const DEV_ENV = 'ETERNAL_CRASH_REPORTS_IN_DEV'

/**
 * Decide whether this launch may send crash reports.
 *
 * Order matters. The env kill switch is checked before consent so a user who
 * wants reporting off gets it off immediately, whatever is stored. "Not asked"
 * is kept distinct from "said no" because the caller must be able to tell
 * whether to ask; both stay silent.
 */
export function decideCrashReporting(input: CrashReportingInputs): CrashReportingDecision {
  if (input.env[DISABLE_ENV] === '1') {
    return { enabled: false, reason: 'disabled-by-env' }
  }

  if (input.consent === undefined) {
    return { enabled: false, reason: 'not-asked' }
  }

  if (!input.consent) {
    return { enabled: false, reason: 'no-consent' }
  }

  const dsn = (input.dsn || '').trim()

  if (!dsn) {
    return { enabled: false, reason: 'no-dsn' }
  }

  // A developer's own crashes are noise in a queue meant for real users, and a
  // source tree leaks far more identifying detail in its paths.
  if (!input.isPackaged && input.env[DEV_ENV] !== '1') {
    return { enabled: false, reason: 'dev-build' }
  }

  return { enabled: true, dsn }
}

/**
 * Patterns for values that must never leave the machine.
 *
 * Credentials first: a stack trace can carry an API key through an error
 * message, a command line, or a config dump. Each pattern is anchored on a
 * provider's own prefix so it matches keys rather than ordinary words.
 */
const SECRETS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsk-or-v1-[A-Za-z0-9]{16,}/g, '[openrouter-key]'],
  [/\bsk-ant-[A-Za-z0-9-]{16,}/g, '[anthropic-key]'],
  [/\bsk-[A-Za-z0-9]{20,}/g, '[api-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[github-token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[slack-token]'],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, '[google-key]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[jwt]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]']
]

/**
 * Replace secrets, and the user's home directory, anywhere in a string.
 *
 * The home path matters as much as the keys: `/home/jane/clients/acme/...` in a
 * stack trace names the person and what they are working on. Replacing the
 * prefix with `~` keeps the report useful for debugging without carrying that.
 */
export function scrubText(value: string, homeDir?: string): string {
  let out = String(value ?? '')

  for (const [pattern, replacement] of SECRETS) {
    out = out.replace(pattern, replacement)
  }

  const home = (homeDir || '').replace(/[/\\]+$/, '')

  if (home) {
    // Escape before use: a home path can contain regex metacharacters.
    out = out.split(home).join('~')
  }

  return out
}

/**
 * Walk a crash report and scrub every string in it.
 *
 * Deliberately structure-agnostic: the reporting SDK decides the event shape,
 * and it changes between versions. Recursing over whatever arrives means a new
 * field cannot quietly become an unscrubbed channel. Cycles are tracked because
 * SDK events can reference themselves through breadcrumbs.
 */
export function scrubEvent<T>(event: T, homeDir?: string, seen = new WeakSet<object>()): T {
  if (typeof event === 'string') {
    return scrubText(event, homeDir) as unknown as T
  }

  if (!event || typeof event !== 'object') {
    return event
  }

  if (seen.has(event as object)) {
    return event
  }

  seen.add(event as object)

  if (Array.isArray(event)) {
    return event.map(item => scrubEvent(item, homeDir, seen)) as unknown as T
  }

  const source = event as Record<string, unknown>
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(source)) {
    // The whole environment goes, rather than being scrubbed key by key: it is
    // the densest concentration of secrets in any process, and an allowlist
    // would have to be maintained against every provider Eternal ever adds.
    if (key === 'env' || key === 'environment_variables') {
      result[key] = '[removed]'

      continue
    }

    result[key] = scrubEvent(value, homeDir, seen)
  }

  return result as unknown as T
}
