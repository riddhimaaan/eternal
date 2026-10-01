import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type * as EternalApi from '@/eternal'

import { McpTab } from './mcp-tab'

const spies = vi.hoisted(() => ({
  save: vi.fn(),
  probe: vi.fn(),
  auth: vi.fn(),
  status: vi.fn(),
  cache: vi.fn(),
  open: vi.fn()
}))

vi.mock('@/eternal', async original => ({
  ...(await original<typeof EternalApi>()),
  saveMcpServers: spies.save,
  testMcpServer: spies.probe,
  authMcpServer: spies.auth,
  getMcpOAuthFlow: spies.status,
  getMcpCatalog: async () => ({ entries: [] }),
  getUsageAnalytics: async () => ({ tools: [] })
}))
vi.mock('../hooks/use-config-record', () => ({
  useEternalConfigRecord: () => ({ data: { mcp_servers: {} }, isLoading: false, refetch: vi.fn() }),
  eternalConfigCacheWriter: () => spies.cache
}))
vi.mock('../hooks/use-on-profile-switch', () => ({ useOnProfileSwitch: vi.fn() }))
vi.mock('../settings/use-deep-link-highlight', () => ({ useDeepLinkHighlight: vi.fn() }))
vi.mock('@/components/chat/json-document-editor', () => ({ JsonDocumentEditor: () => null }))
vi.mock('@/components/chat/log-tail', () => ({ LogTail: () => null }))

describe('adding an OAuth HTTP server', () => {
  it('saves, detects the auth challenge, and opens the browser without losing the new server', async () => {
    spies.save.mockResolvedValue({ ok: true })
    spies.probe.mockResolvedValue({ ok: false, error: '401 Unauthorized', tools: [] })
    spies.auth.mockResolvedValue({
      flow_id: 'flow',
      status: 'authorization_required',
      authorization_url: 'https://example.com/authorize'
    })
    spies.status.mockResolvedValue({ status: 'approved', tools: [] })
    spies.open.mockResolvedValue(undefined)
    Object.defineProperty(window, 'eternalDesktop', { configurable: true, value: { openExternal: spies.open } })
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <McpTab gateway={null} profile="test-profile" />
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'New server' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fathom' } })
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://api.fathom.ai/mcp' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(spies.open).toHaveBeenCalledWith('https://example.com/authorize'))
    expect(spies.save).toHaveBeenCalledWith(
      { Fathom: { url: 'https://api.fathom.ai/mcp', transport: 'http' } },
      'test-profile'
    )
    expect(spies.probe).toHaveBeenCalledWith('Fathom', 'test-profile')
    expect(spies.auth).toHaveBeenCalledWith('Fathom', 'test-profile')
    await waitFor(() => expect(spies.cache).toHaveBeenCalledTimes(2))
    const update = spies.cache.mock.calls[1][0]
    expect(update({ mcp_servers: {} }).mcp_servers.Fathom).toEqual({
      url: 'https://api.fathom.ai/mcp',
      transport: 'http',
      auth: 'oauth'
    })
  })
})
