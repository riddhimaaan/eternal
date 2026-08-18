/**
 * Where the licence gate keeps its state, and how it asks the service.
 *
 * `license.ts` decides what a copy of Eternal may do; this holds the facts that
 * decision needs — the key the customer entered, when the service last said
 * yes, and whether it has since said no — and is the only thing that touches
 * the network.
 *
 * Every failure here is deliberately soft. A licence check that locks a paying
 * customer out because our Worker had a bad afternoon is worse than one that
 * lets a refunded key run a few days longer, so an unreachable service, a
 * malformed reply and a non-200 all leave the stored state exactly as it was
 * and let the offline grace period in `license.ts` do its work.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { decideLicense, type LicenseDecision, shouldConfirmNow, verifyLicenseKey } from './license'

export interface StoredLicense {
  /** The key exactly as the customer pasted it. */
  key?: string
  /** When the service last confirmed it, in milliseconds. */
  lastConfirmedAt?: number
  /** The service's last answer. Persisted so a revocation survives a restart. */
  revoked?: boolean
}

export function readStoredLicense(file: string): StoredLicense {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))

    return {
      key: typeof parsed?.key === 'string' ? parsed.key : undefined,
      lastConfirmedAt: typeof parsed?.lastConfirmedAt === 'number' ? parsed.lastConfirmedAt : undefined,
      revoked: typeof parsed?.revoked === 'boolean' ? parsed.revoked : undefined
    }
  } catch {
    // Absent or unreadable reads as "no key yet", which is the honest answer on
    // a fresh install and the safe one if the file was corrupted.
    return {}
  }
}

export function writeStoredLicense(file: string, value: StoredLicense): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 })
}

export interface EvaluateOptions {
  file: string
  publicKeyPem: string
  now: number
}

/** What this copy may do, given what is on disk. */
export function evaluateStoredLicense({ file, publicKeyPem, now }: EvaluateOptions): LicenseDecision {
  const stored = readStoredLicense(file)

  return decideLicense({
    key: stored.key,
    publicKeyPem,
    now,
    lastConfirmedAt: stored.lastConfirmedAt,
    serverSaysRevoked: stored.revoked
  })
}

export interface ActivateOptions extends EvaluateOptions {
  key: string
}

/**
 * Take a key the customer typed.
 *
 * Verified against the public key on their own machine, so this works with no
 * internet at all — which matters, because the moment after paying is the worst
 * possible time to be told to check your connection. A key that verifies is
 * written straight away; the service is asked afterwards, separately.
 */
export function activateLicenseKey({ file, publicKeyPem, key, now }: ActivateOptions): LicenseDecision {
  const trimmed = (key || '').trim()

  // Ask license.ts rather than reimplementing the rules: the same code path
  // decides on activation and on every later start, so the two cannot drift.
  const decision = decideLicense({ key: trimmed, publicKeyPem, now })

  if (!decision.usable) {
    return decision
  }

  // A fresh key starts with a clean slate: no stale confirmation timestamp from
  // a previous key, and no inherited revocation.
  writeStoredLicense(file, { key: trimmed, lastConfirmedAt: undefined, revoked: false })

  return decision
}

/** True when it is time to ask the service again. */
export function licenseNeedsConfirmation(file: string, now: number): boolean {
  const stored = readStoredLicense(file)

  if (!stored.key) {
    return false
  }

  return shouldConfirmNow(now, stored.lastConfirmedAt)
}

export interface ConfirmOptions {
  file: string
  publicKeyPem: string
  serviceUrl: string
  now: number
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export type ConfirmOutcome = 'confirmed' | 'revoked' | 'skipped' | 'unreachable'

/**
 * Ask the service whether the stored key is still good.
 *
 * Returns what happened rather than throwing, because every caller wants to
 * carry on regardless — this runs in the background and its failure must never
 * be visible to someone whose licence is perfectly fine.
 */
export async function confirmLicenseWithService({
  file,
  publicKeyPem,
  serviceUrl,
  now,
  fetchImpl = fetch,
  timeoutMs = 10_000
}: ConfirmOptions): Promise<ConfirmOutcome> {
  const stored = readStoredLicense(file)

  if (!stored.key || !serviceUrl) {
    return 'skipped'
  }

  // Do not hand a key we already know is forged to a remote service.
  if (!verifyLicenseKey(stored.key, publicKeyPem)) {
    return 'skipped'
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let body: { valid?: boolean; revoked?: boolean }

  try {
    const response = await fetchImpl(`${serviceUrl.replace(/\/+$/, '')}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: stored.key }),
      signal: controller.signal
    })

    // 503 is the service telling us it is misconfigured. That is our problem,
    // not the customer's, so it must never read as a bad key.
    if (!response.ok) {
      return 'unreachable'
    }

    body = await response.json()
  } catch {
    return 'unreachable'
  } finally {
    clearTimeout(timer)
  }

  if (body?.valid === true) {
    writeStoredLicense(file, { ...stored, lastConfirmedAt: now, revoked: false })

    return 'confirmed'
  }

  if (body?.revoked === true) {
    writeStoredLicense(file, { ...stored, revoked: true })

    return 'revoked'
  }

  // The service says invalid for a key that just verified locally, which means
  // its public key and ours disagree — a deployment mistake of ours. Changing
  // nothing keeps the customer running while we notice and fix it.
  return 'unreachable'
}
