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
  let totalFmv = 0, totalBestOffer = 0, lockedFmv = 0, unlockedFmv = 0
  let lockedCount = 0, unlockedCount = 0, badgeCount = 0
  let confHigh = 0, confMedium = 0, confLow = 0, confNone = 0
  for (const row of rows) {
    const fmv = row.fmv ?? null
    const offer = row.bestOffer ?? null
    const locked = getLocked(row)
    if (typeof fmv === "number") totalFmv += fmv
    if (typeof offer === "number") totalBestOffer += offer
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
