import { generateKeyPairSync, sign as signBuffer } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  CONFIRM_EVERY_DAYS,
  decideLicense,
  OFFLINE_GRACE_DAYS,
  parseLicenseKey,
  shouldConfirmNow,
  verifyLicenseKey
} from './license'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

const ours = generateKeyPairSync('ed25519')
const theirs = generateKeyPairSync('ed25519')

const PUBLIC_PEM = ours.publicKey.export({ format: 'pem', type: 'spki' }).toString()
const ATTACKER_PEM = theirs.publicKey.export({ format: 'pem', type: 'spki' }).toString()

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Mint a key the way the issuing tool will. */
function mint(payload: Record<string, unknown>, privateKey = ours.privateKey): string {
  const body = b64url(JSON.stringify(payload))
  const signature = b64url(signBuffer(null, Buffer.from(body, 'utf8'), privateKey))

  return `ETERNAL-${body}.${signature}`
}

const VALID = mint({ v: 1, id: 'cust_0001', iat: 1_700_000_000 })

describe('parseLicenseKey', () => {
  it('reads a well-formed key', () => {
    expect(parseLicenseKey(VALID)?.payload.id).toBe('cust_0001')
  })

  it('rejects anything malformed rather than throwing', () => {
    for (const bad of ['', 'nonsense', 'ETERNAL-', 'ETERNAL-onlyonepart', 'ETERNAL-a.b.c', 'ETERNAL-!!!.???']) {
      expect(parseLicenseKey(bad), bad).toBeNull()
    }
  })

  it('rejects a payload missing required fields', () => {
    expect(parseLicenseKey(mint({ v: 1, iat: 1 }))).toBeNull()
    expect(parseLicenseKey(mint({ id: 'x', iat: 1 }))).toBeNull()
    expect(parseLicenseKey(mint({ v: 1, id: '', iat: 1 }))).toBeNull()
  })
})

describe('verifyLicenseKey', () => {
  it('accepts a key we signed', () => {
    expect(verifyLicenseKey(VALID, PUBLIC_PEM)).toBe(true)
  })

  it('rejects a key signed by someone else', () => {
    // Someone generating their own keypair and minting themselves a licence.
    expect(verifyLicenseKey(mint({ v: 1, id: 'pirate', iat: 1 }, theirs.privateKey), PUBLIC_PEM)).toBe(false)
  })

  it('rejects a key whose payload was edited after signing', () => {
    const forged = `ETERNAL-${b64url(JSON.stringify({ v: 1, id: 'cust_0001', iat: 1, exp: 99_999_999_999 }))}.${
      VALID.split('.')[1]
    }`

    expect(verifyLicenseKey(forged, PUBLIC_PEM)).toBe(false)
  })

  it('rejects our own key checked against the wrong public key', () => {
    expect(verifyLicenseKey(VALID, ATTACKER_PEM)).toBe(false)
  })

  it('returns false rather than throwing on a broken public key', () => {
    expect(verifyLicenseKey(VALID, 'not a pem')).toBe(false)
  })
})

describe('decideLicense', () => {
  const base = { publicKeyPem: PUBLIC_PEM, now: NOW }

  it('asks for a key when there is none', () => {
    expect(decideLicense({ ...base }).state).toBe('unlicensed')
    expect(decideLicense({ ...base, key: '   ' }).usable).toBe(false)
  })

  it('refuses a forged key outright, with no grace of any kind', () => {
    const decision = decideLicense({ ...base, key: mint({ v: 1, id: 'pirate', iat: 1 }, theirs.privateKey) })

    expect(decision.state).toBe('invalid')
    expect(decision.usable).toBe(false)
  })

  it('runs normally on a genuine key confirmed recently', () => {
    const decision = decideLicense({ ...base, key: VALID, lastConfirmedAt: NOW - DAY })

    expect(decision).toEqual({ state: 'active', usable: true })
  })

  it('refuses an expired key', () => {
    const expired = mint({ v: 1, id: 'c', iat: 1, exp: Math.floor(NOW / 1000) - 10 })

    expect(decideLicense({ ...base, key: expired }).state).toBe('expired')
  })

  it('honours an expiry still in the future', () => {
    const future = mint({ v: 1, id: 'c', iat: 1, exp: Math.floor(NOW / 1000) + 10 })

    expect(decideLicense({ ...base, key: future, lastConfirmedAt: NOW }).usable).toBe(true)
  })

  it('refuses a key the service reports withdrawn', () => {
    const decision = decideLicense({ ...base, key: VALID, lastConfirmedAt: NOW, serverSaysRevoked: true })

    expect(decision.state).toBe('revoked')
    expect(decision.usable).toBe(false)
  })

  it('checks forgery before revocation, so a fake key cannot be "merely revoked"', () => {
    const decision = decideLicense({
      ...base,
      key: mint({ v: 1, id: 'pirate', iat: 1 }, theirs.privateKey),
      serverSaysRevoked: false
    })

    expect(decision.state).toBe('invalid')
  })

  // The heart of it: our outage must never stop someone's paid software.
  it('keeps working when the service has been unreachable for a while', () => {
    const decision = decideLicense({ ...base, key: VALID, lastConfirmedAt: NOW - (CONFIRM_EVERY_DAYS + 2) * DAY })

    expect(decision.state).toBe('active-unconfirmed')
    expect(decision.usable).toBe(true)
  })

  it('still works, but says so, after prolonged silence', () => {
    const decision = decideLicense({ ...base, key: VALID, lastConfirmedAt: NOW - (OFFLINE_GRACE_DAYS + 5) * DAY })

    expect(decision.state).toBe('stale')
    expect(decision.usable).toBe(true)
    expect(decision.message).toBeTruthy()
  })

  it('treats a never-confirmed genuine key as usable, for an offline first launch', () => {
    const decision = decideLicense({ ...base, key: VALID })

    expect(decision.usable).toBe(true)
  })

  it('never reports a state that is both unusable and silent', () => {
    // Anything that stops the app must explain itself to the user.
    for (const input of [
      { ...base },
      { ...base, key: 'ETERNAL-garbage.sig' },
      { ...base, key: mint({ v: 1, id: 'c', iat: 1, exp: 1 }) },
      { ...base, key: VALID, serverSaysRevoked: true }
    ]) {
      const decision = decideLicense(input)

      if (!decision.usable) {
        expect(decision.message, decision.state).toBeTruthy()
      }
    }
  })
})

describe('shouldConfirmNow', () => {
  it('calls out when the interval has passed, and not before', () => {
    expect(shouldConfirmNow(NOW, NOW - (CONFIRM_EVERY_DAYS - 1) * DAY)).toBe(false)
    expect(shouldConfirmNow(NOW, NOW - (CONFIRM_EVERY_DAYS + 1) * DAY)).toBe(true)
  })

  it('calls out when it has never confirmed', () => {
    expect(shouldConfirmNow(NOW)).toBe(true)
  })
})
