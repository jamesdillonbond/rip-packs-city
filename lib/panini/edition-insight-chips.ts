// lib/panini/edition-insight-chips.ts
//
// Panini edition → insights links (Panini parity pass, 2026-11-23). Top Shot edition pages carry "Featured in
// Insights" chips; All Day, Candy and Pinnacle got theirs; Panini edition pages had none, although four Panini
// boards hold per-edition rows. Each chip is shown ONLY when its fact is true of THIS edition and states it:
//   · deal     — on the public Below FMV board's Panini leg (mv_panini_public_deals) → /insights/deals
//   · sealed   — copies still in unopened packs on the WC Prizm squeeze board (panini_squeeze_board; a floor, so
//                the chip says "at least") → /insights/panini-squeeze
//   · mover    — the lowest confirmed ask moved ≥ 10 % over the board's complete 7-day window
//                (mv_panini_floor_movers, window_complete only) → the Floor movers tab
//   · bid      — the best offer on the floor copy as a share of its ask (mv_panini_offer_spread) → Bid vs Floor tab
// Each read is one primary-key lookup; a read that failed earns no chip — a chip is a claim, never a guess.
// No FMV confidence (internal only, 10-18).

import { supabaseAdmin } from "@/lib/supabase"
import { boundedRead } from "@/lib/api/bounded-read"

export interface PaniniChipFacts {
  /**
   * % the board's ask sits under the edition's 30-day recent-sales median, for an edition on the public deals board;
   * null = not on it, no median, or the read failed. ⚠ Deliberately NOT the board's "% below FMV": since 11-12 the
   * edition page's FMV is capped at the live ask (fmv_snapshots_cap_panini_low_to_live_ask), and the deal ask IS that
   * ask — so a "% below FMV" chip would contradict the FMV printed above it on the same page (2026-11-23).
   */
  dealPct: number | null
  /** Copies still sealed (a floor); null = not on the squeeze board, or the read failed. */
  stillInPacks: number | null
  /** Floor change over a COMPLETE 7-day window, in %; null = no row, an incomplete window, or a failed read. */
  floorChangePct: number | null
  /** Best offer on the floor copy as a % of its ask; null = no row or a failed read. */
  bidPctOfAsk: number | null
}

export interface PaniniInsightChip {
  key: "deal" | "sealed" | "mover" | "bid"
  href: string
  label: string
}

export const FLOOR_MOVE_MIN_PCT = 10

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Pure: % an ask sits under a recent-sales median; null unless both are known and the ask is under it. */
export function belowRecentSalesPct(ask: number | null, median: number | null): number | null {
  if (ask == null || median == null || !(median > 0) || !(ask > 0) || ask >= median) return null
  return Math.round(((median - ask) / median) * 1000) / 10
}

/** Pure: which chips this edition earns. */
export function paniniInsightChips(f: PaniniChipFacts): PaniniInsightChip[] {
  const out: PaniniInsightChip[] = []
  if (f.dealPct != null && f.dealPct > 0) {
    out.push({ key: "deal", href: "/insights/deals", label: `${Math.round(f.dealPct)}% under recent sales →` })
  }
  if (f.stillInPacks != null && f.stillInPacks > 0) {
    out.push({ key: "sealed", href: "/insights/panini-squeeze", label: `At least ${f.stillInPacks.toLocaleString("en-US")} still sealed in packs →` })
  }
  if (f.floorChangePct != null && Math.abs(f.floorChangePct) >= FLOOR_MOVE_MIN_PCT) {
    const pct = Math.round(f.floorChangePct)
    // A rise of 100 %+ reads as a multiple (a $5 floor relisted at $25,000 is "5,000×", not "+499,900 %").
    const label = pct >= 100
      ? `Floor ${(1 + f.floorChangePct / 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}× in 7 days →`
      : `Floor ${pct > 0 ? "up" : "down"} ${Math.abs(pct)}% in 7 days →`
    out.push({ key: "mover", href: "/insights/panini-squeeze?tab=movers", label })
  }
  if (f.bidPctOfAsk != null && f.bidPctOfAsk > 0) {
    out.push({ key: "bid", href: "/insights/panini-squeeze?tab=spread", label: `Top bid ${Math.round(f.bidPctOfAsk)}% of the floor ask →` })
  }
  return out
}

type Read = { data: unknown; error: unknown }

async function one(q: PromiseLike<Read>, label: string): Promise<Record<string, unknown> | null> {
  try {
    const { data, error } = await boundedRead(q as Promise<Read>, label, 3_000)
    if (error) return null
    const r = Array.isArray(data) ? data[0] : null
    return (r as Record<string, unknown>) ?? null
  } catch {
    return null
  }
}

export async function fetchPaniniChipFacts(
  externalId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
): Promise<PaniniChipFacts> {
  const [deal, sq, mv, sp] = await Promise.all([
    one(db.from("mv_panini_public_deals").select("low_ask, recent_sales_median_usd").eq("external_id", externalId).limit(1), "panini-chip/deals"),
    one(db.from("panini_squeeze_board").select("still_in_packs").eq("external_id", externalId).limit(1), "panini-chip/squeeze"),
    one(db.from("mv_panini_floor_movers").select("change_pct, window_complete").eq("external_id", externalId).limit(1), "panini-chip/movers"),
    one(db.from("mv_panini_offer_spread").select("offer_pct_of_ask").eq("external_id", externalId).limit(1), "panini-chip/spread"),
  ])
  return {
    dealPct: belowRecentSalesPct(num(deal?.low_ask), num(deal?.recent_sales_median_usd)),
    stillInPacks: num(sq?.still_in_packs),
    floorChangePct: mv && mv.window_complete === true ? num(mv.change_pct) : null,
    bidPctOfAsk: num(sp?.offer_pct_of_ask),
  }
}
