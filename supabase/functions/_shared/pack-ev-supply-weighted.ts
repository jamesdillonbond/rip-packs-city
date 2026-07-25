// Shared pure logic for the SUPPLY-WEIGHTED pack-EV edge functions —
// compute-allday-pack-ev, compute-golazos-pack-ev, and compute-pinnacle-pack-ev.
//
// Dapper does NOT publish per-tier packOdds for AllDay / Golazos / Pinnacle, so
// their EV is supply-weighted: an edition's pull probability ~ its share of
// minted circulation. Three deployed edge functions carry inline copies of this
// arithmetic (AllDay + Golazos build a normalized pack_drop_pool then call the
// canonical `compute_pack_ev_per_edition_weighted` RPC; Pinnacle computes the
// weighted-mean EV inline). This module is the Deno-and-vitest-importable
// extraction so the math is pinned by unit tests and can't silently drift.
//
// Ported VERBATIM from those functions:
//   - computeDepletionPct   — all three (identical: total>0 ? min(100,round((total-available)/total*100)) : null)
//   - supplyWeightPool      — AllDay/Golazos (maxCirc normalization → (0,1] drop_weight, 6dp)
//   - weightedMeanEv        — Pinnacle inline weighted mean + round/clamp (clamp identical to the RPC)
//   - weightedMedianFmv     — Pinnacle inline "Typical Pull EV" median (identical to the RPC's med CTE)
//   - classifySupplyDist    — the shared skip classification (no editions / no fmv coverage)
//   - nextCursorFromRun     — the resolveCursor() continuation shape
//
// The deployed edge functions still carry the inline copies; rewiring them to
// import from here is a deploy-gated (Deno deploy) follow-up. Until then the
// source-drift guard in __tests__/edge-pack-ev-supply-weighted.test.ts fails CI
// if an inline copy's canonical expression is edited without mirroring it here.

/**
 * Depletion percentage of a pack distribution, identical across all three
 * supply-weighted edge functions. Returns null when total supply is unknown/0
 * (never a false 0%). Clamped to [_, 100]; a negative (available > total) is
 * possible from upstream noise and is intentionally NOT floored here to mirror
 * the inline copies exactly.
 */
export function computeDepletionPct(total: number, available: number): number | null {
  return total > 0
    ? Math.min(100, Math.round(((total - available) / total) * 100))
    : null
}

/**
 * AllDay/Golazos supply-weighting: normalize each edition's minted circulation to
 * the pool's max so drop_weight lands in (0,1] with 6dp (fits
 * pack_drop_pool.drop_weight numeric(8,6)). A missing/<=0 circulation floors to 1
 * (an edition is always pullable). The weighted-mean EV downstream is
 * scale-invariant, so only the ratios matter.
 *
 * @param circs raw circulation_count values (null/NaN tolerated) for the pool
 * @returns per-edition weights in the SAME order, each in (0,1], rounded to 6dp
 */
export function supplyWeightPool(circs: Array<number | null | undefined>): number[] {
  let maxCirc = 1
  for (const raw of circs) {
    const c = Number(raw) || 1
    if (c > maxCirc) maxCirc = c
  }
  return circs.map((raw) => {
    const c = Math.max(Number(raw) || 1, 1)
    return Math.round((c / maxCirc) * 1e6) / 1e6 // (0,1], 6dp
  })
}

// Pinnacle rounding/clamp helpers — clamp identical to the SQL
// compute_pack_ev_per_edition_weighted so the inline and RPC paths reconcile.
export function clampEv(v: number): number {
  return Math.max(Math.min(v, 1000000), -10000)
}
export function round2(v: number): number {
  return Math.round(v * 100) / 100
}
export function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

export interface WeightedEditionInput {
  /** minted circulation (weight); missing/<=0 floors to 1 */
  circ: number | null | undefined
  /** edition FMV in USD, or null when no FMV signal exists */
  fmv: number | null | undefined
}

export interface WeightedEvResult {
  grossEv: number
  packEv: number
  valueRatio: number | null
  isPositiveEv: boolean
  fmvCoveragePct: number
  editionCount: number
  editionsWithFmv: number
  /**
   * "Typical Pull EV" — slots × the supply-weighted MEDIAN edition FMV, clamped
   * [0, 1e6]. Sits near the common floor where grossEv (the weighted MEAN) is
   * pulled up by grails; the gap between them is the lottery-shape signal.
   * null only when no edition carries FMV (i.e. whenever ok=false).
   */
  typicalEv: number | null
  /** false → the pool had no editions, or no FMV coverage (caller should skip) */
  ok: boolean
}

/**
 * The supply-weighted MEDIAN FMV, byte-for-byte the semantics of the canonical
 * SQL `compute_pack_ev_per_edition_weighted` median CTE:
 *
 *   med AS (SELECT min(fmv_usd) FROM cum WHERE cw >= 0.5 * tw)
 *
 * i.e. over (fmv, weight) pairs sorted by fmv ASCENDING, return the first fmv at
 * which the cumulative weight reaches >= half the total weight. Weights are
 * always >= 1 here (a missing/<=0 circulation floors to 1), which is why the
 * SQL's `w > 0` filter has no analogue. Returns null for an empty pair list.
 */
export function weightedMedianFmv(pairs: Array<{ fmv: number; w: number }>): number | null {
  if (pairs.length === 0) return null
  const sorted = pairs.slice().sort((a, b) => a.fmv - b.fmv)
  let tw = 0
  for (const p of sorted) tw += p.w
  let cw = 0
  for (const p of sorted) {
    cw += p.w
    if (cw >= 0.5 * tw) return p.fmv
  }
  return sorted[sorted.length - 1].fmv
}

/**
 * Pinnacle's inline weighted-mean EV: mean FMV over renders WITH fmv only,
 * weighted by minted supply, × slots. Mirrors compute-pinnacle-pack-ev/index.ts
 * (weightedNum/weightedDen loop + round2/round3/clampEv). Editions with a null
 * FMV count toward editionCount (coverage denominator) but not the mean.
 *
 * ok=false when there are no editions at all, or none carry FMV — the caller
 * increments nodes_no_editions / nodes_no_fmv_coverage and skips the dist.
 */
export function weightedMeanEv(
  editions: WeightedEditionInput[],
  slots: number,
  packPrice: number,
): WeightedEvResult {
  const safeSlots = Math.max(1, slots)
  let weightedNum = 0
  let weightedDen = 0
  let editionCount = 0
  let editionsWithFmv = 0
  const fmvPairs: Array<{ fmv: number; w: number }> = []
  for (const e of editions) {
    editionCount++
    if (e.fmv == null) continue
    const w = Math.max(Number(e.circ) || 1, 1)
    weightedNum += w * e.fmv
    weightedDen += w
    editionsWithFmv++
    fmvPairs.push({ fmv: e.fmv, w })
  }

  if (editionCount === 0 || editionsWithFmv === 0 || weightedDen === 0) {
    return {
      grossEv: 0,
      packEv: 0,
      valueRatio: null,
      isPositiveEv: false,
      fmvCoveragePct: editionCount === 0 ? 0 : Math.round((100 * editionsWithFmv) / editionCount),
      editionCount,
      editionsWithFmv,
      typicalEv: null,
      ok: false,
    }
  }

  const perSlotEv = weightedNum / weightedDen
  const grossEv = clampEv(round2(perSlotEv * safeSlots))
  const packEv = clampEv(round2(grossEv - packPrice))
  const valueRatio = packPrice > 0 ? round3(grossEv / packPrice) : null
  const fmvCoveragePct = Math.round((100 * editionsWithFmv) / editionCount)

  // Typical Pull EV: slots × the supply-weighted MEDIAN moment value, clamped
  // [0, 1e6] exactly as the RPC does (GREATEST(LEAST(x, 1000000), 0)).
  const typicalPerSlot = weightedMedianFmv(fmvPairs)
  const typicalEv = typicalPerSlot != null
    ? Math.max(Math.min(round2(typicalPerSlot * safeSlots), 1000000), 0)
    : null

  return {
    grossEv,
    packEv,
    valueRatio,
    isPositiveEv: packEv > 0,
    fmvCoveragePct,
    editionCount,
    editionsWithFmv,
    typicalEv,
    ok: true,
  }
}

export type SupplyDistVerdict = "ok" | "no_editions" | "no_fmv_coverage"

/**
 * The shared per-dist skip classification used by all three functions before
 * they build a pool / EV row: a dist with zero resolvable editions is
 * `no_editions`; a dist whose resolvable editions all lack FMV is
 * `no_fmv_coverage`; otherwise `ok`. `editionCount` counts editions that
 * resolved to a catalog row; `editionsWithFmv` those that also carry an FMV.
 */
export function classifySupplyDist(editionCount: number, editionsWithFmv: number): SupplyDistVerdict {
  if (editionCount === 0) return "no_editions"
  if (editionsWithFmv === 0) return "no_fmv_coverage"
  return "ok"
}

export interface LastRunRow {
  cursor_after?: string | null
  extra?: { has_next_page?: boolean } | null
}

/**
 * The pure half of resolveCursor(): given an explicit cursor override and the
 * most-recent successful pipeline_runs row, decide the cursor to resume from.
 *   - "reset"                → null (start from the beginning)
 *   - any other non-empty    → that explicit cursor
 *   - null/empty override    → the last run's cursor_after, but ONLY when that
 *                              run reported has_next_page; otherwise null (a
 *                              completed sweep restarts from the top).
 */
export function nextCursorFromRun(explicit: string | null, lastRun: LastRunRow | null): string | null {
  if (explicit === "reset") return null
  if (explicit != null && explicit !== "") return explicit
  if (!lastRun) return null
  if (lastRun.extra?.has_next_page !== true) return null
  return lastRun.cursor_after ?? null
}
