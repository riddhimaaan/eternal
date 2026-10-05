import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { McpServerForm } from './mcp-server-form'

const input = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

describe('custom MCP form', () => {
  it('saves an HTTP connection and bearer environment reference without JSON entry', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(<McpServerForm busy={false} onClose={vi.fn()} onSave={save} />)
    input('Name', 'research')
    input('Server URL', 'https://example.com/mcp')
    input('Bearer token environment variable', 'MCP_TOKEN')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('research', {
        url: 'https://example.com/mcp',
        transport: 'http',
        headers: { Authorization: 'Bearer ${MCP_TOKEN}' }
      })
    )
  })
  it('blocks invalid URLs and allows cancel without saving', async () => {
    const save = vi.fn()
    const close = vi.fn()
    render(<McpServerForm busy={false} onClose={close} onSave={save} />)
    input('Name', 'bad')
    input('Server URL', 'file:///tmp/mcp')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toContain('HTTP or HTTPS')
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(close).toHaveBeenCalledOnce()
  })
  it('rejects a pasted secret in the bearer variable field', async () => {
    const save = vi.fn()
    render(<McpServerForm busy={false} onClose={vi.fn()} onSave={save} />)
    input('Name', 'research')
    input('Server URL', 'https://example.com/mcp')
    input('Bearer token environment variable', 'sk-live.abc123')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toContain('variable name')
    expect(save).not.toHaveBeenCalled()
  })
  it('saves a local command with arguments as separate values', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(<McpServerForm busy={false} onClose={vi.fn()} onSave={save} />)
    input('Name', 'local')
    fireEvent.click(screen.getByRole('button', { name: 'STDIO' }))
    input('Command to launch', 'npx')
    const section = screen.getByRole('region', { name: 'Arguments' })
    fireEvent.click(section.querySelector('button')!)
    input('Arguments Value 1', '-y')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith('local', { command: 'npx', args: ['-y'] }))
  })
})
