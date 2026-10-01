import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useI18n } from '@/i18n'
import { readableError } from '@/store/notifications'

interface Props {
  busy: boolean
  onClose: () => void
  onSave: (name: string, entry: Record<string, unknown>) => Promise<void>
}
interface Pair {
  key: string
  value: string
}

export function McpServerForm({ busy, onClose, onSave }: Props) {
  const { t } = useI18n()
  const m = t.settings.mcp
  const [type, setType] = useState<'stdio' | 'http'>('http')
  const [fields, setFields] = useState({ name: '', url: '', command: '', cwd: '', bearer: '' })

  const [groups, setGroups] = useState<Record<string, Pair[]>>({
    args: [],
    env: [],
    pass: [],
    headers: [],
    envHeaders: []
  })

  const [error, setError] = useState<string | null>(null)

  const field = (key: keyof typeof fields, label: string, placeholder = '') => (
    <label className="grid gap-1 text-sm">
      {label}
      <Input
        onChange={event => setFields({ ...fields, [key]: event.target.value })}
        placeholder={placeholder}
        value={fields[key]}
      />
    </label>
  )

  const group = (key: string, label: string, single = false, fromEnv = false) => {
    const update = (rows: Pair[]) => setGroups({ ...groups, [key]: rows })

    return (
      <section aria-label={label} className="grid gap-2">
        <h3 className="text-sm">{label}</h3>
        {groups[key].map((row, i) => (
          <div className="flex gap-2" key={i}>
            {!single && (
              <Input
                aria-label={`${label} ${m.keyLabel} ${i + 1}`}
                onChange={event =>
                  update(groups[key].map((item, j) => (j === i ? { ...item, key: event.target.value } : item)))
                }
                placeholder={m.keyLabel}
                value={row.key}
              />
            )}
            <Input
              aria-label={`${label} ${m.valueLabel} ${i + 1}`}
              onChange={event =>
                update(groups[key].map((item, j) => (j === i ? { ...item, value: event.target.value } : item)))
              }
              placeholder={fromEnv ? m.variableLabel : m.valueLabel}
              type={single || fromEnv ? 'text' : 'password'}
              value={row.value}
            />
            <Button
              aria-label={`${m.remove} ${label} ${i + 1}`}
              onClick={() => update(groups[key].filter((_, j) => j !== i))}
              size="sm"
              type="button"
              variant="text"
            >
              {m.remove}
            </Button>
          </div>
        ))}
        <Button
          onClick={() => update([...groups[key], { key: '', value: '' }])}
          size="sm"
          type="button"
          variant="secondary"
        >
          + {m.addValue}
        </Button>
      </section>
    )
  }

  const save = async () => {
    setError(null)

    try {
      const name = fields.name.trim()

      if (!name || !(type === 'http' ? fields.url.trim() : fields.command.trim())) {
        throw new Error(m.requiredDetails)
      }

      const pairs = (rows: Pair[], fromEnv = false) => {
        const entries = rows.map(row => {
          if (!row.key.trim() || !row.value.trim()) {
            throw new Error(m.incompleteRows)
          }

          return [row.key.trim(), fromEnv ? '${' + row.value.trim() + '}' : row.value]
        })

        if (new Set(entries.map(([key]) => key)).size !== entries.length) {
          throw new Error(m.duplicateKeys)
        }

        return Object.fromEntries(entries) as Record<string, string>
      }

      let entry: Record<string, unknown>

      if (type === 'http') {
        let url: URL

        try {
          url = new URL(fields.url.trim())
        } catch {
          throw new Error(m.invalidUrl)
        }

        if (!['http:', 'https:'].includes(url.protocol)) {
          throw new Error(m.invalidUrl)
        }

        const direct = pairs(groups.headers)
        const indirect = pairs(groups.envHeaders, true)

        const keys = [
          ...Object.keys(direct),
          ...Object.keys(indirect),
          ...(fields.bearer.trim() ? ['Authorization'] : [])
        ].map(key => key.toLowerCase())

        if (new Set(keys).size !== keys.length) {
          throw new Error(m.duplicateKeys)
        }

        const headers = {
          ...direct,
          ...indirect,
          ...(fields.bearer.trim() ? { Authorization: 'Bearer ${' + fields.bearer.trim() + '}' } : {})
        }

        entry = { url: fields.url.trim(), transport: 'http', ...(keys.length ? { headers } : {}) }
      } else {
        if ([...groups.args, ...groups.pass].some(row => !row.value.trim())) {
          throw new Error(m.incompleteRows)
        }

        const env = pairs([
          ...groups.env,
          ...groups.pass.map(row => ({ key: row.value.trim(), value: '${' + row.value.trim() + '}' }))
        ])

        entry = {
          command: fields.command.trim(),
          args: groups.args.map(row => row.value),
          ...(Object.keys(env).length ? { env } : {}),
          ...(fields.cwd.trim() ? { cwd: fields.cwd.trim() } : {})
        }
      }

      await onSave(name, entry)
    } catch (err) {
      setError(readableError(err, m.saveFailed).message)
    }
  }

  return (
    <Dialog
      onOpenChange={open => {
        if (!open && !busy) {
          onClose()
        }
      }}
      open
    >
      <DialogContent>
        <DialogTitle>{m.formTitle}</DialogTitle>
        <DialogDescription>{m.formDescription}</DialogDescription>
        <form
          className="grid gap-4"
          onSubmit={event => {
            event.preventDefault()
            void save()
          }}
        >
          <fieldset className="grid gap-4" disabled={busy}>
            {field('name', m.name, 'my-server')}
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm">{m.connectionType}</span>
              <SegmentedControl
                onChange={setType}
                options={[
                  { id: 'stdio', label: 'STDIO' },
                  { id: 'http', label: 'Streamable HTTP' }
                ]}
                value={type}
              />
            </div>
            {type === 'http' ? (
              <>
                {field('url', m.serverUrl, 'https://mcp.example.com/mcp')}
                {field('bearer', m.bearerVariable, 'MCP_BEARER_TOKEN')}
                {group('headers', m.headers)}
                {group('envHeaders', m.environmentHeaders, false, true)}
              </>
            ) : (
              <>
                {field('command', m.launchCommand, 'npx')}
                {group('args', m.arguments, true)}
                {group('env', m.environment)}
                {group('pass', m.passthrough, true, true)}
                {field('cwd', m.workingDirectory, '/home/user/project')}
              </>
            )}
            <p className="text-xs text-muted-foreground">
              {m.environmentHint} {m.advancedConfig}
            </p>
          </fieldset>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button disabled={busy} onClick={onClose} type="button" variant="text">
              {t.common.cancel}
            </Button>
            <Button disabled={busy} type="submit">
              {busy ? t.common.saving : t.common.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
