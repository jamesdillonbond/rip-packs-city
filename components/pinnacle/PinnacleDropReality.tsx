// components/pinnacle/PinnacleDropReality.tsx
//
// "Did this pack pay?" on a Disney Pinnacle pack page (2026-11-23, parity pass 4): this drop's row from
// get_pinnacle_pack_reality — the retail price beside what its opened packs' pins are worth TODAY (the lifecycle
// panel above shows the value at open), the median and the share of packs worth at least the price — linking the
// full board. A "<X> Standard" sub-pool page shows its whole drop (a buyer cannot pick a pool, #157) and says so.
//
// Honest states: the read failed → a one-line "couldn't load" (never a verdict); the drop is not on the board
// (opened before Sept 2026, < 25 opens, an excluded test/chase-only pool) → renders nothing.

import Link from "next/link"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { fetchPinnacleReality, valueToPriceRatio, type PinnacleDropReality as Drop } from "@/lib/insights/pinnacle-pack-reality-board"
import { fmtBoardUsd } from "@/lib/insights/pinnacle-board-format"

/** Pure: the board row covering this dist, or null. */
export function dropForDist(drops: Drop[], distId: string): Drop | null {
  return drops.find((d) => d.dist_ids.includes(String(distId))) ?? null
}

export default async function PinnacleDropReality({ distId }: { distId: string }) {
  let drop: Drop | null = null
  try {
    const payload = await withBoardBudget(fetchPinnacleReality(), "pinnacle-pack-reality/pack-page")
    drop = dropForDist(payload.drops, distId)
  } catch {
    return (
      <p data-testid="pinnacle-drop-reality-failed" style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)", margin: 0 }}>
        Couldn&apos;t load what this drop&apos;s pulls are worth today — this says nothing about the pack.
      </p>
    )
  }
  if (!drop) return null
  const ratio = valueToPriceRatio(drop)
  const pooled = drop.dist_ids.length > 1
  return (
    <section
      data-testid="pinnacle-drop-reality"
      style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border-subtle)", borderRadius: 6, padding: "12px 16px", display: "flex", flexDirection: "column", gap: 6 }}
    >
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
        Did this pack pay?
      </span>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-secondary)", display: "flex", flexWrap: "wrap", gap: "4px 14px" }}>
        <span>Price <strong style={{ color: "var(--rpc-text-primary)" }}>{fmtBoardUsd(drop.price_usd)}</strong></span>
        <span>Pulls worth today <strong style={{ color: "var(--rpc-text-primary)" }}>{fmtBoardUsd(drop.avg_value_today)}</strong> avg · {fmtBoardUsd(drop.median_value_today)} median</span>
        {ratio != null ? <span>{ratio.toFixed(2)}× the price</span> : null}
        {drop.pct_today_at_or_above_price != null ? <span>{drop.pct_today_at_or_above_price}% of packs worth ≥ the price</span> : null}
      </div>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)" }}>
        {drop.n_today.toLocaleString("en-US")} of {drop.packs_opened.toLocaleString("en-US")} opened packs priced today
        {pooled ? ` · the whole "${drop.drop_name}" pack (${drop.dist_ids.length} pools — a buyer can't pick one)` : ""} ·{" "}
        <Link href="/insights/pinnacle-pack-reality" prefetch={false} style={{ color: "var(--rpc-red-text)", textDecoration: "none" }}>
          every Pinnacle drop →
        </Link>
      </span>
    </section>
  )
}
