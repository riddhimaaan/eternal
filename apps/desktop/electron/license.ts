/**
 * Whether this copy of Eternal is licensed.
 *
 * Two independent checks, deliberately:
 *
 *   1. A signature, verified on this machine. Proves the key was issued by us
 *      and has not been edited. Works with no network at all.
 *   2. A periodic call to the licence service, which is the only thing that can
 *      report a key as revoked — a refund, a chargeback, a key posted publicly.
 *
 * The signature alone cannot express revocation: once issued, it verifies
 * forever. The server alone would mean no network, no Eternal. Together they
 * give offline use and a way to withdraw a key.
 *
 * THE FAILURE POLICY IS THE IMPORTANT PART, so it is stated once, here:
 *
 *   - A forged or altered key fails immediately. There is no grace for
 *     something that never came from us.
 *   - An unreachable service NEVER blocks a paying customer. The service going
 *     down, or a user being on a plane, must not brick software people bought.
 *     Contact is retried, and only prolonged silence degrades anything.
 *   - Nothing here ever deletes or locks a user's data. The worst outcome is
 *     that Eternal stops starting new work; the conversations, keys and files
 *     in ETERNAL_HOME stay the user's property regardless.
 */

import { createPublicKey, verify as verifySignature } from 'node:crypto'

export interface LicensePayload {
  /** Format version, so the shape can change without invalidating old keys. */
  v: number
  /** Opaque customer identifier. Never an email — see issueLicense. */
  id: string
  /** Issued-at, unix seconds. */
  iat: number
  /** Optional expiry, unix seconds. Absent means perpetual. */
  exp?: number
}

export type LicenseState =
  /** No key has been entered. */
  | 'unlicensed'
  /** Malformed, or the signature does not match. Treat as forged. */
  | 'invalid'
  /** Genuine, but its expiry has passed. */
  | 'expired'
  /** Genuine, but the service reports it withdrawn. */
  | 'revoked'
  /** Genuine and confirmed with the service recently. */
  | 'active'
  /** Genuine, but the service has not been reachable lately. Still runs. */
  | 'active-unconfirmed'
  /** Genuine, and unreachable for so long that confirmation is overdue. */
  | 'stale'

export interface LicenseDecision {
  state: LicenseState
  /** True when Eternal should run normally. */
  usable: boolean
  /** Something worth showing the user, or undefined when all is well. */
  message?: string
}

/** How often to confirm with the service, in days. */
export const CONFIRM_EVERY_DAYS = 7

/**
 * How long a genuine key keeps working with no service contact at all.
 *
 * Generous on purpose: this window is what protects customers from an outage of
 * ours, and someone travelling for a month is a likelier explanation than
 * someone evading a revocation.
 */
export const OFFLINE_GRACE_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

const KEY_PREFIX = 'ETERNAL-'

function decodeSegment(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/**
 * Split a key into its payload and signature without verifying anything.
 *
 * Returns null for anything malformed. Callers must never act on the payload
 * before verifyLicenseKey succeeds — it is attacker-supplied until then.
 */
export function parseLicenseKey(key: string): { payload: LicensePayload; signed: string; signature: Buffer } | null {
  const trimmed = String(key ?? '').trim()

  if (!trimmed.startsWith(KEY_PREFIX)) {
    return null
  }

  const parts = trimmed.slice(KEY_PREFIX.length).split('.')

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null
  }

  let payload: LicensePayload

  try {
    payload = JSON.parse(decodeSegment(parts[0]).toString('utf8'))
  } catch {
    return null
  }

  if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string' || !payload.id) {
    return null
  }

  if (typeof payload.v !== 'number' || typeof payload.iat !== 'number') {
    return null
  }

  return { payload, signed: parts[0], signature: decodeSegment(parts[1]) }
}

/**
 * True only when the key carries our signature over exactly its own payload.
 *
 * Any error — malformed key, malformed public key, wrong length signature —
 * is false rather than an exception, because every caller of this treats a
 * failure the same way and a throw here would be a way to bypass the check.
 */
export function verifyLicenseKey(key: string, publicKeyPem: string): boolean {
  const parsed = parseLicenseKey(key)

  if (!parsed) {
    return false
  }

  try {
    return verifySignature(
      null,
      Buffer.from(parsed.signed, 'utf8'),
      createPublicKey(publicKeyPem),
      parsed.signature
    )
  } catch {
    return false
  }
}

export interface LicenseInputs {
  /** The stored key, or empty when none has been entered. */
  key?: string
  /** Our signing public key, in PEM. */
  publicKeyPem: string
  /** Now, in milliseconds. */
  now: number
  /** When the service last confirmed this key, in milliseconds. */
  lastConfirmedAt?: number
  /** The service's most recent answer, when there is one. */
  serverSaysRevoked?: boolean
}

/**
 * Decide what this copy of Eternal may do.
 *
 * Order is deliberate: forgery is checked before expiry, and both before
 * anything to do with the network, so a bad key can never reach the lenient
 * paths that exist for honest customers.
 */
export function decideLicense(input: LicenseInputs): LicenseDecision {
  const key = (input.key || '').trim()

  if (!key) {
    return { state: 'unlicensed', usable: false, message: 'Enter your licence key to start using Eternal.' }
  }

  if (!verifyLicenseKey(key, input.publicKeyPem)) {
    return {
      state: 'invalid',
      usable: false,
      message: 'This licence key is not valid. Check it was copied in full, or get in touch.'
    }
  }

  // Safe to read only now that the signature has been checked.
  const { payload } = parseLicenseKey(key)!

  if (typeof payload.exp === 'number' && payload.exp * 1000 <= input.now) {
    return { state: 'expired', usable: false, message: 'This licence has expired.' }
  }

  if (input.serverSaysRevoked === true) {
    return { state: 'revoked', usable: false, message: 'This licence key has been withdrawn. Please get in touch.' }
  }

  const lastConfirmed = input.lastConfirmedAt || 0
  const silentFor = input.now - lastConfirmed

  // Never confirmed yet is treated as merely unconfirmed, not as failure: a
  // customer's first launch may well be offline, and the key is genuine.
  if (silentFor <= CONFIRM_EVERY_DAYS * DAY_MS) {
    return { state: 'active', usable: true }
  }

  if (silentFor <= OFFLINE_GRACE_DAYS * DAY_MS) {
    return { state: 'active-unconfirmed', usable: true }
  }

  // Still usable. Prolonged silence earns a visible prompt, not a lockout —
  // the likeliest cause is our own service being unreachable, and punishing a
  // paying customer for that would be indefensible.
  return {
    state: 'stale',
    usable: true,
    message: 'Eternal has not been able to confirm your licence for a while. Check your internet connection.'
  }
}

/** Days until confirmation is due, for callers deciding whether to call out. */
export function shouldConfirmNow(now: number, lastConfirmedAt?: number): boolean {
  return now - (lastConfirmedAt || 0) > CONFIRM_EVERY_DAYS * DAY_MS
}
