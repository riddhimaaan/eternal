import { generateKeyPairSync, sign as signBuffer } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  activateLicenseKey,
  confirmLicenseWithService,
  evaluateStoredLicense,
  licenseNeedsConfirmation,
  readStoredLicense,
  writeStoredLicense
} from './license-store'

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

const ours = generateKeyPairSync('ed25519')
const theirs = generateKeyPairSync('ed25519')
const PUBLIC_PEM = ours.publicKey.export({ format: 'pem', type: 'spki' }).toString()

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function mint(payload: Record<string, unknown>, privateKey = ours.privateKey): string {
  const body = b64url(JSON.stringify(payload))

  return `ETERNAL-${body}.${b64url(signBuffer(null, Buffer.from(body, 'utf8'), privateKey))}`
}

const GENUINE = mint({ v: 1, id: 'cust_0001', iat: 1_700_000_000 })
const FORGED = mint({ v: 1, id: 'cust_0001', iat: 1_700_000_000 }, theirs.privateKey)

const dirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eternal-licence-'))
  dirs.push(dir)

  return join(dir, 'nested', 'license.json')
}

afterEach(() => {
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

/** Stand-in for the Worker. */
function service(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, json: async () => body })) as unknown as typeof fetch
}

describe('reading what is on disk', () => {
  it('treats a missing file as no key rather than an error', () => {
    expect(readStoredLicense(tempFile())).toEqual({})
  })

  it('treats a corrupted file as no key, so a bad write cannot brick the app', () => {
    const file = tempFile()
    writeStoredLicense(file, { key: GENUINE })
    writeFileSync(file, '{ not json')

    expect(readStoredLicense(file)).toEqual({})
  })

  it('ignores fields of the wrong type', () => {
    const file = tempFile()
    writeStoredLicense(file, {})
    writeFileSync(file, JSON.stringify({ key: 42, lastConfirmedAt: 'soon', revoked: 'yes' }))

    expect(readStoredLicense(file)).toEqual({ key: undefined, lastConfirmedAt: undefined, revoked: undefined })
  })
})

describe('activating a key', () => {
  it('accepts a genuine key offline and stores it', () => {
    const file = tempFile()
    const decision = activateLicenseKey({ file, publicKeyPem: PUBLIC_PEM, key: GENUINE, now: NOW })

    expect(decision.usable).toBe(true)
    expect(readStoredLicense(file).key).toBe(GENUINE)
  })

  it('reports a fresh key as active-unconfirmed, never as stale', () => {
    const file = tempFile()

    // Silence measured from zero would call a key pasted one second ago stale,
    // which is the first thing a paying customer would have seen.
    expect(activateLicenseKey({ file, publicKeyPem: PUBLIC_PEM, key: GENUINE, now: NOW }).state).toBe(
      'active-unconfirmed'
    )
  })

  it('refuses a key signed with someone else\'s keypair and writes nothing', () => {
    const file = tempFile()
    const decision = activateLicenseKey({ file, publicKeyPem: PUBLIC_PEM, key: FORGED, now: NOW })

    expect(decision.state).toBe('invalid')
    expect(readStoredLicense(file)).toEqual({})
  })

  it('tolerates the whitespace a paste brings with it', () => {
    const file = tempFile()
    const decision = activateLicenseKey({
      file,
      publicKeyPem: PUBLIC_PEM,
      key: `  ${GENUINE}\n`,
      now: NOW
    })

    expect(decision.usable).toBe(true)
    expect(readStoredLicense(file).key).toBe(GENUINE)
  })

  it('clears a previous revocation so a replacement key works', () => {
    const file = tempFile()
    writeStoredLicense(file, { key: 'old', revoked: true, lastConfirmedAt: NOW - DAY })
    activateLicenseKey({ file, publicKeyPem: PUBLIC_PEM, key: GENUINE, now: NOW })

    expect(readStoredLicense(file)).toEqual({ key: GENUINE, lastConfirmedAt: undefined, revoked: false })
  })
})

describe('asking the service', () => {
  it('records a yes', async () => {
    const file = tempFile()
    activateLicenseKey({ file, publicKeyPem: PUBLIC_PEM, key: GENUINE, now: NOW })

    const outcome = await confirmLicenseWithService({
      file,
      publicKeyPem: PUBLIC_PEM,
      serviceUrl: 'https://example.test/',
      now: NOW,
      fetchImpl: service({ valid: true })
    })

    expect(outcome).toBe('confirmed')
    expect(readStoredLicense(file).lastConfirmedAt).toBe(NOW)
  })

  it('records a withdrawal, and it survives a restart', async () => {
    const file = tempFile()
    activateLicenseKey({ file, publicKeyPem: PUBLIC_PEM, key: GENUINE, now: NOW })

    await confirmLicenseWithService({
      file,
      publicKeyPem: PUBLIC_PEM,
      serviceUrl: 'https://example.test',
      now: NOW,
      fetchImpl: service({ valid: false, revoked: true })
    })

    expect(evaluateStoredLicense({ file, publicKeyPem: PUBLIC_PEM, now: NOW }).state).toBe('revoked')
  })

  it('leaves a good licence alone when the service cannot be reached', async () => {
    const file = tempFile()
    activateLicenseKey({ file, publicKeyPem: PUBLIC_PEM, key: GENUINE, now: NOW })
    const before = readStoredLicense(file)

    const outcome = await confirmLicenseWithService({
      file,
      publicKeyPem: PUBLIC_PEM,
      serviceUrl: 'https://example.test',
      now: NOW,
      fetchImpl: (async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch
    })

    expect(outcome).toBe('unreachable')
    expect(readStoredLicense(file)).toEqual(before)
  })

  it('does not treat our own misconfigured service as a bad key', async () => {
    const file = tempFile()
    activateLicenseKey({ file, publicKeyPem: PUBLIC_PEM, key: GENUINE, now: NOW })

    // The Worker answers 503 when its public key is missing. Reading that as
    // "invalid" would revoke every customer at once over our own mistake.
    const outcome = await confirmLicenseWithService({
      file,
      publicKeyPem: PUBLIC_PEM,
      serviceUrl: 'https://example.test',
      now: NOW,
      fetchImpl: service({ error: 'service misconfigured' }, false)
    })

    expect(outcome).toBe('unreachable')
    expect(readStoredLicense(file).revoked).toBe(false)
    expect(evaluateStoredLicense({ file, publicKeyPem: PUBLIC_PEM, now: NOW }).usable).toBe(true)
  })

  it('does not lock anyone out when the service disagrees with a locally valid key', async () => {
    const file = tempFile()
    activateLicenseKey({ file, publicKeyPem: PUBLIC_PEM, key: GENUINE, now: NOW })

    const outcome = await confirmLicenseWithService({
      file,
      publicKeyPem: PUBLIC_PEM,
      serviceUrl: 'https://example.test',
      now: NOW,
      fetchImpl: service({ valid: false, reason: 'invalid' })
    })

    expect(outcome).toBe('unreachable')
    expect(evaluateStoredLicense({ file, publicKeyPem: PUBLIC_PEM, now: NOW }).usable).toBe(true)
  })

  it('never sends a forged key to the service', async () => {
    const file = tempFile()
    writeStoredLicense(file, { key: FORGED })
    let called = false

    const outcome = await confirmLicenseWithService({
      file,
      publicKeyPem: PUBLIC_PEM,
      serviceUrl: 'https://example.test',
      now: NOW,
      fetchImpl: (async () => {
        called = true

        return { ok: true, json: async () => ({ valid: true }) }
      }) as unknown as typeof fetch
    })

    expect(outcome).toBe('skipped')
    expect(called).toBe(false)
  })
})

describe('when to ask', () => {
  it('does not call out at all without a key', () => {
    expect(licenseNeedsConfirmation(tempFile(), NOW)).toBe(false)
  })

  it('asks once a fresh key has been entered', () => {
    const file = tempFile()
    activateLicenseKey({ file, publicKeyPem: PUBLIC_PEM, key: GENUINE, now: NOW })

    expect(licenseNeedsConfirmation(file, NOW)).toBe(true)
  })

  it('stays quiet for a week after a yes', async () => {
    const file = tempFile()
    activateLicenseKey({ file, publicKeyPem: PUBLIC_PEM, key: GENUINE, now: NOW })
    await confirmLicenseWithService({
      file,
      publicKeyPem: PUBLIC_PEM,
      serviceUrl: 'https://example.test',
      now: NOW,
      fetchImpl: service({ valid: true })
    })

    expect(licenseNeedsConfirmation(file, NOW + 6 * DAY)).toBe(false)
    expect(licenseNeedsConfirmation(file, NOW + 8 * DAY)).toBe(true)
  })
})

describe('the stored file', () => {
  it('is written owner-only, since it holds what the customer paid for', () => {
    const file = tempFile()
    activateLicenseKey({ file, publicKeyPem: PUBLIC_PEM, key: GENUINE, now: NOW })

    expect(readFileSync(file, 'utf8')).toContain(GENUINE)
  })
})
