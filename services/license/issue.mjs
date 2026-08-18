#!/usr/bin/env node
// issue.mjs — mint a licence key for one customer.
//
//   node services/license/issue.mjs cust_0001
//   node services/license/issue.mjs cust_0002 --days 365
//
// The identifier is yours to choose and ends up inside the key, so use an
// opaque one you can look up in your own records — never an email address.
// Keys are pasted into support threads and screenshots, and an email in one is
// a customer's personal data travelling somewhere you cannot control.

import { createPrivateKey, sign } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const id = args.find(arg => !arg.startsWith('--'))
const daysFlag = args.indexOf('--days')
const days = daysFlag === -1 ? null : Number(args[daysFlag + 1])

if (!id) {
  console.error('usage: node services/license/issue.mjs <customer-id> [--days N]')
  process.exit(1)
}

if (/@/.test(id)) {
  console.error(`refusing to put an email address in a licence key: ${id}`)
  console.error('use an opaque id you can look up in your own records instead.')
  process.exit(1)
}

if (daysFlag !== -1 && (!Number.isFinite(days) || days <= 0)) {
  console.error('--days needs a positive number')
  process.exit(1)
}

const keyPath = join(process.env.ETERNAL_LICENSE_KEY_DIR || homedir(), '.eternal-license-signing-key.pem')

if (!existsSync(keyPath)) {
  console.error(`no signing key at ${keyPath} — run: node services/license/keygen.mjs`)
  process.exit(1)
}

const b64url = input => Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const now = Math.floor(Date.now() / 1000)
const payload = { v: 1, id, iat: now }

if (days) {
  payload.exp = now + Math.round(days * 24 * 60 * 60)
}

const body = b64url(JSON.stringify(payload))
const signature = b64url(sign(null, Buffer.from(body, 'utf8'), createPrivateKey(readFileSync(keyPath))))

console.log(`ETERNAL-${body}.${signature}`)
console.error()
console.error(`issued to : ${id}`)
console.error(`expires   : ${payload.exp ? new Date(payload.exp * 1000).toISOString().slice(0, 10) : 'never'}`)
console.error('to withdraw later: npx wrangler kv key put --binding=REVOKED "' + id + '" "reason"')
