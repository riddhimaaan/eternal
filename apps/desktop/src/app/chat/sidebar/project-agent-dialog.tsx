import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import {
  getProjectAgent,
  scanProjectAgent,
  sendProjectAgentDesignerMessage,
  updateProjectAgent
} from '@/eternal'
import { useI18n } from '@/i18n'
import { Brain, FileSearch, Pencil, Save, Send } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'
import { $projectAgentDialog, closeProjectAgent } from '@/store/projects'
import type { ProjectAgentPrompt, PromptDesignerMessage, PromptDesignerResponse } from '@/types/eternal'


const welcome = (name: string): PromptDesignerMessage => ({
  role: 'assistant',
  content: `Tell me what “${name}” is as a workspace—who or what it serves, why it exists, and its overall objectives. You do not need to list every task.`
})

export function ProjectAgentDialog() {
  const { t } = useI18n()
  const p = t.sidebar.projects
  const state = useStore($projectAgentDialog)
  const open = state !== null
  const [agent, setAgent] = useState<ProjectAgentPrompt | null>(null)
  const [draft, setDraft] = useState('')
  const [original, setOriginal] = useState('')
  const [proposed, setProposed] = useState<null | { prompt: string; source: 'ai' | 'scan'; note: string }>(null)
  const [mode, setMode] = useState<'designer' | 'editor'>('editor')
  const [messages, setMessages] = useState<PromptDesignerMessage[]>([])
  const [input, setInput] = useState('')
  const [latest, setLatest] = useState<PromptDesignerResponse | null>(null)
  const [draftSource, setDraftSource] = useState<'ai' | 'manual' | 'scan'>('manual')
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!state) {
      return
    }

    let cancelled = false
    setLoading(true)
    setMode('editor')
    setProposed(null)
    setLatest(null)
    setDraftSource('manual')
    setMessages([welcome(state.name)])
    setInput('')
    setAgent(null)
    setDraft('')
    setOriginal('')

    void getProjectAgent(state.projectId)
      .then(result => {
        if (cancelled) {
          return
        }

        const next = result.agent.prompt || result.agent.default_prompt
        setAgent(result.agent)
        setDraft(next)
        setOriginal(next)
      })
      .catch(error => notifyError(error, p.agentLoadFailed))
      .finally(() => !cancelled && setLoading(false))

    return () => {
      cancelled = true
    }
  }, [p.agentLoadFailed, state])

  const scan = async () => {
    if (!state || working) {
      return
    }

    setWorking(true)

    try {
      const result = await scanProjectAgent(state.projectId)

      if (!result.draft) {
        throw new Error('The scan completed without producing a prompt draft.')
      }

      const details = `${result.files_discovered} files found; ${result.files_read} relevant text files read.`
      const warning = result.warnings.length ? ` ${result.warnings.join(' ')}` : ''
      setProposed({ note: `${result.reply}\n\n${details}${warning}`, prompt: result.draft, source: 'scan' })
      setMode('editor')
    } catch (error) {
      notifyError(error, p.agentScanFailed)
    } finally {
      setWorking(false)
    }
  }

  const send = async () => {
    const text = input.trim()

    if (!state || !text || working) {
      return
    }

    const user: PromptDesignerMessage = { role: 'user', content: text }
    const next = [...messages, user]
    setMessages(next)
    setInput('')
    setWorking(true)

    try {
      const result = await sendProjectAgentDesignerMessage(
        state.projectId,
        next,
        latest?.draft || draft
      )

      setMessages(value => [...value, { role: 'assistant', content: result.reply }])

      if (result.draft) {
        setLatest(result)
      }
    } catch (error) {
      notifyError(error, p.agentDesignerFailed)
    } finally {
      setWorking(false)
    }
  }

  const save = async () => {
    if (!state || !draft.trim() || saving) {
      return
    }

    setSaving(true)

    try {
      const result = await updateProjectAgent(state.projectId, draft, draftSource)
      setAgent(result.agent)
      setOriginal(result.agent.prompt)
      setDraft(result.agent.prompt)
      setProposed(null)
      setDraftSource('manual')
      notify({ kind: 'success', title: p.agentSaved, message: p.agentAppliesToNewChats })
    } catch (error) {
      notifyError(error, p.agentSaveFailed)
    } finally {
      setSaving(false)
    }
  }

  const useProposed = () => {
    if (!proposed) {
      return
    }

    setDraft(proposed.prompt)
    setDraftSource(proposed.source)
    setProposed(null)
  }

  const reviewDesignerDraft = () => {
    if (!latest?.draft) {
      return
    }

    setProposed({ note: latest.reply, prompt: latest.draft, source: 'ai' })
    setMode('editor')
  }

  return (
    <Dialog onOpenChange={next => !next && closeProjectAgent()} open={open}>
      <DialogContent className="flex h-[min(860px,92vh)] max-w-6xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b border-border/60 px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <Brain className="size-5 text-primary" /> {p.agentTitle}: {state?.name}
          </DialogTitle>
          <DialogDescription>{p.agentDescription}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-6 py-3">
          <Button disabled={loading || working || !agent?.root_folder} onClick={() => void scan()} size="sm">
            <FileSearch /> {working && mode === 'editor' ? p.agentScanning : p.agentScan}
          </Button>
          <Button disabled={loading} onClick={() => setMode('designer')} size="sm" variant="outline">
            <Brain /> {p.agentBuildWithAi}
          </Button>
          <Button disabled={loading} onClick={() => setMode('editor')} size="sm" variant="ghost">
            <Pencil /> {p.agentEditManually}
          </Button>
          <span className="ml-auto max-w-[48%] truncate font-mono text-[0.65rem] text-muted-foreground/70">
            {agent?.path}
          </span>
          <p className="w-full text-[0.68rem] leading-4 text-muted-foreground">{p.agentScanNotice}</p>
        </div>

        {mode === 'designer' ? (
          <div className="grid min-h-0 flex-1 md:grid-cols-[1fr_1fr]">
            <div className="flex min-h-0 flex-col border-r border-border/60">
              <div className="flex-1 space-y-3 overflow-y-auto p-5">
                {messages.map((message, index) => (
                  <div
                    className={cn(
                      'max-w-[88%] rounded-xl px-3.5 py-2.5 text-sm leading-5',
                      message.role === 'user' ? 'ml-auto bg-primary text-primary-foreground' : 'bg-muted/55'
                    )}
                    key={`${message.role}-${index}`}
                  >
                    {message.content}
                  </div>
                ))}
                {working ? <div className="w-fit animate-pulse rounded-xl bg-muted/55 px-3.5 py-2.5 text-sm">{p.agentThinking}</div> : null}
              </div>
              <div className="flex gap-2 border-t border-border/60 p-4">
                <Textarea
                  className="min-h-10 max-h-28 resize-none"
                  onChange={event => setInput(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void send()
                    }
                  }}
                  placeholder={p.agentChatPlaceholder}
                  value={input}
                />
                <Button disabled={!input.trim() || working} onClick={() => void send()} size="icon">
                  <Send />
                </Button>
              </div>
            </div>
            <div className="min-h-0 overflow-y-auto bg-muted/15 p-5">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{p.agentLiveDraft}</div>
              {latest?.draft ? (
                <>
                  <pre className="mt-4 whitespace-pre-wrap rounded-xl border border-border/60 bg-background p-4 text-xs leading-5">{latest.draft}</pre>
                  <Button className="mt-4" onClick={reviewDesignerDraft}>{p.agentReviewDraft}</Button>
                </>
              ) : (
                <p className="mt-10 text-center text-xs leading-5 text-muted-foreground">{p.agentDraftPlaceholder}</p>
              )}
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            {loading ? <div className="h-80 animate-pulse rounded-xl bg-muted/30" /> : proposed ? (
              <>
                <div className="rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-xs leading-5 text-muted-foreground whitespace-pre-wrap">{proposed.note}</div>
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <PromptPanel label={p.agentCurrentPrompt} prompt={original} />
                  <PromptPanel label={p.agentProposedPrompt} prompt={proposed.prompt} />
                </div>
                <div className="mt-4 flex justify-end gap-2">
                  <Button onClick={() => setProposed(null)} variant="ghost">{p.agentRejectDraft}</Button>
                  <Button onClick={useProposed}>{p.agentUseDraft}</Button>
                </div>
              </>
            ) : (
              <div className="grid gap-3">
                <div className="rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-xs leading-5 text-muted-foreground">
                  {p.agentAdvancedWarning}
                </div>
                <label className="grid gap-2 text-xs font-medium">
                  {p.agentBasePrompt}
                  <Textarea
                    className="min-h-[34rem] resize-y bg-background font-mono text-xs leading-5"
                    onChange={event => setDraft(event.target.value)}
                    spellCheck
                    value={draft}
                  />
                </label>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="border-t border-border/60 px-6 py-4">
          <span className="mr-auto text-xs text-muted-foreground">{p.agentAppliesToNewChats}</span>
          <Button onClick={closeProjectAgent} variant="ghost">{t.common.cancel}</Button>
          {mode === 'editor' && !proposed ? (
            <Button disabled={!draft.trim() || draft === original || saving} onClick={() => void save()}>
              <Save /> {saving ? p.agentSaving : p.agentSave}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PromptPanel({ label, prompt }: { label: string; prompt: string }) {
  return (
    <section className="min-w-0">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</h3>
      <pre className="mt-2 max-h-[31rem] overflow-auto whitespace-pre-wrap rounded-xl border border-border/60 bg-background p-4 text-xs leading-5">{prompt}</pre>
    </section>
  )
}
