import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  activatePromptProfile,
  createPromptProfile,
  deletePromptProfile,
  getPromptProfiles,
  sendPromptDesignerMessage,
  updatePromptProfile
} from '@/eternal'
import { triggerHaptic } from '@/lib/haptics'
import { Brain, Check, FileText, Lock, MessageCircle, Pencil, Plus, Save, Send, Trash2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'
import type { PromptDesignerMessage, PromptProfile } from '@/types/eternal'

import { useOnProfileSwitch } from '../hooks/use-on-profile-switch'

import { SettingsContent } from './primitives'

const DESIGNER_WELCOME: PromptDesignerMessage = {
  role: 'assistant',
  content:
    'What do you want this agent to be exceptionally good at? Describe the job in your own words—I’ll ask the important follow-up questions.'
}

const LEGACY_PROMPT_ID = '__current_base_prompt__'

type EditorDraft = { description: string; name: string; prompt: string }

const emptyDraft = (): EditorDraft => ({ description: '', name: '', prompt: '' })

export function PromptProfilesSettings({ onConfigSaved }: { onConfigSaved?: () => void }) {
  const [profiles, setProfiles] = useState<PromptProfile[] | null>(null)
  const [activeId, setActiveId] = useState('')
  const [legacyPrompt, setLegacyPrompt] = useState('')
  const [legacyEditablePrompt, setLegacyEditablePrompt] = useState('')
  const [defaultPrompt, setDefaultPrompt] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<EditorDraft>(emptyDraft)
  const [original, setOriginal] = useState<EditorDraft>(emptyDraft)
  const [saving, setSaving] = useState(false)
  const [designerOpen, setDesignerOpen] = useState(false)
  const [designerMode, setDesignerMode] = useState<'edit' | 'new'>('new')

  const load = async () => {
    try {
      const result = await getPromptProfiles()
      setProfiles(result.profiles)
      setActiveId(result.active_id)
      setLegacyPrompt(result.legacy_prompt)
      setLegacyEditablePrompt(result.legacy_editable_prompt)
      setDefaultPrompt(result.default_prompt)
      setSelectedId(current => {
        if (
          current === 'new' ||
          (current === LEGACY_PROMPT_ID && result.legacy_prompt) ||
          (current && result.profiles.some(profile => profile.id === current))
        ) {
          return current
        }

        return result.active_id || (result.legacy_prompt ? LEGACY_PROMPT_ID : result.profiles[0]?.id || null)
      })
    } catch (error) {
      notifyError(error, 'Could not load Prompt Profiles')
      setProfiles([])
    }
  }

  useEffect(() => {
    void load()
  }, [])

  useOnProfileSwitch(() => {
    setProfiles(null)
    setSelectedId(null)
    void load()
  })

  const selected = useMemo(
    () => profiles?.find(profile => profile.id === selectedId) ?? null,
    [profiles, selectedId]
  )

  const legacySelected = selectedId === LEGACY_PROMPT_ID && Boolean(legacyPrompt)

  useEffect(() => {
    const next = selected
      ? { description: selected.description, name: selected.name, prompt: selected.prompt }
      : legacySelected
        ? {
            description: 'The complete editable system instructions used for new chats',
            name: 'Current Base Prompt',
            prompt: legacyEditablePrompt || legacyPrompt
          }
      : selectedId === 'new'
        ? emptyDraft()
        : emptyDraft()

    setDraft(next)
    setOriginal(next)
  }, [legacyEditablePrompt, legacyPrompt, legacySelected, selected, selectedId])

  const dirty = JSON.stringify(draft) !== JSON.stringify(original)

  const startNew = (seed?: Partial<EditorDraft>) => {
    const next = { ...emptyDraft(), ...seed }
    setSelectedId('new')
    setDraft(next)
    setOriginal(emptyDraft())
  }

  const save = async () => {
    if (!draft.name.trim() || !draft.prompt.trim()) {
      notify({
        kind: 'error',
        title: 'Name and Base Prompt are required',
        message: 'Give this agent a name and describe how it should behave before saving.'
      })

      return
    }

    setSaving(true)

    try {
      if (selected) {
        const result = await updatePromptProfile(selected.id, draft)
        setActiveId(result.active_id)
        setSelectedId(result.profile.id)
        notify({ kind: 'success', title: 'Prompt Profile saved', message: result.profile.name })
      } else {
        const result = await createPromptProfile({ ...draft, activate: true })
        setActiveId(result.active_id)
        setSelectedId(result.profile.id)
        notify({ kind: 'success', title: 'Agent created', message: result.profile.name })
      }

      triggerHaptic('success')
      await load()
      window.dispatchEvent(new Event('eternal:prompt-profiles-changed'))
      onConfigSaved?.()
    } catch (error) {
      notifyError(error, 'Could not save Prompt Profile')
    } finally {
      setSaving(false)
    }
  }

  const activate = async (id: string) => {
    try {
      const result = await activatePromptProfile(id)
      setActiveId(result.active_id)
      triggerHaptic('success')
      notify({ kind: 'success', title: 'Agent selected', message: 'It will apply to new chats.' })
      window.dispatchEvent(new Event('eternal:prompt-profiles-changed'))
      onConfigSaved?.()
    } catch (error) {
      notifyError(error, 'Could not select Prompt Profile')
    }
  }

  const remove = async (profile: PromptProfile) => {
    if (!window.confirm(`Delete “${profile.name}”? This removes its BASE_PROMPT.md file.`)) {
      return
    }

    try {
      const result = await deletePromptProfile(profile.id)
      setActiveId(result.active_id)
      setSelectedId(null)
      await load()
      window.dispatchEvent(new Event('eternal:prompt-profiles-changed'))
      onConfigSaved?.()
    } catch (error) {
      notifyError(error, 'Could not delete Prompt Profile')
    }
  }

  return (
    <SettingsContent>
      <div className="mx-auto max-w-5xl pb-16 pt-5">
        <section className="relative overflow-hidden rounded-2xl border border-primary/25 bg-[radial-gradient(circle_at_top_right,var(--color-primary)/0.16,transparent_48%),linear-gradient(135deg,var(--ui-bg-secondary),var(--ui-bg-primary))] p-6 shadow-sm">
          <div className="relative z-10 max-w-2xl">
            <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <Brain className="size-5" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">Create your own agent</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Talk with Agent Designer or write directly. Eternal keeps the technical machinery intact while you
              control sections 1–10. Eternal still adds the live skills catalog, memory, workspace and runtime facts.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  setDesignerMode('new')
                  setDesignerOpen(true)
                }}
              >
                <MessageCircle />
                Build with AI
              </Button>
              <Button onClick={() => startNew({ prompt: defaultPrompt })} variant="outline">
                <Pencil />
                Write manually
              </Button>
              {legacyPrompt ? (
                <Button
                  onClick={() => setSelectedId(LEGACY_PROMPT_ID)}
                  variant="ghost"
                >
                  View current Base Prompt
                </Button>
              ) : null}
            </div>
          </div>
        </section>

        <section className="mt-7">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Prompt Profiles</h2>
              <p className="mt-1 text-xs text-muted-foreground">Switch behavior without changing tools, keys or memory.</p>
            </div>
            <Button onClick={() => startNew({ prompt: defaultPrompt })} size="sm" variant="outline">
              <Plus /> New
            </Button>
          </div>

          {profiles === null ? (
            <div className="h-24 animate-pulse rounded-xl bg-muted/30" />
          ) : profiles.length === 0 && !legacyPrompt ? (
            <button
              className="flex w-full items-center justify-center rounded-xl border border-dashed border-border/70 px-5 py-10 text-sm text-muted-foreground transition hover:border-primary/45 hover:text-foreground"
              onClick={() => {
                setDesignerMode('new')
                setDesignerOpen(true)
              }}
              type="button"
            >
              Create your first agent with AI
            </button>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {legacyPrompt ? (
                <button
                  className={cn(
                    'group rounded-xl border p-4 text-left transition',
                    legacySelected ? 'border-primary/55 bg-primary/7' : 'border-border/60 bg-card/45 hover:border-border'
                  )}
                  onClick={() => setSelectedId(LEGACY_PROMPT_ID)}
                  type="button"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex size-8 items-center justify-center rounded-lg bg-muted/55">
                      <Brain className="size-4" />
                    </span>
                    {!activeId ? (
                      <span className="flex items-center gap-1 rounded-full bg-primary/12 px-2 py-1 text-[0.65rem] font-medium text-primary">
                        <Check className="size-3" /> Active
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-3 truncate text-sm font-medium">Current Base Prompt</div>
                  <div className="mt-1 line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground">
                    {legacyPrompt}
                  </div>
                </button>
              ) : null}
              {profiles.map(profile => {
                const active = profile.id === activeId
                const selectedCard = profile.id === selectedId

                return (
                  <button
                    className={cn(
                      'group rounded-xl border p-4 text-left transition',
                      selectedCard ? 'border-primary/55 bg-primary/7' : 'border-border/60 bg-card/45 hover:border-border'
                    )}
                    key={profile.id}
                    onClick={() => setSelectedId(profile.id)}
                    type="button"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="flex size-8 items-center justify-center rounded-lg bg-muted/55">
                        <Brain className="size-4" />
                      </span>
                      {active ? (
                        <span className="flex items-center gap-1 rounded-full bg-primary/12 px-2 py-1 text-[0.65rem] font-medium text-primary">
                          <Check className="size-3" /> Active
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-3 truncate text-sm font-medium">{profile.name}</div>
                    <div className="mt-1 line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground">
                      {profile.description || profile.prompt}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        {selectedId ? (
          <section className="mt-7 rounded-xl border border-border/65 bg-card/35 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">
                  {selected ? `Edit ${selected.name}` : legacySelected ? 'Current Base Prompt' : 'New Prompt Profile'}
                </h2>
                <p className="mt-1 font-mono text-[0.68rem] text-muted-foreground/65">
                  {selected?.path
                    ? `${selected.path}/BASE_PROMPT.md`
                    : legacySelected
                      ? 'Currently stored in agent.base_prompt; saving creates a reusable BASE_PROMPT.md'
                      : 'A new BASE_PROMPT.md will be created'}
                </p>
              </div>
              <div className="flex gap-2">
                {selected || legacySelected ? (
                  <Button
                    onClick={() => {
                      setDesignerMode('edit')
                      setDesignerOpen(true)
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <MessageCircle /> Improve with AI
                  </Button>
                ) : null}
                {selected && selected.id !== activeId ? (
                  <Button onClick={() => void activate(selected.id)} size="sm" variant="outline">
                    Use for new chats
                  </Button>
                ) : null}
                {selected ? (
                  <Button className="text-destructive" onClick={() => void remove(selected)} size="sm" variant="ghost">
                    <Trash2 />
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-xs font-medium">
                Name
                <Input onChange={event => setDraft(value => ({ ...value, name: event.target.value }))} value={draft.name} />
              </label>
              <label className="grid gap-1.5 text-xs font-medium">
                Description
                <Input
                  onChange={event => setDraft(value => ({ ...value, description: event.target.value }))}
                  placeholder="What this agent is best for"
                  value={draft.description}
                />
              </label>
            </div>
            <div className="mt-4 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs font-normal leading-5 text-muted-foreground">
              Eternal includes its standard sections 4–10 in every new profile. They control tools, memory, skills,
              profiles and app features. You can edit them later, but incorrect instructions may make those features
              unreliable. Restore the default text if something stops working.
            </div>
            <label className="mt-3 grid gap-1.5 text-xs font-medium">
              Base Prompt
              <Textarea
                className="min-h-80 resize-y bg-background font-mono text-xs leading-5"
                onChange={event => setDraft(value => ({ ...value, prompt: event.target.value }))}
                placeholder="Define the agent's role, priorities, working method and behavior..."
                spellCheck
                value={draft.prompt}
              />
            </label>
            <div className="mt-4 flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">Changes apply to new chats.</span>
              <Button disabled={(!dirty && !legacySelected) || saving} onClick={() => void save()}>
                <Save />{' '}
                {saving
                  ? 'Saving…'
                  : selected
                    ? 'Save changes'
                    : legacySelected
                      ? 'Save as Prompt Profile'
                      : 'Create and activate'}
              </Button>
            </div>
          </section>
        ) : null}

        <PromptLayers />
      </div>

      <AgentDesignerDialog
        currentPrompt={
          designerMode === 'edit' ? draft.prompt : legacyEditablePrompt || defaultPrompt || legacyPrompt
        }
        onClose={() => setDesignerOpen(false)}
        onUseDraft={result => {
          if (designerMode === 'edit' && (selected || legacySelected)) {
            setDraft(result)
          } else {
            startNew(result)
          }

          setDesignerOpen(false)
        }}
        open={designerOpen}
      />
    </SettingsContent>
  )
}

function PromptLayers() {
  const layers = [
    {
      icon: Pencil,
      title: 'Sections 1–3',
      body: 'Identity, purpose, communication style, accuracy and honesty.',
      tone: 'border-primary/25 bg-primary/5'
    },
    {
      icon: Lock,
      title: 'Sections 4–10',
      body: 'Editable tool, memory, skill, steering, profile and interface instructions. Change these with care.',
      tone: 'border-amber-500/25 bg-amber-500/5'
    },
    {
      icon: FileText,
      title: 'Sections 11–12',
      body: 'Added live: installed skills, memory, workspace, model, provider, platform, date and runtime context.',
      tone: 'border-border/65 bg-card/35'
    }
  ]

  return (
    <section className="mt-7">
      <h2 className="text-sm font-semibold">What reaches the model</h2>
      <div className="mt-3 grid gap-2 md:grid-cols-3">
        {layers.map(layer => (
          <div className={cn('rounded-xl border p-4', layer.tone)} key={layer.title}>
            <layer.icon className="size-4 text-muted-foreground" />
            <div className="mt-3 text-xs font-semibold">{layer.title}</div>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{layer.body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function AgentDesignerDialog({
  currentPrompt,
  onClose,
  onUseDraft,
  open
}: {
  currentPrompt: string
  onClose: () => void
  onUseDraft: (draft: EditorDraft) => void
  open: boolean
}) {
  const [messages, setMessages] = useState<PromptDesignerMessage[]>([DESIGNER_WELCOME])
  const [input, setInput] = useState('')
  const [working, setWorking] = useState(false)
  const [latestDraft, setLatestDraft] = useState<EditorDraft | null>(null)

  useEffect(() => {
    if (open) {
      setMessages([DESIGNER_WELCOME])
      setInput('')
      setLatestDraft(null)
    }
  }, [open])

  const send = async () => {
    const text = input.trim()

    if (!text || working) {
      return
    }

    const userMessage: PromptDesignerMessage = { role: 'user', content: text }
    const nextMessages = [...messages, userMessage]
    setMessages(nextMessages)
    setInput('')
    setWorking(true)

    try {
      const result = await sendPromptDesignerMessage(nextMessages, latestDraft?.prompt || currentPrompt)
      setMessages(value => [...value, { role: 'assistant', content: result.reply }])

      if (result.draft) {
        setLatestDraft({
          name: result.suggested_name || latestDraft?.name || 'My Agent',
          description: result.description || latestDraft?.description || '',
          prompt: result.draft
        })
      }
    } catch (error) {
      notifyError(error, 'Agent Designer could not respond')
    } finally {
      setWorking(false)
    }
  }

  return (
    <Dialog onOpenChange={next => !next && onClose()} open={open}>
      <DialogContent className="flex h-[min(780px,88vh)] max-w-4xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b border-border/60 px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <Brain className="size-5 text-primary" /> Agent Designer
          </DialogTitle>
          <p className="text-xs text-muted-foreground">Describe the agent you need. Eternal will turn the conversation into a real Base Prompt.</p>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 md:grid-cols-[1fr_0.9fr]">
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
              {working ? <div className="w-fit animate-pulse rounded-xl bg-muted/55 px-3.5 py-2.5 text-sm">Thinking…</div> : null}
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
                placeholder="Tell Agent Designer what you need…"
                value={input}
              />
              <Button disabled={!input.trim() || working} onClick={() => void send()} size="icon">
                <Send />
              </Button>
            </div>
          </div>

          <div className="min-h-0 overflow-y-auto bg-muted/15 p-5">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Live draft</div>
            {latestDraft ? (
              <>
                <div className="mt-4 text-base font-semibold">{latestDraft.name}</div>
                {latestDraft.description ? <p className="mt-1 text-xs text-muted-foreground">{latestDraft.description}</p> : null}
                <pre className="mt-4 whitespace-pre-wrap rounded-xl border border-border/60 bg-background p-4 text-xs leading-5">
                  {latestDraft.prompt}
                </pre>
              </>
            ) : (
              <div className="mt-10 text-center text-xs leading-5 text-muted-foreground">
                The draft will appear here as Agent Designer learns what you need.
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="border-t border-border/60 px-6 py-4">
          <Button onClick={onClose} variant="ghost">Cancel</Button>
          <Button disabled={!latestDraft} onClick={() => latestDraft && onUseDraft(latestDraft)}>
            Use this draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
