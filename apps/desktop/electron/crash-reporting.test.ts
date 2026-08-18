import { describe, expect, it } from 'vitest'

import {
  decideCrashReporting,
  DEV_ENV,
  DISABLE_ENV,
  scrubEvent,
  scrubText
} from './crash-reporting'

const DSN = 'https://abc123@crash.example.com/1'

function packaged(over: Record<string, unknown> = {}) {
  return { consent: true, dsn: DSN, env: {}, isPackaged: true, ...over } as Parameters<
    typeof decideCrashReporting
  >[0]
}

describe('decideCrashReporting', () => {
  it('reports only when a user has agreed and a destination exists', () => {
    expect(decideCrashReporting(packaged())).toEqual({ enabled: true, dsn: DSN })
  })

  it('stays silent until the user has been asked', () => {
    // The distinction that matters: "not asked" must not read as consent.
    expect(decideCrashReporting(packaged({ consent: undefined }))).toEqual({
      enabled: false,
      reason: 'not-asked'
    })
  })

  it('stays silent when the user declined', () => {
    expect(decideCrashReporting(packaged({ consent: false }))).toEqual({
      enabled: false,
      reason: 'no-consent'
    })
  })

  it('honours the env kill switch even when the user has agreed', () => {
    expect(decideCrashReporting(packaged({ env: { [DISABLE_ENV]: '1' } }))).toEqual({
      enabled: false,
      reason: 'disabled-by-env'
    })
  })

  it('does nothing when no destination is configured', () => {
    for (const dsn of [undefined, '', '   ']) {
      expect(decideCrashReporting(packaged({ dsn }))).toEqual({ enabled: false, reason: 'no-dsn' })
    }
  })

  it('never reports a developer build unless explicitly opted in', () => {
    expect(decideCrashReporting(packaged({ isPackaged: false }))).toEqual({
      enabled: false,
      reason: 'dev-build'
    })
    expect(decideCrashReporting(packaged({ isPackaged: false, env: { [DEV_ENV]: '1' } }))).toEqual({
      enabled: true,
      dsn: DSN
    })
  })

  it('trims a padded dsn rather than sending to a broken address', () => {
    expect(decideCrashReporting(packaged({ dsn: `  ${DSN}  ` }))).toEqual({ enabled: true, dsn: DSN })
  })
})

describe('scrubText', () => {
  it('removes provider keys, including the one style a user is most likely to paste', () => {
    const text = 'auth failed for sk-or-v1-cb9799bcffc4a13c05f6ad73f23f37406ecdf16c7561431560'
    const scrubbed = scrubText(text)

    expect(scrubbed).toContain('[openrouter-key]')
    expect(scrubbed).not.toContain('cb9799')
  })

  it('removes the other credential shapes Eternal handles', () => {
    const cases: Array<[string, string]> = [
      ['sk-ant-api03-abcdefghijklmnop123456', '[anthropic-key]'],
      ['ghp_abcdefghijklmnopqrstuvwxyz0123', '[github-token]'],
      ['xoxb-1234567890-abcdefghij', '[slack-token]'],
      ['AIzaSyA1234567890abcdefghijklmnopqrs', '[google-key]'],
      ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N', '[jwt]']
    ]

    for (const [secret, marker] of cases) {
      const scrubbed = scrubText(`token=${secret}`)
      expect(scrubbed, secret).toContain(marker)
      expect(scrubbed, secret).not.toContain(secret)
    }
  })

  it('replaces the home directory, which names the user and their work', () => {
    const trace = 'at load (/home/jane/clients/acme-corp/secret-project/index.js:12)'

    expect(scrubText(trace, '/home/jane')).toBe(
      'at load (~/clients/acme-corp/secret-project/index.js:12)'
    )
  })

  it('handles a home path containing regex characters', () => {
    expect(scrubText('/home/a+b(1)/file', '/home/a+b(1)')).toBe('~/file')
  })

  it('leaves ordinary text alone', () => {
    const text = 'TypeError: cannot read property length of undefined'

    expect(scrubText(text, '/home/jane')).toBe(text)
  })

  it('tolerates empty and missing input', () => {
    expect(scrubText('')).toBe('')
    expect(scrubText('anything', '')).toBe('anything')
  })
})

describe('scrubEvent', () => {
  it('scrubs strings at any depth, whatever shape the SDK sends', () => {
    const event = {
      message: 'failed with sk-ant-api03-abcdefghijklmnop123456',
      exception: {
        values: [{ stacktrace: { frames: [{ filename: '/home/jane/app/main.js' }] } }]
      },
      tags: ['ok', 'ghp_abcdefghijklmnopqrstuvwxyz0123']
    }

    const scrubbed = scrubEvent(event, '/home/jane')

    expect(scrubbed.message).toContain('[anthropic-key]')
    expect(scrubbed.exception.values[0].stacktrace.frames[0].filename).toBe('~/app/main.js')
    expect(scrubbed.tags[1]).toBe('[github-token]')
    expect(scrubbed.tags[0]).toBe('ok')
  })

  it('drops the environment wholesale rather than filtering it', () => {
    const scrubbed = scrubEvent({ contexts: { env: { OPENROUTER_API_KEY: 'sk-or-v1-abc', PATH: '/usr/bin' } } }, '')

    expect(scrubbed.contexts.env).toBe('[removed]')
  })

  it('does not mutate the event it was given', () => {
    const event = { message: 'key sk-ant-api03-abcdefghijklmnop123456' }
    const scrubbed = scrubEvent(event, '')

    expect(event.message).toContain('sk-ant-')
    expect(scrubbed.message).toContain('[anthropic-key]')
  })

  it('survives a self-referencing event instead of hanging', () => {
    const event: Record<string, unknown> = { message: 'hi' }
    event.self = event

    expect(() => scrubEvent(event, '')).not.toThrow()
  })

  it('passes non-string leaves through untouched', () => {
    expect(scrubEvent({ count: 3, ok: true, missing: null }, '')).toEqual({
      count: 3,
      ok: true,
      missing: null
    })
  })
})
