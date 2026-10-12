// lib/fmv-accuracy/fetchers.ts
//
// The ACCURACY GATE, read for publication on /legal/fmv-methodology#accuracy.
//
// WHY THIS FILE EXISTS. The roadmap (docs/strategy/roadmap-2026-08-03.md) makes
// the share of prices at HIGH/MEDIUM confidence the headline metric — "accuracy
// is the gate, not a phase" — and until 2026-10-11 that figure was public
// nowhere: it lived only in `public.rpc_trust_health_precompute`, with zero
// readers in any .tsx (platform review, M4). This module reads it for the
// methodology page, so the gate itself is published, per collection, with its
// as-of time.
//
// WHAT IS READ, AND WHAT IS NOT.
//   * The documented source is the precompute's `<collection>_fmv_high_med_share_pct`
//     rows, written by `rpc_thp_leg_fmv_coverage` (five shared collections, one
//     DISTINCT ON pass over fmv_snapshots, ~6-hourly) and by
//     `rpc_thp_leg_pinnacle_fmv_share` (Pinnacle — a DIFFERENT table, key and
//     column: pinnacle_fmv_history per render_id). roadmap-status.md is explicit:
//     read the precompute, never call `rpc_fmv_confidence_share()` (it blows a 60 s
//     budget on the live instance). This reads ONE small table, by metric name.
//   * The precompute carries NO per-collection "priced editions" count, and
//     pairing a count from another table (edition_fmv_current) with a share from
//     this one is the "never pair a count from one table with a property from
//     another" rule in CLAUDE.md — the two populations differ (latest snapshot
//     per edition vs the current-price table). So the table publishes the SHARE
//     and its as-of, and not a denominator it cannot source from the same pass.
//   * Panini has no `panini_fmv_high_med_share_pct` row (roadmap-status.md,
//     2026-09-20: "no owner in the trust-health precompute"), so it is not listed
//     rather than shown as "unavailable" forever — the component says so.
//
// THE SENTINELS, verbatim from the leg's contract (migration 20260910230812):
//     0..100  a real percentage
//     -1      UNDEFINED — no editions in the window, so the share has no denominator
//     999     the leg THREW (pre-existing failure sentinel)
// Both sentinels render as "unavailable". A -1 or a 999 rendered as a number is
// the fabricated-value shape this platform is built around refusing; so is a 0 %
// produced by a failed read. Hence `shareLabel` returns a LABEL, never a decimal:
// whole percents, "<1%" below one (a label beats a decimal — roadmap §3.1), and
// "unavailable" for anything that is not a measurement.
//
// THREE STATES at the table level, not two:
//   ok:false            the READ failed → every cell "unavailable" + a notice
//   ok:true, row absent the read worked and the precompute holds no row → "unavailable"
//   ok:true, row present a measurement (or a sentinel, which is still "unavailable")
//
// `db` is injectable (defaults to supabaseAdmin) so every branch is testable
// without a database — the same shape lib/pack-dist/fetchers.ts uses. This file
// is the ONLY place the methodology page touches a client, so the page itself
// stays out of the server-page data-access ratchet.

import { supabaseAdmin } from "@/lib/supabase"
import { getCollection } from "@/lib/collections"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"

/** The leg's failure sentinel: the leg threw. NOT a percentage. */
export const LEG_FAILED_SENTINEL = 999
/** The leg's undefined sentinel: no denominator. NOT a percentage. */
export const NO_DENOMINATOR_SENTINEL = -1

/** After this, a reading is shown with a "stale" mark beside its as-of. */
export const ACCURACY_STALE_AFTER_MS = 48 * 60 * 60 * 1000

/**
 * metric prefix in the precompute → registry collection id. Order is display
 * order. Panini is deliberately absent (no metric row exists — see header).
 */
export const ACCURACY_METRIC_COLLECTIONS: ReadonlyArray<{ prefix: string; collectionId: string }> = [
  { prefix: "topshot", collectionId: "nba-top-shot" },
  { prefix: "allday", collectionId: "nfl-all-day" },
  { prefix: "pinnacle", collectionId: "disney-pinnacle" },
  { prefix: "golazos", collectionId: "laliga-golazos" },
  { prefix: "ufc", collectionId: "ufc" },
  { prefix: "candy", collectionId: "candy-mlb" },
]

export const ACCURACY_METRICS: readonly string[] = ACCURACY_METRIC_COLLECTIONS.map(
  (m) => `${m.prefix}_fmv_high_med_share_pct`
)

export interface PrecomputeMetricRow {
  metric: string
  value: number | string | null
  computed_at: string | null
}

export interface AccuracyRow {
  collectionId: string
  /** Display name from the registry (falls back to the id — never blank). */
  label: string
  /**
   * The measured share in [0, 100], or null when the precompute holds no row
   * for this collection or holds a sentinel. null means "not a measurement".
   */
  sharePct: number | null
  /** ISO timestamp of the leg's write, or null when there is no row. */
  computedAt: string | null
  /**
   * true when `computedAt` is older than ACCURACY_STALE_AFTER_MS at build time.
   * Computed HERE (plain function, `nowMs` injectable) rather than in the
   * component, so the component stays pure — no Date.now() during render.
   */
  stale: boolean
  /**
   * Why `sharePct` is null, for the footnote. `measured` when it is not null.
   *   missing        — no row in the precompute
   *   leg_failed     — 999
   *   no_denominator — -1
   *   out_of_range   — a value that is not a percentage and not a known sentinel
   */
  basis: "measured" | "missing" | "leg_failed" | "no_denominator" | "out_of_range"
}

export type AccuracyGateResult =
  | { ok: true; rows: AccuracyRow[]; error: null }
  | { ok: false; rows: null; error: string }

/**
 * Classify one raw precompute value. Pure.
 *
 * ⚠ The comparisons are on the NUMBER, not on a string — PostgREST returns a
 * `numeric` column as a JSON number by default, but a caller may hand this a
 * string from a CSV or a test; both are handled, and anything non-finite is
 * "out_of_range", never a measurement.
 */
export function classifyShare(raw: number | string | null | undefined): {
  sharePct: number | null
  basis: AccuracyRow["basis"]
} {
  if (raw === null || raw === undefined) return { sharePct: null, basis: "missing" }
  const v = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(v)) return { sharePct: null, basis: "out_of_range" }
  if (v === LEG_FAILED_SENTINEL) return { sharePct: null, basis: "leg_failed" }
  if (v === NO_DENOMINATOR_SENTINEL) return { sharePct: null, basis: "no_denominator" }
  if (v < 0 || v > 100) return { sharePct: null, basis: "out_of_range" }
  return { sharePct: v, basis: "measured" }
}

/**
 * The published label for a share. A LABEL, never a decimal:
 *   null        → "unavailable"
 *   0 ≤ v < 1   → "<1%"   (a share below one percent is a label, not a 0 — and
 *                          a measured 0.0, UFC's closed market, is honestly
 *                          "under one percent" without being mistakable for a
 *                          failed read's zero)
 *   otherwise   → whole percent, e.g. "56%"
 *
 * It never returns a string containing "0%" except as part of a larger whole
 * number ("10%", "20%", … "100%") — asserted by the test suite.
 */
export function shareLabel(sharePct: number | null): string {
  if (sharePct === null || !Number.isFinite(sharePct)) return "unavailable"
  if (sharePct < 1) return "<1%"
  return `${Math.round(sharePct)}%`
}

/**
 * Fold raw precompute rows into one display row per listed collection. Pure
 * given `nowMs` (defaults to the wall clock; tests inject it).
 */
export function buildAccuracyRows(raw: readonly PrecomputeMetricRow[], nowMs: number = Date.now()): AccuracyRow[] {
  const byMetric = new Map<string, PrecomputeMetricRow>()
  for (const r of raw) if (r && typeof r.metric === "string") byMetric.set(r.metric, r)

  return ACCURACY_METRIC_COLLECTIONS.map(({ prefix, collectionId }) => {
    const row = byMetric.get(`${prefix}_fmv_high_med_share_pct`)
    const label = getCollection(collectionId)?.label ?? collectionId
    if (!row) {
      return { collectionId, label, sharePct: null, computedAt: null, stale: false, basis: "missing" }
    }
    const { sharePct, basis } = classifyShare(row.value)
    const computedAt = row.computed_at ?? null
    return { collectionId, label, sharePct, computedAt, stale: isStaleReading(computedAt, nowMs), basis }
  })
}

/** true when the reading is older than ACCURACY_STALE_AFTER_MS. Pure. */
export function isStaleReading(computedAt: string | null, nowMs: number = Date.now()): boolean {
  if (!computedAt) return false
  const t = Date.parse(computedAt)
  if (!Number.isFinite(t)) return false
  return nowMs - t > ACCURACY_STALE_AFTER_MS
}

/** Budget on the read. One indexed read of a ~60-row table; 8 s is generous. */
export const ACCURACY_READ_TIMEOUT_MS = 8_000

type MinimalClient = {
  from: (table: string) => {
    select: (cols: string) => {
      in: (col: string, vals: readonly string[]) => PromiseLike<{ data: unknown; error: { message?: string } | null }>
    }
  }
}

/**
 * Read the accuracy gate from the precompute.
 *
 * Never throws. `ok:false` carries a short reason for the server log; the
 * component never prints it (public page — no driver message leaks).
 */
export async function fetchFmvAccuracyGate(
  db: MinimalClient = supabaseAdmin as unknown as MinimalClient
): Promise<AccuracyGateResult> {
  try {
    const q = db.from("rpc_trust_health_precompute").select("metric,value,computed_at").in("metric", ACCURACY_METRICS)
    const { data, error } = await withBoardBudget(
      Promise.resolve(q),
      "fmv-accuracy-gate",
      ACCURACY_READ_TIMEOUT_MS,
      "legal/"
    )
    if (error) {
      console.log(`[legal/fmv-accuracy-gate] read failed: ${error.message ?? "unknown error"}`)
      return { ok: false, rows: null, error: error.message ?? "unknown error" }
    }
    if (!Array.isArray(data)) {
      console.log(`[legal/fmv-accuracy-gate] read returned a non-array payload`)
      return { ok: false, rows: null, error: "non-array payload" }
    }
    return { ok: true, rows: buildAccuracyRows(data as PrecomputeMetricRow[], Date.now()), error: null }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.log(`[legal/fmv-accuracy-gate] read threw: ${msg}`)
    return { ok: false, rows: null, error: msg }
  }
}
