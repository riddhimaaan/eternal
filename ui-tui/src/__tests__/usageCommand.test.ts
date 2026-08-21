import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sessionCommands } from '../app/slash/commands/session.js'
import type { SessionUsageResponse } from '../gatewayTypes.js'

const usageCommand = sessionCommands.find(cmd => cmd.name === 'usage')!

const guarded =
  <T>(fn: (r: T) => void) =>
  (r: null | T) => {
    if (r) {
      fn(r)
    }
  }

/** Build a ctx whose rpc routes by method name to a supplied map of results. */
const buildCtx = (results: Record<string, unknown>) => {
  const sys = vi.fn()
  const panel = vi.fn()

  const rpc = vi.fn((method: string, _params: unknown) => Promise.resolve(results[method]))

  const ctx = {
    gateway: { rpc },
    guarded,
    guardedErr: vi.fn(),
    sid: 'sid-1',
    stale: () => false,
    transcript: { page: vi.fn(), panel, sys }
  }

  const run = async (arg: string) => {
    usageCommand.run(arg, ctx as any, 'usage')
    await rpc.mock.results[0]?.value
    await Promise.resolve()
    await Promise.resolve()
  }

  return { ctx, panel, run, sys }
}

const baseUsage = (overrides: Partial<SessionUsageResponse> = {}): SessionUsageResponse =>
  ({ calls: 0, input: 0, output: 0, total: 0, ...overrides }) as SessionUsageResponse

const printed = (sys: ReturnType<typeof vi.fn>) => sys.mock.calls.map(c => c[0]).join('\n')

describe('/usage slash command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports when the session has made no API calls', async () => {
    const empty = buildCtx({ 'session.usage': baseUsage({ calls: 0 }) })
    await empty.run('')
    expect(printed(empty.sys)).toContain('no API calls yet')
    expect(empty.panel).not.toHaveBeenCalled()
  })

  it('renders provider-neutral token and API-call usage', async () => {
    const { panel, run } = buildCtx({
      'session.usage': baseUsage({
        calls: 2,
        input: 1200,
        model: 'openai/gpt-5',
        output: 300,
        total: 1500
      })
    })

    await run('')

    expect(panel).toHaveBeenCalledWith(
      'Usage',
      expect.arrayContaining([
        expect.objectContaining({
          rows: expect.arrayContaining([
            ['Model', 'openai/gpt-5'],
            ['Input tokens', '1,200'],
            ['Output tokens', '300'],
            ['Total tokens', '1,500'],
            ['API calls', '2']
          ])
        })
      ])
    )
  })

  it('includes context and compression details when available', async () => {
    const { panel, run } = buildCtx({
      'session.usage': baseUsage({
        calls: 1,
        compressions: 2,
        context_max: 100_000,
        context_percent: 25,
        context_used: 25_000
      })
    })

    await run('')

    const sections = panel.mock.calls[0]?.[1] as { text?: string }[]
    expect(sections.map(section => section.text).filter(Boolean)).toEqual([
      'Context: 25,000 / 100,000 (25%)',
      'Compressions: 2'
    ])
  })
})
