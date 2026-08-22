import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type * as Nanostores from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getProjectAgent,
  scanProjectAgent,
  sendProjectAgentDesignerMessage,
  updateProjectAgent
} from '@/eternal'

import { ProjectAgentDialog } from './project-agent-dialog'

afterEach(cleanup)

const { $projectAgentDialog } = vi.hoisted(() => {
  const { atom } = require('nanostores') as typeof Nanostores

  return {
    $projectAgentDialog: atom<null | { projectId: string; name: string }>({
      projectId: 'p-content',
      name: 'Content Engine'
    })
  }
})

vi.mock('@/store/projects', () => ({
  $projectAgentDialog,
  closeProjectAgent: vi.fn()
}))

vi.mock('@/eternal', () => ({
  getProjectAgent: vi.fn(),
  scanProjectAgent: vi.fn(),
  sendProjectAgentDesignerMessage: vi.fn(),
  updateProjectAgent: vi.fn()
}))

vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      common: { cancel: 'Cancel' },
      sidebar: {
        projects: {
          agentAdvancedWarning: 'Advanced sections warning.',
          agentAppliesToNewChats: 'Only new chats use changes.',
          agentBasePrompt: 'Project base prompt',
          agentBuildWithAi: 'Build with AI',
          agentChatPlaceholder: 'Describe this workspace',
          agentCurrentPrompt: 'Current prompt',
          agentDescription: 'Project overview',
          agentDesignerFailed: 'Designer failed',
          agentDraftPlaceholder: 'Draft appears here',
          agentEditManually: 'Edit manually',
          agentLiveDraft: 'Live draft',
          agentLoadFailed: 'Load failed',
          agentProposedPrompt: 'Proposed prompt',
          agentRejectDraft: 'Reject',
          agentReviewDraft: 'Review this draft',
          agentSave: 'Save prompt',
          agentSaveFailed: 'Save failed',
          agentSaved: 'Saved',
          agentSaving: 'Saving',
          agentScan: 'Scan project',
          agentScanFailed: 'Scan failed',
          agentScanNotice: 'Scan never runs automatically.',
          agentScanning: 'Scanning',
          agentThinking: 'Thinking',
          agentTitle: 'Project Agent',
          agentUseDraft: 'Use proposed prompt'
        }
      }
    }
  })
}))

const originalAgent = {
  default_prompt: 'DEFAULT PROMPT',
  exists: true,
  path: '/workspace/.eternal/projects/p-content/BASE_PROMPT.md',
  project_id: 'p-content',
  project_name: 'Content Engine',
  prompt: 'CURRENT PROMPT',
  root_folder: '/workspace',
  source: 'manual',
  updated_at: 1
}

describe('ProjectAgentDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    $projectAgentDialog.set({ projectId: 'p-content', name: 'Content Engine' })
    vi.mocked(getProjectAgent).mockResolvedValue({ agent: originalAgent })
    vi.mocked(updateProjectAgent).mockImplementation(async (_id, prompt, source) => ({
      agent: { ...originalAgent, prompt, source: source || 'manual' },
      ok: true
    }))
  })

  it('loads the current project prompt without scanning automatically', async () => {
    render(<ProjectAgentDialog />)

    expect(await screen.findByDisplayValue('CURRENT PROMPT')).toBeTruthy()
    expect(getProjectAgent).toHaveBeenCalledWith('p-content')
    expect(scanProjectAgent).not.toHaveBeenCalled()
  })

  it('keeps a scanned draft unsaved until the user approves and saves it', async () => {
    vi.mocked(scanProjectAgent).mockResolvedValue({
      description: 'Project overview',
      draft: 'SCANNED PROMPT',
      files_discovered: 12,
      files_read: 3,
      ready: true,
      reply: 'Built from workspace evidence.',
      suggested_name: 'Content Engine',
      warnings: []
    })
    render(<ProjectAgentDialog />)
    await screen.findByDisplayValue('CURRENT PROMPT')

    fireEvent.click(screen.getByRole('button', { name: 'Scan project' }))

    expect(await screen.findByText('SCANNED PROMPT')).toBeTruthy()
    expect(updateProjectAgent).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Use proposed prompt' }))
    expect(await screen.findByDisplayValue('SCANNED PROMPT')).toBeTruthy()
    expect(updateProjectAgent).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save prompt' }))

    await waitFor(() =>
      expect(updateProjectAgent).toHaveBeenCalledWith('p-content', 'SCANNED PROMPT', 'scan')
    )
  })

  it('can turn a Project Agent Designer conversation into a reviewable draft', async () => {
    vi.mocked(sendProjectAgentDesignerMessage).mockResolvedValue({
      description: 'Project overview',
      draft: 'AI PROMPT',
      ready: true,
      reply: 'I have enough context.',
      suggested_name: 'Content Engine'
    })
    render(<ProjectAgentDialog />)
    await screen.findByDisplayValue('CURRENT PROMPT')

    fireEvent.click(screen.getByRole('button', { name: 'Build with AI' }))
    const chatInput = screen.getByPlaceholderText('Describe this workspace')

    fireEvent.change(chatInput, {
      target: { value: 'This workspace supports the COO content operation.' }
    })
    fireEvent.keyDown(chatInput, { key: 'Enter' })

    expect(await screen.findByText('AI PROMPT')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Review this draft' }))
    expect(await screen.findByText('Proposed prompt')).toBeTruthy()
    expect(updateProjectAgent).not.toHaveBeenCalled()
  })
})
