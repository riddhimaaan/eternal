import { useStore } from '@nanostores/react'
import { type FormEvent, useEffect, useState } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { AlertCircle, Loader2 } from '@/lib/icons'
import { $license, activateLicense, refreshLicense } from '@/store/license'

/**
 * The gate a paying customer meets.
 *
 * Shown only when the licence state says this copy may not run, which covers
 * four cases — no key yet, a key that does not verify, one that has expired,
 * and one that was withdrawn. All four take the same input, because in every
 * one of them the fix is to enter a key, so there is nothing to be gained by
 * sending someone down a different path.
 *
 * The verdict comes from the main process; nothing here decides it. A renderer
 * is the wrong place to hold that question, and treating its answer as
 * authoritative would mean a devtools console could unlock the product.
 */
export function LicenseOverlay() {
  const license = useStore($license)
  const { t } = useI18n()
  const copy = t.license
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void refreshLicense()
  }, [])

  // Until the answer arrives, show nothing rather than a gate that vanishes —
  // a flash of "pay up" on every launch would be its own kind of insult.
  if (!license.checked || license.usable) {
    return null
  }

  const title =
    license.state === 'expired'
      ? copy.expiredTitle
      : license.state === 'revoked'
        ? copy.revokedTitle
        : license.state === 'invalid'
          ? copy.invalidTitle
          : copy.activateTitle

  // The state's own message explains the unhappy cases better than a generic
  // line; only the first-time case needs its own description.
  const description = license.state === 'unlicensed' ? copy.activateDesc : license.message || copy.activateDesc

  const submit = async (event: FormEvent) => {
    event.preventDefault()

    if (!key.trim()) {
      setError(copy.emptyKey)

      return
    }

    setBusy(true)
    setError(null)

    try {
      const decision = await activateLicense(key)

      if (!decision.usable) {
        setError(decision.message || copy.invalidTitle)
      }
    } catch {
      setError(copy.unexpected)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-(--z-setup) flex items-center justify-center bg-background/95 p-4 backdrop-blur-md">
      <form
        className="flex w-full max-w-lg flex-col rounded-xl border border-(--stroke-nous) bg-card p-8 shadow-nous"
        onSubmit={submit}
      >
        <div className="flex items-start gap-4">
          <BrandMark className="size-11 shrink-0" />
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
          </div>
        </div>

        <label className="mt-6 grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{copy.keyLabel}</span>
          <Input
            autoFocus
            className="font-mono text-sm"
            disabled={busy}
            onChange={event => {
              setError(null)
              setKey(event.target.value)
            }}
            placeholder={copy.keyPlaceholder}
            spellCheck={false}
            value={key}
          />
          <span className="text-xs text-muted-foreground">{copy.offlineNote}</span>
        </label>

        {error ? (
          <div className="mt-4 flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="mt-6 flex items-center justify-between gap-3">
          {license.purchaseUrl ? (
            <Button
              onClick={() => void window.eternalDesktop?.openExternal?.(license.purchaseUrl)}
              type="button"
              variant="ghost"
            >
              {copy.purchase}
            </Button>
          ) : (
            <span />
          )}

          <Button disabled={busy} type="submit">
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {busy ? copy.activating : copy.activate}
          </Button>
        </div>
      </form>
    </div>
  )
}
