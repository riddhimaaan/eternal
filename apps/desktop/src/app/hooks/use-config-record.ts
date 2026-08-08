import { useQuery } from '@tanstack/react-query'

import { getEternalConfigRecord } from '@/eternal'
import { queryClient, writeCache } from '@/lib/query-client'
import type { EternalConfigRecord } from '@/types/eternal'

// One shared cache for the whole profile config record (`GET /api/config`).
// Every settings surface (MCP, model, config) reads and writes through this key
// so a save in one shows in the others, and revisiting a tab paints the cache
// instead of blanking on a fresh fetch.
//
// Distinct from session/hooks/use-eternal-config.ts, which is side-effecting —
// it pushes personality/cwd/voice/… into the session stores for live chat.
export const ETERNAL_CONFIG_KEY = ['eternal-config-record'] as const

// staleTime 0 → serve cache instantly, background-revalidate on every mount.
export const useEternalConfigRecord = () =>
  useQuery({ queryKey: ETERNAL_CONFIG_KEY, queryFn: getEternalConfigRecord, staleTime: 0 })

export const setEternalConfigCache = writeCache<EternalConfigRecord>(ETERNAL_CONFIG_KEY)

export const invalidateEternalConfig = () => queryClient.invalidateQueries({ queryKey: ETERNAL_CONFIG_KEY })
