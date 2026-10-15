// lib/entity/index-coverage-note.ts
//
// 2026-10-15: the Top Shot ownership index only covers the sets it was built from
// (its Dune lane is dead since 2026-09-10; the on-chain walk re-confirms rows but
// adds no new sets), so a rookie's Moments in sets minted AFTER that are not
// counted. When that happens the Top Collectors ranking is over a SUBSET of the
// player's editions — the panel says so rather than presenting partial holdings
// as the player's. Coverage comes from get_topshot_rookie_index_coverage.

import { fmtCount } from "@/components/entity/_shared"

export interface IndexCoverage {
  total_editions: number
  indexed_editions: number
}

/** The note to show under Top Collectors, or null when the index covers every edition. */
export function indexCoverageNote(cov: IndexCoverage | null, ok: boolean): string | null {
  if (!ok) return "Couldn\u2019t check whether every edition of this player is in the ownership index \u2014 newer editions may not be counted."
  if (!cov) return null
  const total = Number(cov.total_editions)
  const indexed = Number(cov.indexed_editions)
  if (!Number.isFinite(total) || !Number.isFinite(indexed) || total <= 0 || indexed >= total) return null
  return `Counts ${fmtCount(indexed)} of this player\u2019s ${fmtCount(total)} editions \u2014 editions minted after the ownership index was built are not included yet.`
}
