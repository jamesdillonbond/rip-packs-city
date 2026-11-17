// lib/pack-pull-floor.ts
//
// What a ripped pack's pull value may CLAIM. `gross_pull_value_usd` sums the
// pulls that have an FMV; when only SOME are priced it is a FLOOR, not the
// pack's value. Found 2026-09-25 (review of a2ae9b801): the page, its OG card
// and its meta description still published "PULLED $2 · −$48 vs cost · ROI
// −96%" in red for a $50 pack with 1 of 4 pulls priced — a loss the data does
// not show. One rule, shared by all three surfaces:
//   · no priced pull            → no value at all (null), never $0
//   · some pulls unpriced       → the gross is "at least"; a NEGATIVE delta /
//                                 ROI is withheld (the unpriced pulls could close
//                                 it), a POSITIVE one stands (a floor above cost
//                                 is a certain gain)
//   · every pull priced         → the numbers as they are

export type PullStats = {
  gross_pull_value_usd?: number | string | null
  pull_count?: number | string | null
  pulls_with_fmv?: number | string | null
  total_cost_basis?: number | string | null
}

export type PullValueView = {
  grossUsd: number | null
  /** true when the gross sums only some of the pulls (so it is a floor) */
  partial: boolean
  pricedCount: number | null
  pullCount: number | null
  /** gross − cost, withheld when it is negative and the gross is only a floor */
  deltaUsd: number | null
  /** ROI %, withheld on the same rule */
  roiPct: number | null
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function pullValueView(stats: PullStats | null | undefined): PullValueView {
  const pullCount = num(stats?.pull_count)
  const pricedCount = num(stats?.pulls_with_fmv)
  const grossUsd = pricedCount === 0 ? null : num(stats?.gross_pull_value_usd)
  const basis = num(stats?.total_cost_basis)
  const partial = grossUsd !== null && pullCount !== null && pricedCount !== null && pricedCount < pullCount
  let deltaUsd = grossUsd !== null && basis !== null ? grossUsd - basis : null
  if (deltaUsd !== null && partial && deltaUsd < 0) deltaUsd = null
  const roiPct = deltaUsd !== null && basis !== null && basis !== 0 ? (deltaUsd / basis) * 100 : null
  return { grossUsd, partial, pricedCount, pullCount, deltaUsd, roiPct }
}
