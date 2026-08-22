import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PromptProfilesSettings } from './prompt-profiles-settings'

const api = vi.hoisted(() => ({
  activate: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  designer: vi.fn(),
  list: vi.fn(),
  update: vi.fn()
}))

vi.mock('@/eternal', () => ({
  activatePromptProfile: api.activate,
  createPromptProfile: api.create,
  deletePromptProfile: api.delete,
  getPromptProfiles: api.list,
  sendPromptDesignerMessage: api.designer,
  updatePromptProfile: api.update
}))

vi.mock('../hooks/use-on-profile-switch', () => ({ useOnProfileSwitch: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('PromptProfilesSettings', () => {
  it('displays and opens the existing inline Base Prompt', async () => {
    api.list.mockResolvedValue({
      active_id: '',
      legacy_prompt: 'You are a content agent. Create clear, source-grounded content.',
      legacy_editable_prompt:
        '# 1. Identity and Purpose\n\nYou are a content agent. Create clear, source-grounded content.\n\n# 4. Completing the User’s Request',
      default_prompt: '# 1. Identity and Purpose\n\nYou are Eternal.',
      profiles: []
    })

    render(<PromptProfilesSettings />)

    expect((await screen.findAllByText('Current Base Prompt')).length).toBe(2)
    expect(screen.getByText('Active')).toBeTruthy()
    expect(
      await screen.findByDisplayValue(/# 1\. Identity and Purpose[\s\S]*# 4\. Completing the User’s Request/)
    ).toBeTruthy()
    expect(screen.getByText(/includes its standard sections 4–10 in every new profile/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Save as Prompt Profile/ })).toBeTruthy()
  })

  it('shows reusable agents and opens a new manual Base Prompt editor', async () => {
    api.list.mockResolvedValue({
      active_id: 'researcher',
      legacy_prompt: '',
      legacy_editable_prompt: '',
      default_prompt: '# 1. Identity and Purpose\n\nYou are Eternal.',
      profiles: [
        {
          id: 'researcher',
          name: 'Research Analyst',
          description: 'Evidence-first research',
          icon: 'sparkles',
          created_at: '2026-08-22T00:00:00Z',
          updated_at: '2026-08-22T00:00:00Z',
          full_control: true,
          prompt: 'You verify claims against primary sources.',
          path: '/tmp/prompt-profiles/researcher'
        }
      ]
    })

    render(<PromptProfilesSettings />)

    expect(await screen.findByText('Research Analyst')).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getByText('Sections 4–10')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Write manually' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Content Strategist' } })
    fireEvent.change(screen.getByLabelText('Base Prompt'), {
      target: { value: 'You create source-grounded content strategies.' }
    })

    expect(screen.getByDisplayValue('Content Strategist')).toBeTruthy()
    expect(screen.getByDisplayValue('You create source-grounded content strategies.')).toBeTruthy()
  })
})
