// lib/fmv/edition-estimate.ts
//
// A SEPARATE, LABELLED VALUE ESTIMATE for thin Top Shot parallels (Trevor,
// 2026-09-30; collector request #10142 on 09-29). It is NOT an FMV and must
// never be read as one.
//
// WHY IT EXISTS. A /10 parallel that last traded months ago has an FMV built
// from its own few old sales — for the Ausar Thompson Metallic Gold Jukebox
// that is $45 from 8 sales in Mar–May, every one to the SAME buyer (the
// collector who asked), i.e. their own cost basis. A longer lookback cannot fix
// that. What can say something is the edition's FULL edition, which still
// trades: base FMV × the typical premium that parallel type carries over its
// base, measured across hundreds of editions (Jukebox RARE ≈ 4.0× over 491).
//
// WHERE IT MAY APPEAR, and where it may NOT (accuracy is the gate — roadmap
// 2026-08-03): written only to public.edition_fmv_estimates by
// refresh_edition_fmv_estimates(), never to fmv_snapshots / edition_fmv_current,
// so it cannot reach the HIGH/MEDIUM share, portfolio totals, the deals / sniper
// / squeeze boards, or alerts. Surfaced on the edition page and by the
// concierge's get_fmv — each time WITH its basis stated, as an estimate.
//
// THREE STATES. `ok:false` (read failed) and `ok:true, estimate:null` (no
// estimate for this edition) both render NOTHING — an estimate is supplementary,
// and its absence claims nothing about the edition. That is why `ok` is carried
// but the page gates only on `estimate != null`.

import { supabaseAdmin } from "@/lib/supabase"
import { boundedRead } from "@/lib/api/bounded-read"

export interface EditionFmvEstimate {
  edition_id: string
  estimate_usd: number
  range_low_usd: number | null
  range_high_usd: number | null
  basis: "parallel_ratio"
  base_edition_id: string
  base_fmv_usd: number
  ratio: number
  subedition_name: string
  tier: string | null
  cell_n: number
  capped_at_ask: boolean
  computed_at: string
}

const COLUMNS =
  "edition_id, estimate_usd, range_low_usd, range_high_usd, basis, base_edition_id, base_fmv_usd, ratio, subedition_name, tier, cell_n, capped_at_ask, computed_at"

/**
 * An estimate older than this is not shown — the base FMV it multiplies has
 * moved on. The refresh is daily, so this tolerates exactly one missed run.
 */
export const ESTIMATE_MAX_AGE_HOURS = 48

/**
 * Below this an estimate is not worth a card: a "$0.22" guess for a common
 * parallel informs no decision and dilutes the ones that do (Trevor, 09-30).
 */
export const ESTIMATE_MIN_USD = 1

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v
  return typeof n === "number" && Number.isFinite(n) ? n : null
}

/**
 * Coerce a DB row (numerics may arrive as strings) into an estimate, or null
 * when any field the display depends on is missing or not positive. A
 * half-formed row is dropped rather than rendered.
 */
export function parseEstimateRow(row: unknown, now: number = Date.now()): EditionFmvEstimate | null {
  if (!row || typeof row !== "object") return null
  const r = row as Record<string, unknown>
  const estimate = num(r.estimate_usd)
  const base = num(r.base_fmv_usd)
  const ratio = num(r.ratio)
  const cellN = num(r.cell_n)
  const computedAt = typeof r.computed_at === "string" ? r.computed_at : null
  if (estimate == null || estimate < ESTIMATE_MIN_USD || base == null || base <= 0 || ratio == null || ratio <= 0) return null
  if (cellN == null || cellN <= 0 || r.basis !== "parallel_ratio") return null
  if (typeof r.edition_id !== "string" || typeof r.base_edition_id !== "string") return null
  if (typeof r.subedition_name !== "string" || !r.subedition_name.trim()) return null
  if (!computedAt) return null
  const age = now - Date.parse(computedAt)
  if (!Number.isFinite(age) || age > ESTIMATE_MAX_AGE_HOURS * 3_600_000) return null
  let lo = num(r.range_low_usd)
  let hi = num(r.range_high_usd)
  // A range must bracket the estimate; anything else is dropped, not "fixed".
  if (lo == null || hi == null || lo <= 0 || hi < lo || estimate < lo || estimate > hi) {
    lo = null
    hi = null
  }
  return {
    edition_id: r.edition_id,
    estimate_usd: estimate,
    range_low_usd: lo,
    range_high_usd: hi,
    basis: "parallel_ratio",
    base_edition_id: r.base_edition_id,
    base_fmv_usd: base,
    ratio,
    subedition_name: r.subedition_name.trim(),
    tier: typeof r.tier === "string" ? r.tier : null,
    cell_n: cellN,
    capped_at_ask: r.capped_at_ask === true,
    computed_at: computedAt,
  }
}

/** The basis sentence, in plain words — shown every time the number is. */
export function estimateBasisText(e: EditionFmvEstimate, fmt: (n: number) => string): string {
  const ratio = e.ratio >= 10 ? e.ratio.toFixed(0) : e.ratio.toFixed(1)
  const parts = [
    `full-edition FMV ${fmt(e.base_fmv_usd)} × the typical ${e.subedition_name} premium (${ratio}×, measured across ${e.cell_n.toLocaleString("en-US")} editions)`,
  ]
  if (e.capped_at_ask) parts.push("capped at the lowest ask")
  return parts.join(", ")
}

export async function fetchEditionFmvEstimate(
  editionId: string | null | undefined,
): Promise<{ estimate: EditionFmvEstimate | null; ok: boolean }> {
  if (!editionId) return { estimate: null, ok: true }
  try {
    const { data, error } = await boundedRead(
      supabaseAdmin.from("edition_fmv_estimates").select(COLUMNS).eq("edition_id", editionId).maybeSingle(),
      "edition/fmv-estimate",
      3_000,
    )
    if (error) {
      console.warn("[edition/fmv-estimate] read failed; estimate not shown:", error.message)
      return { estimate: null, ok: false }
    }
    return { estimate: parseEstimateRow(data), ok: true }
  } catch (e) {
    console.warn("[edition/fmv-estimate] read threw; estimate not shown:", e instanceof Error ? e.message : String(e))
    return { estimate: null, ok: false }
  }
}

/**
 * The concierge's view of an estimate (get_fmv, single edition). Carries its
 * own instruction so the model states the basis and never calls it the FMV.
 */
export function estimateForModel(e: EditionFmvEstimate): Record<string, unknown> {
  return {
    estimate_usd: e.estimate_usd,
    likely_range_usd: e.range_low_usd != null && e.range_high_usd != null ? [e.range_low_usd, e.range_high_usd] : null,
    basis: "full_edition_fmv_x_typical_parallel_premium",
    full_edition_fmv_usd: e.base_fmv_usd,
    parallel_type: e.subedition_name,
    typical_premium_x: e.ratio,
    premium_measured_across_editions: e.cell_n,
    capped_at_lowest_ask: e.capped_at_ask,
    computed_at: e.computed_at,
    how_to_use:
      "This is a VALUE ESTIMATE, not the FMV. This parallel rarely trades, so its own FMV rests on few or old sales. " +
      "Quote it as 'estimated ~$X (likely $L–$H)', state the basis (full-edition FMV × the typical premium for this parallel type), " +
      "and keep it separate from the FMV figure. Never call it the FMV or a market price.",
  }
}
