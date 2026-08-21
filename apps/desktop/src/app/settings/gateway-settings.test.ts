import { describe, expect, it } from 'vitest'

import { visibleGatewayMode } from './gateway-settings'

describe('visibleGatewayMode', () => {
  it('recovers an inherited cloud selection to the local gateway', () => {
    expect(visibleGatewayMode('cloud')).toBe('local')
  })

  it.each(['local', 'remote', 'ssh'] as const)('keeps the supported %s mode', mode => {
    expect(visibleGatewayMode(mode)).toBe(mode)
  })
})
