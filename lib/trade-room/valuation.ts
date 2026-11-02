// lib/trade-room/valuation.ts
//
// The fair-trade hint for a trade room, pure. Each side's total is the sum of RPC's
// FMV over the moments it gives — counting ONLY the moments that carried a
// confident price when they were added (trade_room_items.fmv_usd is NULL otherwise).
// A moment without one is reported as "not priced", never as $0, and a side with any
// unpriced moment never gets a confident total: the hint says what it could not
// price instead of pretending. The confidence tier itself is never exposed
// (FMV confidence is internal, 2026-10-18).

import { usdSignFirst } from "@/lib/usd-format"

/** Matches MAX_SWAP_SIDE in lib/swap-test/swap-cadence.ts (the transaction asserts it). Pure, so client code may import it. */
export const MAX_ITEMS_PER_SIDE = 10

export interface ValuedItem {
  moment_id: string
  /** RPC FMV at add time; null when it was not confidently priced. */
  fmv_usd: number | null
}

export interface SideValuation {
  /** Moments given by this side. */
  count: number
  /** Moments with a confident FMV. */
  priced: number
  /** Moments without one. */
  unpriced: number
  /** Sum of the priced moments' FMV, to the cent; null when nothing is priced. */
  priced_total_usd: number | null
  /** True only when every moment the side gives is priced. */
  complete: boolean
}

export interface TradeValuation {
  a: SideValuation
  b: SideValuation
  /**
   * Side A's total minus side B's, when BOTH sides are complete (every moment
   * priced) and at least one side gives something. Null otherwise: a difference
   * over an incomplete side would be a claim about moments nobody priced.
   */
  difference_usd: number | null
  /** One line for the panel, always set. */
  summary: string
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function valueSide(items: readonly ValuedItem[]): SideValuation {
  const priced = items.filter((i) => typeof i.fmv_usd === "number" && Number.isFinite(i.fmv_usd) && i.fmv_usd >= 0)
  const total = priced.reduce((s, i) => s + (i.fmv_usd as number), 0)
  return {
    count: items.length,
    priced: priced.length,
    unpriced: items.length - priced.length,
    priced_total_usd: priced.length ? round2(total) : null,
    complete: items.length > 0 && priced.length === items.length,
  }
}

export function fmtUsd(n: number): string {
  const neg = usdSignFirst(n, fmtUsd)
  if (neg !== null) return neg
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function valueTrade(a: readonly ValuedItem[], b: readonly ValuedItem[]): TradeValuation {
  const va = valueSide(a)
  const vb = valueSide(b)
  const bothEmpty = va.count === 0 && vb.count === 0
  const unpriced = va.unpriced + vb.unpriced
  let difference: number | null = null
  let summary: string
  if (bothEmpty) {
    summary = "Nothing on either side yet."
  } else if (unpriced > 0) {
    // an incomplete side gets no verdict; the panel still shows each side's priced total
    summary = `${unpriced} Moment${unpriced === 1 ? "" : "s"} not priced (not enough sales), so there is no fair-value verdict.`
  } else {
    // every moment on both sides priced (an empty side is complete at $0 by construction)
    const ta = va.priced_total_usd ?? 0
    const tb = vb.priced_total_usd ?? 0
    difference = round2(ta - tb)
    if (Math.abs(difference) < 0.005) summary = "Even by RPC's FMV."
    else if (difference > 0) summary = `Side A gives ${fmtUsd(difference)} more by RPC's FMV.`
    else summary = `Side B gives ${fmtUsd(-difference)} more by RPC's FMV.`
  }
  return { a: va, b: vb, difference_usd: difference, summary }
}

/** Shown before anyone accepts; the cost of withdrawing from a Dapper account. */
export const WITHDRAWAL_NOTICE =
  "A Moment that leaves a Dapper account stops counting toward that account's score, sets and challenges on Top Shot, All Day or Golazos. Both sides sign one transaction: either every Moment moves, or nothing does. RPC never holds a Moment or a key, charges no fee, and cannot reverse a sealed trade."
