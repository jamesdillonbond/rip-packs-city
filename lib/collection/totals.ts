// lib/collection/totals.ts
//
// Pure portfolio-totals aggregation for the collection page's stat row.
// Extracted verbatim from app/(collections)/[collection]/collection/page.tsx's
// `totals` useMemo (monolith Phase-2 slice) so the value/lock/confidence rollup
// is a standalone, unit-tested surface. Pure reduce over the already-filtered
// rows — no view/context state.

import { getLocked, getBestAsk } from "@/lib/collection/helpers"
import type { MomentRow } from "@/lib/collection/types"

export interface CollectionTotals {
  totalFmv: number
  totalBestOffer: number
  /** Rows carrying a best offer, and the FMV of exactly those rows (2026-11-14). */
  offerCount: number
  fmvWithOffer: number
  /** The offers on rows that also carry an FMV — the like-for-like side of fmvWithOffer. */
  pairedOffer: number
  lockedFmv: number
  unlockedFmv: number
  totalCount: number
  lockedCount: number
  unlockedCount: number
  spreadGap: number
  badgeCount: number
  confHigh: number
  confMedium: number
  confLow: number
  confNone: number
}

// Sum FMV / best-offer, split value (fmv → offer → best-ask → 0) by lock state,
// and bucket rows by market-confidence. Behaviour is identical to the former
// inline reducer.
export function computeCollectionTotals(rows: MomentRow[]): CollectionTotals {
  let offerCount = 0, fmvWithOffer = 0, pairedOffer = 0
  // 2026-11-14: an EDITION-level bid is ONE bid — it fills once, whatever number of copies the
  // wallet holds. Counting it per copy made the total a sum no buyer would pay (a founder wallet
  // holds 445 multi-copy editions, up to 132 of one: ~$5.9k of phantom bids). Each edition's
  // bid is counted on its first row only; a SERIAL-level offer targets that moment and counts.
  const editionBidSeen = new Set<string>()
  let totalFmv = 0, totalBestOffer = 0, lockedFmv = 0, unlockedFmv = 0
  let lockedCount = 0, unlockedCount = 0, badgeCount = 0
  let confHigh = 0, confMedium = 0, confLow = 0, confNone = 0
  for (const row of rows) {
    const fmv = row.fmv ?? null
    const offer = row.bestOffer ?? null
    const locked = getLocked(row)
    if (typeof fmv === "number") totalFmv += fmv
    let countedOffer: number | null = offer
    if (typeof offer === "number" && row.bestOfferType !== "serial" && row.editionKey) {
      if (editionBidSeen.has(row.editionKey)) countedOffer = null
      else editionBidSeen.add(row.editionKey)
    }
    if (typeof countedOffer === "number") {
      const offer = countedOffer
      totalBestOffer += offer
      offerCount++
      if (typeof fmv === "number") { fmvWithOffer += fmv; pairedOffer += offer }
    }
    const value = fmv ?? offer ?? getBestAsk(row) ?? 0
    if (locked) { lockedFmv += value; lockedCount++ } else { unlockedFmv += value; unlockedCount++ }
    if (row.badgeInfo?.badge_score) badgeCount++
    switch (row.marketConfidence) {
      case "high": confHigh++; break
      case "medium": confMedium++; break
      case "low": confLow++; break
      default: confNone++; break
    }
  }
  return {
    totalFmv,
    totalBestOffer,
    offerCount,
    fmvWithOffer,
    pairedOffer,
    lockedFmv,
    unlockedFmv,
    totalCount: rows.length,
    lockedCount,
    unlockedCount,
    spreadGap: totalFmv - totalBestOffer,
    badgeCount,
    confHigh,
    confMedium,
    confLow,
    confNone,
  }
}
