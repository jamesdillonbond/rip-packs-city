// lib/collection/pinnacle-sets-callout.ts
//
// Maps /api/pinnacle-set-progress sets onto the shape the Collection tab's "Close to completing"
// callout reads (Top Shot's /api/sets shape). 2026-10-26, Disney Pinnacle ↔ Top Shot parity.
//
// ⚠ The one field that is not a rename: Top Shot reports `unpricedMissingCount`; Pinnacle reports
// how many missing slots have a live ask (`listedCount`). Left unmapped, a set with unpriced slots
// would show its partial cost as the whole ("· $4.00" for a set that is "≥ $4.00 (2 unpriced)").
// When the floor map was stale the route sends `totalMissingCost: null`, which the label already
// renders as "unpriced".

import { fetchJson } from "@/lib/analytics/fetch-json"

export interface PinnacleSetProgress {
  setId?: string | null
  setName?: string | null
  missingCount?: number | null
  completionPct?: number | null
  listedCount?: number | null
  totalMissingCost?: number | null
  asksEnriched?: boolean | null
}

export interface CalloutSet {
  setId: string | null
  setName: string
  missingCount: number
  completionPct: number
  totalMissingCost: number | null
  unpricedMissingCount: number
}

export function pinnacleSetsForCallout(sets: PinnacleSetProgress[]): CalloutSet[] {
  return sets
    .filter((s) => s && typeof s.setName === "string" && s.setName.trim() !== "")
    .map((s) => {
      const missing = Number(s.missingCount ?? 0)
      const listed = Number(s.listedCount ?? 0)
      return {
        setId: s.setId ?? null,
        setName: String(s.setName).trim(),
        missingCount: missing,
        completionPct: Number(s.completionPct ?? 0),
        totalMissingCost: s.totalMissingCost == null ? null : Number(s.totalMissingCost),
        unpricedMissingCount: Math.max(0, missing - listed),
      }
    })
}

/**
 * Load the callout's sets for a wallet. Returns null when the read FAILED (no callout — the callout
 * makes no claim when absent) and `{ sets: [] }` only when the read succeeded with no sets; it never
 * turns a failure into "nothing close to complete".
 */
export async function loadPinnacleCalloutSets(
  wallet: string,
  fetcher: typeof fetchJson = fetchJson,
): Promise<{ sets: CalloutSet[] } | null> {
  const r = await fetcher<{ sets?: unknown }>("/api/pinnacle-set-progress?wallet=" + encodeURIComponent(wallet))
  if (!r.ok || !r.json || !Array.isArray(r.json.sets)) return null
  return { sets: pinnacleSetsForCallout(r.json.sets as PinnacleSetProgress[]) }
}
