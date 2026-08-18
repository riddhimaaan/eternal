/**
 * Eternal licence service.
 *
 * One job: answer whether a licence key is still good. It exists because a
 * signature alone cannot be withdrawn — once issued it verifies forever, so a
 * refund, a chargeback or a key posted publicly would be unenforceable.
 *
 * Deliberately tiny, and deliberately not required for Eternal to run. The app
 * verifies the signature itself and keeps working when this service is
 * unreachable (see apps/desktop/electron/license.ts). If this is down, nobody's
 * paid software stops; revocations simply take effect later.
 *
 * Deploy:
 *   cd services/license
 *   npx wrangler kv namespace create REVOKED
 *   # put the printed id into wrangler.toml, then:
 *   npx wrangler secret put LICENSE_PUBLIC_KEY   # paste the .pub from keygen
 *   npx wrangler deploy
 *
 * To withdraw a key:
 *   npx wrangler kv key put --binding=REVOKED "cust_0001" "refunded 2026-08-20"
 */

const KEY_PREFIX = 'ETERNAL-'

const JSON_HEADERS = { 'content-type': 'application/json' }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function fromBase64Url(segment) {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))

  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

/** Split a key without trusting any of it. */
function parseKey(key) {
  if (typeof key !== 'string' || !key.startsWith(KEY_PREFIX)) {
    return null
  }

  const parts = key.slice(KEY_PREFIX.length).trim().split('.')

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null
  }

  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])))

    if (!payload || typeof payload.id !== 'string' || !payload.id) {
      return null
    }

    return { payload, signed: parts[0], signature: fromBase64Url(parts[1]) }
  } catch {
    return null
  }
}

/**
 * Verify here as well as in the app.
 *
 * Not redundant: without it this endpoint would answer questions about any
 * identifier a caller invented, turning it into a way to enumerate customers.
 * Checking the signature first means it only ever discusses keys we issued.
 */
async function verify(parsed, publicKeySpkiBase64) {
  try {
    const raw = Uint8Array.from(atob(publicKeySpkiBase64), c => c.charCodeAt(0))
    const key = await crypto.subtle.importKey('spki', raw, { name: 'Ed25519' }, false, ['verify'])

    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      parsed.signature,
      new TextEncoder().encode(parsed.signed)
    )
  } catch {
    return false
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return json({ ok: true })
    }

    if (request.method !== 'POST' || url.pathname !== '/verify') {
      return json({ error: 'not found' }, 404)
    }

    if (!env.LICENSE_PUBLIC_KEY) {
      // Fail loudly rather than declaring every key invalid: a missing secret
      // is our misconfiguration, and answering "invalid" would tell honest
      // customers their key is fake.
      return json({ error: 'service misconfigured' }, 503)
    }

    let body

    try {
      body = await request.json()
    } catch {
      return json({ error: 'expected json' }, 400)
    }

    const parsed = parseKey(body?.key)

    if (!parsed || !(await verify(parsed, env.LICENSE_PUBLIC_KEY))) {
      return json({ valid: false, reason: 'invalid' })
    }

    // Presence in the list is the whole revocation mechanism; the stored value
    // is a human note ("refunded 2026-08-20") and is never returned.
    const revoked = env.REVOKED ? await env.REVOKED.get(parsed.payload.id) : null

    if (revoked !== null && revoked !== undefined) {
      return json({ valid: false, revoked: true, reason: 'revoked' })
    }

    // Nothing about the caller is stored. No key, no id, no address. The app
    // records for itself when it last heard a yes; this service keeps no
    // history of who asked, which is the only honest posture for a product
    // sold on the promise that your work stays on your machine.
    return json({ valid: true })
  }
}
