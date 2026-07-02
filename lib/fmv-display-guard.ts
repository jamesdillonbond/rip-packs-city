// lib/fmv-display-guard.ts
//
// P1a — display-time FMV sanity guard for Top Shot Market + Sniper boards.
//
// The stored FMV (fmv_snapshots) over-weights old high sales on thin-volume
// editions, so a role-player common that once sold for $50 three months ago
// still carries a $42 FMV even though it now trades at $0.30. Ask $0.38 vs a
// $42 FMV renders as a fake "-99% deal". The recalc runs on schedule and
// reproduces the inflated value — the durable fix is the model (P1b). This
// module is the read-side clamp that keeps the boards honest in the meantime.
//
// Source of truth: public.topshot_fmv_display_guard, a small (~1.4k rows)
// precomputed table refreshed daily by refresh_topshot_fmv_display_guard().
// It carries, per flagged Top Shot edition (keyed by external_id, integer
// setID:playID form):
//   - max_sale_90d    : the highest price the edition actually sold for in 90d
//   - is_thin         : <15 sales/90d AND FMV > 1.5x the 90d median
//   - fmv_exceeds_max : FMV is above the 90d max sale (the hard-fake class)
//
// Consumers apply:
//   - fmvExceedsMax → clamp effective FMV to max_sale_90d before computing the
//     discount (never headline a discount against a price the market never
//     paid). On the sniper this makes fake bargains fall below the ask and drop
//     out; on the market browse the row survives with an honest ~0% discount.
//   - isThin | fmvExceedsMax → set lowConfidenceFmv so the UI renders the
//     "⚠ thin data — FMV uncertain" caveat instead of a confident discount.
//
// Display-only: nothing here mutates fmv_snapshots.

import type { SupabaseClient } from "@supabase/supabase-js";

export const TS_COLLECTION_ID_GUARD = "95f28a17-224a-4025-96ad-adf8a4c63bfd";

export interface FmvGuardEntry {
  maxSale90d: number;
  isThin: boolean;
  fmvExceedsMax: boolean;
}

export type FmvGuardMap = Map<string, FmvGuardEntry>;

// Short in-process cache. Both /api/market and /api/sniper-feed call this on
// every request; the guard table only changes once a day, so a 5-minute TTL
// keeps the extra query off the hot path without ever serving stale-enough
// data to matter.
let _cache: { map: FmvGuardMap; at: number } | null = null;
const TTL_MS = 5 * 60_000;

export async function loadTopshotFmvGuard(supabase: SupabaseClient): Promise<FmvGuardMap> {
  const now = Date.now();
  if (_cache && now - _cache.at < TTL_MS) return _cache.map;

  const map: FmvGuardMap = new Map();
  try {
    const { data, error } = await (supabase as any)
      .from("topshot_fmv_display_guard")
      .select("external_id, max_sale_90d, is_thin, fmv_exceeds_max");
    if (error) {
      console.log("[fmv-display-guard] load error: " + error.message);
      // Serve the last good map rather than dropping the guard entirely.
      return _cache?.map ?? map;
    }
    for (const r of (data ?? []) as Array<{
      external_id: string;
      max_sale_90d: number | string | null;
      is_thin: boolean | null;
      fmv_exceeds_max: boolean | null;
    }>) {
      if (!r.external_id) continue;
      map.set(r.external_id, {
        maxSale90d: r.max_sale_90d != null ? Number(r.max_sale_90d) : 0,
        isThin: !!r.is_thin,
        fmvExceedsMax: !!r.fmv_exceeds_max,
      });
    }
    _cache = { map, at: now };
  } catch (err) {
    console.log("[fmv-display-guard] threw: " + (err instanceof Error ? err.message : String(err)));
    return _cache?.map ?? map;
  }
  return map;
}

export interface GuardedFmv {
  /** FMV to display + compute discount against (clamped to 90d max when fake). */
  effectiveFmv: number;
  /** True when the row should render the thin-data caveat. */
  lowConfidenceFmv: boolean;
}

/**
 * Apply the guard to a single Top Shot edition.
 *
 * @param editionKey  integer setID:playID (matches topshot_fmv_display_guard.external_id).
 *                    For "::" parallels, pass the base key too (callers should
 *                    try the parallel key first, then the base).
 * @param fmv         the stored FMV about to be displayed.
 */
export function guardTopshotFmv(
  guard: FmvGuardMap,
  editionKey: string | null | undefined,
  fmv: number | null | undefined
): GuardedFmv {
  const base = fmv != null && Number.isFinite(fmv) ? Number(fmv) : 0;
  if (!editionKey || base <= 0) return { effectiveFmv: base, lowConfidenceFmv: false };
  const entry = guard.get(editionKey) ?? guard.get(editionKey.split("::")[0]);
  if (!entry) return { effectiveFmv: base, lowConfidenceFmv: false };
  const effectiveFmv =
    entry.fmvExceedsMax && entry.maxSale90d > 0 ? Math.min(base, entry.maxSale90d) : base;
  return { effectiveFmv, lowConfidenceFmv: entry.isThin || entry.fmvExceedsMax };
}
