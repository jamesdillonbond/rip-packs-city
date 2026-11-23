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
  low: number
  point: number
  high: number
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
    low: r2(low),
    point: r2(point),
    high: r2(high),
    pricedCount: priced,
    unpricedCount: unpricedIds.length,
    unpricedIds,
    costBasis: priced > 0 && costComplete ? r2(cost) : null,
    sources: [...sources].sort(),
  }
}
