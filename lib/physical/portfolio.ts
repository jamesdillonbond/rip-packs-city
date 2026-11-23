/**
 * Physical holdings → a ranged total (prototype, NOT wired).
 *
 * Kept apart from the digital portfolio on purpose: a physical total is a
 * licensed RANGE credited to its source, never RPC FMV, and whether it is shown
 * next to (or summed into) the digital total is still Trevor's decision.
 *
 * A holding with no published range is counted as UNPRICED, never as $0 —
 * the timeout-renders-as-a-false-zero lesson: a missing value is not a value.
 */

export type PhysicalHolding = {
  id: string
  cardId: string
  grader: string
  grade: string
  quantity: number
  /** Total paid for this row (the whole lot), not per card — see holding-input.ts. */
  costBasisUsd: number | null
}

export type CachedRange = {
  cardId: string
  grader: string
  grade: string
  lowUsd: number | null
  pointUsd: number | null
  highUsd: number | null
  source: string
}

export type PhysicalTotal = {
  // null when NO holding is priced (2026-11-22 review): 0 there is the false zero the header
  // forbids — e.g. a failed value-cache read passed as ranges=[] would total "$0".
  low: number | null
  point: number | null
  high: number | null
  pricedCount: number
  unpricedCount: number
  unpricedIds: string[]
  costBasis: number | null // null unless every PRICED holding has one
  sources: string[]
}

const key = (cardId: string, grader: string, grade: string) => `${cardId}|${grader}|${grade}`
const r2 = (n: number) => Math.round(n * 100) / 100

export function physicalTotal(holdings: PhysicalHolding[], ranges: CachedRange[]): PhysicalTotal {
  const byKey = new Map(ranges.map((r) => [key(r.cardId, r.grader, r.grade), r]))
  let low = 0
  let point = 0
  let high = 0
  let cost = 0
  let costComplete = true
  const unpricedIds: string[] = []
  const sources = new Set<string>()
  let priced = 0

  for (const h of holdings) {
    const r = byKey.get(key(h.cardId, h.grader, h.grade))
    if (!r || r.pointUsd == null || r.lowUsd == null || r.highUsd == null) {
      unpricedIds.push(h.id)
      continue
    }
    priced++
    low += r.lowUsd * h.quantity
    point += r.pointUsd * h.quantity
    high += r.highUsd * h.quantity
    sources.add(r.source)
    if (h.costBasisUsd == null) costComplete = false
    else cost += h.costBasisUsd
  }

  return {
    low: priced > 0 ? r2(low) : null,
    point: priced > 0 ? r2(point) : null,
    high: priced > 0 ? r2(high) : null,
    pricedCount: priced,
    unpricedCount: unpricedIds.length,
    unpricedIds,
    costBasis: priced > 0 && costComplete ? r2(cost) : null,
    sources: [...sources].sort(),
  }
}
