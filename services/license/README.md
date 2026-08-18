# Eternal licence service

Answers one question: *is this licence key still good?*

It exists because a signature cannot be withdrawn. Eternal verifies every key's
signature on the customer's own machine, which works offline and proves the key
came from you — but a signature stays valid forever, so a refund, a chargeback
or a key posted on a forum would be unenforceable without something to ask.

**It is deliberately not required for Eternal to run.** If this service is down,
nobody's paid software stops working; revocations just take effect later. See
the failure policy at the top of `apps/desktop/electron/license.ts`.

## One-time setup

**1. Create your signing keypair.**

```bash
node services/license/keygen.mjs
```

This writes a private key to your home directory. It signs every licence you
ever issue: back it up somewhere private, and never commit it. If it leaks,
anyone can mint valid keys. If you lose it, you cannot issue keys to new
customers without shipping an app update.

It prints the public key twice, in the two formats needed below.

**2. Put the public key in the app.** Paste the PEM into
`LICENSE_PUBLIC_KEY_PEM` in `apps/desktop/electron/license-config.ts`, then
rebuild.

**3. Deploy the service.**

```bash
cd services/license
npx wrangler kv namespace create REVOKED     # paste the id into wrangler.toml
npx wrangler secret put LICENSE_PUBLIC_KEY   # paste the base64 form
npx wrangler deploy
```

Cloudflare's free tier allows 100,000 requests a day. Each install asks once a
week, so this stays free far beyond any realistic number of customers.

## Selling to someone

```bash
node services/license/issue.mjs cust_0001
```

Prints the key to paste to your customer. Use an opaque identifier you can look
up in your own records — the tool refuses email addresses, because keys end up
in support threads and screenshots.

For a subscription rather than a perpetual licence:

```bash
node services/license/issue.mjs cust_0002 --days 365
```

## Withdrawing a licence

```bash
npx wrangler kv key put --binding=REVOKED "cust_0001" "refunded 2026-08-20"
```

Takes effect the next time that install checks in, within a week. The stored
note is for you; it is never sent to the customer.

**It will not appear instantly, and that is normal.** Cloudflare KV caches the
absence of a key for up to a minute, so for a short while after you revoke, the
service can still answer `valid`. Verified during setup: the same key returned
`valid` immediately after revoking and `revoked` fifteen seconds later. If you
are testing a revocation, wait a minute before concluding anything is broken.

## Deployed

    https://eternal-license.riddhimanbania381.workers.dev

Checked end to end on 2026-08-19: a genuine key returned `valid`, a key signed
with a different keypair returned `invalid`, malformed input returned `invalid`,
a revoked key returned `revoked`, and another customer's key was unaffected.

## What this service knows about your customers

Nothing, and that is on purpose. It stores no keys, no identifiers, no
addresses and no history of who asked. Eternal is sold on the promise that your
work stays on your machine, and a licence check that quietly built a log of
when each customer opened the app would undercut that.
