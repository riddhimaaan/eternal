#!/usr/bin/env node
// keygen.mjs — create the signing keypair, once.
//
// The private key signs every licence you ever issue. If it leaks, anyone can
// mint valid keys and the gate is over; if you lose it, you cannot issue keys
// to new customers without shipping a new public key in an app update. Keep it
// backed up somewhere private, and never in this repository.
//
//   node services/license/keygen.mjs

import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = process.env.ETERNAL_LICENSE_KEY_DIR || homedir()
const privatePath = join(dir, '.eternal-license-signing-key.pem')
const publicPath = join(dir, '.eternal-license-signing-key.pub')

if (existsSync(privatePath)) {
  console.error(`refusing to overwrite ${privatePath}`)
  console.error('every licence already issued was signed with it; delete it deliberately if you mean to start over.')
  process.exit(1)
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519')

writeFileSync(privatePath, privateKey.export({ format: 'pem', type: 'pkcs8' }))
chmodSync(privatePath, 0o600)
writeFileSync(publicPath, publicKey.export({ format: 'pem', type: 'spki' }))

// The worker needs the key as base64 SPKI rather than PEM.
const spkiBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')

console.log(`private key : ${privatePath}   (0600 — back this up, never commit it)`)
console.log(`public key  : ${publicPath}`)
console.log()
console.log('Put the public key in two places:')
console.log()
console.log('1. The app — paste this PEM into LICENSE_PUBLIC_KEY_PEM in apps/desktop/electron/license-config.ts:')
console.log()
console.log(publicKey.export({ format: 'pem', type: 'spki' }).toString().trim())
console.log()
console.log('2. The service — run `npx wrangler secret put LICENSE_PUBLIC_KEY` and paste:')
console.log()
console.log(spkiBase64)
