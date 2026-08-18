/**
 * Update checking for packaged builds.
 *
 * The desktop's original update path assumes the user installed Eternal by
 * cloning the source: it runs `git ls-remote` against the origin repo and
 * counts commits. A customer who installs the AppImage has no checkout at all,
 * and the source repo is private, so that path can only ever report
 * "not-a-git-checkout" to the people who paid for the app.
 *
 * Packaged builds instead read a small JSON manifest from a PUBLIC repo that
 * holds nothing but release metadata — a version string and a download link.
 * The build itself is deliberately not published there; where the download
 * lives is the manifest's business, so the product can sit behind a payment
 * page without the app needing to know.
 *
 * Notify-only by design. Nothing here downloads, replaces or executes
 * anything: the decision this module returns drives a "new version available"
 * message and a link the user chooses to open. Self-replacement is a much
 * larger trust decision and is deliberately out of scope.
 */

export interface ReleaseManifest {
  /** Version of the newest published build, e.g. "0.18.0". */
  version: string
  /** Where a human goes to get it. Always https — see parseReleaseManifest. */
  downloadUrl: string
  /** Optional short changelog lines shown in the update window. */
  notes: string[]
}

export type ReleaseUpdateDecision =
  | { updateAvailable: false; reason: 'up-to-date' | 'ahead' | 'unreadable-version' }
  | { updateAvailable: true; reason: 'newer-release'; latestVersion: string; downloadUrl: string; notes: string[] }

const RELEASE_OWNER = 'riddhimaaan'

const RELEASE_REPO = 'eternal-releases'

/**
 * Raw file rather than the GitHub API: the API rate-limits unauthenticated
 * callers by IP (60/hour, shared behind NAT and VPNs) and a rate-limited
 * update check would silently stop notifying. raw.githubusercontent.com has no
 * such budget and needs no token.
 */
export const RELEASE_MANIFEST_URL = `https://raw.githubusercontent.com/${RELEASE_OWNER}/${RELEASE_REPO}/main/latest.json`

/** Shown when a manifest omits its own link, so the user is never stranded. */
export const RELEASE_PAGE_URL = `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases`

/** Manifests are tiny; anything larger is a wrong URL or a hostile response. */
export const MANIFEST_MAX_BYTES = 64 * 1024

const MAX_NOTES = 40

const MAX_NOTE_LENGTH = 300

interface ParsedVersion {
  parts: number[]
  /** A pre-release suffix ("-beta.1"); ranks BELOW the same bare version. */
  prerelease: string
}

/**
 * Parse "0.17.0", "v0.17.0" or "1.2.3-beta.1" into comparable pieces.
 *
 * Returns null for anything else. Callers must treat null as "cannot tell" and
 * stay quiet rather than guessing — a false "update available" sends a paying
 * user to a download page for a build they already have.
 */
export function parseVersion(value: string): ParsedVersion | null {
  const match = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value ?? '').trim())

  if (!match) {
    return null
  }

  return { parts: match[1].split('.').map(Number), prerelease: match[2] ?? '' }
}

/**
 * Order two versions: -1 when a < b, 1 when a > b, 0 when equal, null when
 * either side is unparseable.
 *
 * Missing trailing segments read as zero, so "0.18" and "0.18.0" are equal.
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a)
  const right = parseVersion(b)

  if (!left || !right) {
    return null
  }

  const width = Math.max(left.parts.length, right.parts.length)

  for (let i = 0; i < width; i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0)

    if (diff !== 0) {
      return diff < 0 ? -1 : 1
    }
  }

  if (left.prerelease === right.prerelease) {
    return 0
  }

  // A pre-release precedes its own release: 1.0.0-beta < 1.0.0.
  if (!left.prerelease) {
    return 1
  }

  if (!right.prerelease) {
    return -1
  }

  return left.prerelease < right.prerelease ? -1 : 1
}

/**
 * True only for a well-formed https URL.
 *
 * The manifest is the one input to this flow that the app takes from the
 * network, and its only job is to produce a link a user will click. If that
 * repo is ever compromised or edited carelessly, refusing every scheme but
 * https keeps the worst case at "wrong web page" instead of `file://` or a
 * script URL.
 */
function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) {
    return false
  }

  try {
    return new URL(value.trim()).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Validate a fetched manifest. Returns null on anything malformed — a broken
 * manifest must leave the user on the honest "you are up to date" state, never
 * a half-populated update prompt.
 */
export function parseReleaseManifest(raw: string): ReleaseManifest | null {
  let payload: unknown

  try {
    payload = JSON.parse(raw)
  } catch {
    return null
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }

  const record = payload as Record<string, unknown>
  const version = typeof record.version === 'string' ? record.version.trim() : ''

  if (!parseVersion(version)) {
    return null
  }

  // An absent link is recoverable — send the user to the releases page rather
  // than dropping an otherwise valid update on the floor. A present but
  // non-https link is not recoverable: it is a mistake or an attack, and
  // silently rewriting it would hide both.
  if (record.downloadUrl !== undefined && !isHttpsUrl(record.downloadUrl)) {
    return null
  }

  const downloadUrl = isHttpsUrl(record.downloadUrl) ? record.downloadUrl.trim() : RELEASE_PAGE_URL

  const notes = Array.isArray(record.notes)
    ? record.notes
        .filter((note): note is string => typeof note === 'string' && Boolean(note.trim()))
        .slice(0, MAX_NOTES)
        .map(note => note.trim().slice(0, MAX_NOTE_LENGTH))
    : []

  return { version, downloadUrl, notes }
}

/**
 * Decide whether the running build should tell the user about a newer one.
 *
 * "ahead" is a real case, not a curiosity: it is what a developer running a
 * local build sees, and it must not nag them to downgrade.
 */
export function decideReleaseUpdate({
  currentVersion,
  manifest
}: {
  currentVersion: string
  manifest: ReleaseManifest
}): ReleaseUpdateDecision {
  const order = compareVersions(currentVersion, manifest.version)

  if (order === null) {
    return { updateAvailable: false, reason: 'unreadable-version' }
  }

  if (order > 0) {
    return { updateAvailable: false, reason: 'ahead' }
  }

  if (order === 0) {
    return { updateAvailable: false, reason: 'up-to-date' }
  }

  return {
    updateAvailable: true,
    reason: 'newer-release',
    latestVersion: manifest.version,
    downloadUrl: manifest.downloadUrl,
    notes: manifest.notes
  }
}
