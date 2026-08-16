// lib/sniper/listing-suggestions.ts
//
// "Which of MY Moments are currently listed by someone else ABOVE my FMV?" —
// the Listing Suggestions panel on the sniper page.
//
// ⚠ WHY THIS IS IN lib/. It lived inline in a 1,790-line `"use client"`
// page.tsx measured by neither coverage gate, and its empty state is not an
// empty state at all — it is a CONCLUSION:
//
//     "No listing suggestions found. Your moments are priced at or below
//      current market asks."
//
// Three separate failure paths produced that sentence: a non-2xx snapshot read
// (`r.ok ? r.json() : null`), a thrown fetch, and the deals feed not having
// loaded. So a collector could be told a specific analytical fact about their
// own portfolio that we never computed — and it is actionable in the direction
// of INACTION, telling them not to re-list.
//
// The comparison itself is pure, so extracting it makes the arithmetic testable
// and leaves the page holding only the three states.

import type { SniperDeal } from "@/lib/sniper/types"

/** A Moment from `/api/collection-snapshot`'s `topMoments`. */
export interface OwnedMoment {
  editionKey?: string | null
  playerName?: string | null
  serialNumber?: number | null
  fmv?: number | null
}

export interface ListingSuggestion {
  player: string
  serial: number
  /** How far above the owner's FMV the live ask sits, in whole percent. */
  pctAbove: number
}

/** Rows shown in the panel. */
export const SUGGESTION_LIMIT = 10

/**
 * Rank the owner's Moments whose edition is currently listed above their FMV.
 *
 * ⚠ Strictly `askPrice > fmv`: an ask AT the owner's FMV is not a suggestion to
 * list, and including it would pad the panel with rows carrying `pctAbove: 0` —
 * a "suggestion" with no upside, which is the panel making work for the reader.
 *
 * ⚠ A Moment with no FMV is SKIPPED rather than treated as zero. `fmv = 0`
 * would divide by zero and, before that, make every ask look infinitely above
 * it — so an unpriced Moment would top the list precisely because we know
 * nothing about it.
 */
export function buildListingSuggestions(
  ownedMoments: readonly OwnedMoment[],
  deals: readonly SniperDeal[],
): ListingSuggestion[] {
  const dealByEdition = new Map<string, SniperDeal>()
  for (const d of deals) dealByEdition.set(d.editionKey, d)

  const out: ListingSuggestion[] = []
  for (const m of ownedMoments) {
    // ⚠ An UNKEYED Moment matches nothing, rather than looking up `""`. A feed
    // row with an empty `editionKey` would otherwise pair with every unmapped
    // Moment the snapshot returns — and unmapped Moments are not hypothetical
    // here (the Pinnacle catalog-coverage gap leaves real sales with no edition
    // id). The result would be a confident suggestion about a Moment we cannot
    // identify, priced against a listing we cannot identify either.
    const key = m.editionKey
    if (!key) continue
    const deal = dealByEdition.get(key)
    if (!deal) continue
    const fmv = m.fmv
    if (fmv == null || !(fmv > 0)) continue
    if (!(deal.askPrice > fmv)) continue
    out.push({
      player: m.playerName ?? "Unknown",
      serial: m.serialNumber ?? 0,
      pctAbove: Math.round(((deal.askPrice - fmv) / fmv) * 100),
    })
  }
  // ⚠ Sort BEFORE the slice. Slicing first publishes an arbitrary ten under a
  // heading that promises the best ones — the silently-sliced-ranking class.
  out.sort((a, b) => b.pctAbove - a.pctAbove)
  return out.slice(0, SUGGESTION_LIMIT)
}

/**
 * What the panel can honestly say.
 *
 * ⚠ Four states, and the last two are the reason this exists. `none` is a
 * CONCLUSION about the reader's pricing and may only be published when we
 * actually compared: `read-failed` means we could not fetch their collection,
 * and `no-market` means the live deals feed has not loaded, so there was
 * nothing to compare against. Collapsing either into `none` states a fact we
 * never computed.
 */
export type SuggestionsState = "ok" | "none" | "read-failed" | "no-market"

export function suggestionsState(input: {
  /** null when the snapshot read failed; an array (possibly empty) otherwise. */
  ownedMoments: readonly OwnedMoment[] | null
  /** null/undefined when the sniper feed has not loaded. */
  deals: readonly SniperDeal[] | null | undefined
  resultCount: number
}): SuggestionsState {
  if (input.ownedMoments == null) return "read-failed"
  if (input.deals == null) return "no-market"
  return input.resultCount > 0 ? "ok" : "none"
}
