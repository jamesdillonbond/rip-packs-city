"use client"

import type { SniperDeal } from "@/lib/sniper/types"

// Fee-net note for a sniper deal.
//
// The discount on every deal card is GROSS. The marketplace takes its cut out of
// the SELLER's proceeds, so a listing "18% below FMV" is not an 18% edge — and
// the size of the bite differs by collection (5% on the Dapper Flow
// marketplaces, 7.5% plus a $0.50 listing-fee floor on Disney Pinnacle). This
// renders the number that actually decides the buy: what you'd keep reselling at
// the serial-adjusted FMV, and that against the ask.
//
// Two deliberate restraints:
//  · Nothing renders when `netOfFees` is null. That means the collection has no
//    VERIFIED published rate, and a guessed fee on a money surface is exactly
//    the fabricated-data class this codebase keeps finding.
//  · Nothing renders on a deal that isn't a deal gross either (netMargin <= 0
//    AND discount <= 0 upstream) — the card already says that. The loud case is
//    the one this component exists for: a healthy-looking gross discount that
//    does NOT survive the fee.

export default function NetOfFeesNote({ net }: { net: SniperDeal["netOfFees"] }) {
  if (!net) return null

  const pct = `${(net.feePct * 100).toFixed(net.feePct * 100 % 1 === 0 ? 0 : 1)}%`
  const money = (n: number) => `$${Math.abs(n).toFixed(Math.abs(n) >= 100 ? 0 : 2)}`

  if (net.flipsNegative) {
    return (
      <span
        title={`After the ${pct} seller fee you'd keep ${money(net.netIfResold)} reselling at FMV — less than the ask. The discount does not survive the fee.`}
        style={{
          fontSize: "var(--text-xs)",
          fontFamily: "var(--font-mono)",
          color: "var(--rpc-warning)",
          fontWeight: 600,
          whiteSpace: "nowrap",
        }}
      >
        net −{money(net.netMarginUsd)} after {pct} fee
      </span>
    )
  }

  return (
    <span
      title={`After the ${pct} seller fee you'd keep ${money(net.netIfResold)} reselling at FMV, against the ask — a ${net.netMarginPct.toFixed(0)}% return on what you put in.`}
      style={{
        fontSize: "var(--text-xs)",
        fontFamily: "var(--font-mono)",
        color: "var(--rpc-text-muted)",
        whiteSpace: "nowrap",
      }}
    >
      net +{money(net.netMarginUsd)} after {pct} fee
    </span>
  )
}
