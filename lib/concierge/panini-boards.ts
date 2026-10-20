// lib/concierge/panini-boards.ts
//
// The concierge's reads of two Panini boards it could not reach before 2026-10-19:
//   · the Panini PACK MARKET (/api/panini-pack-market, the Packs tab's backend) — 351 packs,
//     a few dozen modelled. The route's payload is far too large to forward whole (500 history
//     rows), so it is trimmed here to one compact row per pack.
//   · the Panini PREMIUMS boards (/insights/panini-premiums, lib/insights/panini-premiums.ts).
//
// ── HONESTY ────────────────────────────────────────────────────────────────
//   · A failed read is an ERROR payload, never an empty board (three states: failed · empty · rows).
//   · A pack's EV is a model over a LISTING-GATED index, and its mean is carried by a few chase
//     cards (the 10-18 re-measure: four LOW chase editions add ~$33/pack). So every row carries a
//     `rip_verdict` computed HERE, and the model is told to quote it: a positive mean edge whose
//     typical pull (or simulated median pack) is under cost is `positive_on_mean_only`, never "+EV".
//     Only `typical_pack_beats_cost` (simulated P(pull ≥ cost) ≥ 50 %) may be described as a
//     pack that usually pays — the same gate the Packs tab applies (panini.md Next 4).
//   · FMV CONFIDENCE IS INTERNAL (CLAUDE.md concierge rule 3): the premiums rows drop the
//     *_confidence fields before they reach the model.

import { fetchPaniniPremiums } from "@/lib/insights/panini-premiums"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

/** At or above this simulated P(pull ≥ cost) a pack may be called one that usually pays. */
export const PANINI_PACK_TYPICAL_BEATS_COST = 0.5

export type PaniniRipVerdict =
  | "not_modeled"
  | "no_price"
  | "no_edge"
  | "positive_on_mean_only"
  | "typical_pack_beats_cost"

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Classify one pack-market product. Exported for the test. */
export function paniniRipVerdict(p: {
  evModeled?: unknown
  costUsd?: unknown
  netRipEdgeUsd?: unknown
  typicalEvUsd?: unknown
  sim?: { pBeatCost?: unknown } | null
}): PaniniRipVerdict {
  if (p.evModeled !== true) return "not_modeled"
  const cost = num(p.costUsd)
  const edge = num(p.netRipEdgeUsd)
  if (cost === null || edge === null) return "no_price"
  const pBeat = num(p.sim?.pBeatCost)
  if (pBeat !== null && pBeat >= PANINI_PACK_TYPICAL_BEATS_COST) return "typical_pack_beats_cost"
  if (edge <= 0) return "no_edge"
  // A positive mean edge. Without a simulation, the typical pull stands in for the median pack;
  // with neither, the edge is still only a mean.
  const typical = num(p.typicalEvUsd)
  if (pBeat === null && typical !== null && typical >= cost) return "typical_pack_beats_cost"
  return "positive_on_mean_only"
}

export async function readPaniniPackMarketForConcierge(base: string, limit: number): Promise<string> {
  try {
    const res = await fetch(`${base}/api/panini-pack-market`, { signal: AbortSignal.timeout(9000) })
    if (!res.ok) {
      return JSON.stringify({
        status: "error",
        http_status: res.status,
        message: "The Panini pack market read failed — say the check failed; do NOT say there are no packs.",
      })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json()
    if (!Array.isArray(json?.products)) {
      return JSON.stringify({ status: "error", message: "The Panini pack market returned an unreadable payload — say the check failed." })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = json.products as any[]
    // The route sorts modelled packs first; keep that order so a short limit shows the priced ones.
    const rows = all.slice(0, limit).map((p) => {
      const verdict = paniniRipVerdict(p)
      const modeled = p.evModeled === true
      return {
        pack: p.name ?? p.label ?? p.id,
        product: p.productName ?? null,
        sport: p.sport ?? null,
        pack_type: p.packType ?? null,
        cost_usd: num(p.costUsd),
        // floor = a live lowest ask; avg_sale = an average sale (not buyable at); primary = Panini's drop price.
        cost_basis: p.costBasis ?? null,
        packs_remaining: num(p.packsRemaining),
        ev_modeled: modeled,
        typical_pull_usd: modeled ? num(p.typicalEvUsd) : null,
        mean_ev_usd: modeled ? num(p.actualEvUsd) : null,
        net_edge_on_mean_usd: modeled ? num(p.netRipEdgeUsd) : null,
        simulated_median_pack_usd: num(p.sim?.medianPullUsd),
        simulated_p_pull_beats_cost: num(p.sim?.pBeatCost),
        rip_verdict: verdict,
        model_note: p.modelNote ?? null,
        stats_updated_at: p.updatedAt ?? null,
        stats_stale: p.stale === true,
      }
    })
    return JSON.stringify({
      status: "ok",
      board_url: `${base}/panini-blockchain/packs`,
      total_packs: all.length,
      modeled_packs: all.filter((p) => p.evModeled === true).length,
      count: rows.length,
      rows,
      coverage_note:
        "Pack EV is modelled over a listing-fed index (Panini publishes no checklist), so it is a floor, not a census. " +
        "Lead with the typical pull / simulated median pack; the mean is carried by a few chase cards. " +
        "rip_verdict is authoritative: never call a pack +EV, profitable or worth ripping unless it reads typical_pack_beats_cost; " +
        "positive_on_mean_only means most packs return less than they cost. ev_modeled=false means NOT MODELLED — never $0. " +
        "A stats_stale price is older than 24 h — say so when you quote it.",
      coverage: json.coverage ?? null,
      coverage_error: json.coverage_error === true,
    })
  } catch {
    return JSON.stringify({ status: "error", message: "The Panini pack market read failed — say the check failed; do NOT say there are no packs." })
  }
}

export async function readPaniniPremiumsForConcierge(db: Db, base: string, limit: number): Promise<string> {
  try {
    const board = await fetchPaniniPremiums(db)
    return JSON.stringify({
      status: "ok",
      board_url: `${base}/insights/panini-premiums`,
      parallels: board.parallels.slice(0, limit).map((r) => ({
        player: r.player_name,
        product: r.product_name,
        sport: r.sport,
        parallel: r.parallel,
        mint_cap: r.mint_cap,
        parallel_fmv_usd: r.parallel_fmv_usd,
        base_parallel: r.base_parallel,
        base_mint_cap: r.base_mint_cap,
        base_fmv_usd: r.base_fmv_usd,
        premium_mult: r.premium_mult,
        edition_url: `${base}/panini-blockchain/edition/${encodeURIComponent(r.external_id)}`,
      })),
      parallels_total: board.parallels.length,
      parallels_capped: board.parallelsCapped,
      serials: board.serials.slice(0, limit).map((r) => ({
        player: r.player_name,
        product: r.product_name,
        sport: r.sport,
        parallel: r.parallel,
        serial_number: r.serial_number,
        mint_cap: r.mint_cap,
        sale_usd: r.sale_usd,
        sold_at: r.sold_at,
        edition_median_usd: r.edition_median_usd,
        edition_sales_n: r.edition_sales_n,
        premium_mult: r.premium_mult,
        edition_url: `${base}/panini-blockchain/edition/${encodeURIComponent(r.external_id)}`,
      })),
      serials_total: board.serials.length,
      serials_capped: board.serialsCapped,
      note:
        "parallels: a numbered parallel's FMV over the same player's most common base parallel in the same product (only well-supported prices, premium ≥ 1.5×). " +
        "serials: real sales of an edition's #1 or perfect-mint serial at ≥ 2× the median of its other 90-day sales. Listing-fed index — a floor, not a census.",
    })
  } catch {
    return JSON.stringify({ status: "error", message: "The Panini premiums read failed — say the check failed; do NOT say there are no premiums." })
  }
}
