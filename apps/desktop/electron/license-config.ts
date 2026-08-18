/**
 * Where the licence gate gets its two settings.
 *
 * Both are EMPTY until you set them up, and empty means the gate is off: every
 * build runs unlicensed. That default is deliberate. A gate that switches on
 * the moment its code lands would refuse to start on every machine including
 * yours, because no key exists yet to satisfy it — and the failure would look
 * exactly like the product being broken.
 *
 * Turning it on is therefore an explicit act: run services/license/keygen.mjs
 * and paste the public key below. See services/license/README.md.
 */

/**
 * The public half of your signing keypair, in PEM.
 *
 * Safe to commit — it can only verify keys, never mint them. The private half
 * signs every licence you issue and must never be in this repository.
 */
export const LICENSE_PUBLIC_KEY_PEM = process.env.ETERNAL_LICENSE_PUBLIC_KEY || ''

/**
 * The deployed licence service, e.g. https://eternal-license.you.workers.dev
 *
 * Empty means the app never asks anyone. Signatures still verify locally, so a
 * key cannot be forged — but it also cannot be withdrawn.
 */
export const LICENSE_SERVICE_URL = process.env.ETERNAL_LICENSE_SERVICE_URL || ''

/** True once a public key exists to check against. */
export function licenseGateConfigured(): boolean {
  return Boolean(LICENSE_PUBLIC_KEY_PEM.trim())
}
