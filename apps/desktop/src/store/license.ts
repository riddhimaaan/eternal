import { atom } from 'nanostores'

import type { DesktopLicenseDecision, DesktopLicenseState } from '@/global'

export interface LicenseView extends DesktopLicenseState {
  /** False until the main process has answered, so nothing flashes during boot. */
  checked: boolean
}

// Open until told otherwise. Every failure path below lands back here on
// purpose: a renderer that cannot reach the main process has learned nothing
// about whether someone paid, and refusing to start on that basis would lock
// out honest customers over a bug of ours.
const OPEN: LicenseView = { state: 'not-enforced', usable: true, purchaseUrl: '', checked: false }

export const $license = atom<LicenseView>(OPEN)

export async function refreshLicense(): Promise<void> {
  const api = window.eternalDesktop

  if (!api?.getLicenseState) {
    $license.set({ ...OPEN, checked: true })

    return
  }

  try {
    $license.set({ ...(await api.getLicenseState()), checked: true })
  } catch {
    $license.set({ ...OPEN, checked: true })
  }
}

/** Hand a typed key to the main process, which is the only thing that verifies it. */
export async function activateLicense(key: string): Promise<DesktopLicenseDecision> {
  const decision = await window.eternalDesktop.activateLicense(key)

  if (decision.usable) {
    await refreshLicense()
  }

  return decision
}
