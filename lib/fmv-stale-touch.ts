// fmv-recalc Step 6 (stale freshness touch) re-inserts a cold edition's latest
// snapshot with a fresh computed_at. A re-stamp is a NEW ROW dated NOW, so the
// facts it carries must be true NOW — and its age was being copied verbatim
// from the prior row, which froze `days_since_sale` at whatever it read when
// the edition went cold (2026-09-25: 426 latest rows sat at exactly 30, one
// short of the `> 30` the fmv_snapshots_zero_stale_sales_count trigger keys
// on, so "7 sales / 30d · 30d since last" survived 47 real days).

const DAY_MS = 24 * 60 * 60 * 1000

export interface StaleTouchAgeSource {
  /** The edition's true last priced sale, if the query could name one. */
  last_sold_at?: string | null
  /** The prior row's stamp and age — the fallback when no sale can be named. */
  computed_at?: string | null
  days_since_sale?: number | null
}

/**
 * The age (whole days) a re-stamped snapshot must carry.
 *
 *  1. A real last sale → the true age, measured from it.
 *  2. No sale but a prior age → that age advanced by the days elapsed since
 *     the prior row was written (never frozen).
 *  3. Nothing to derive from → null (unknown is not 0 and not "30").
 */
export function staleTouchDaysSinceSale(r: StaleTouchAgeSource, now: Date): number | null {
  const nowMs = now.getTime()
  if (r.last_sold_at) {
    const t = new Date(r.last_sold_at).getTime()
    if (Number.isFinite(t)) return Math.max(0, Math.round((nowMs - t) / DAY_MS))
  }
  if (r.days_since_sale != null && Number.isFinite(Number(r.days_since_sale))) {
    const stamp = r.computed_at ? new Date(r.computed_at).getTime() : NaN
    const elapsed = Number.isFinite(stamp) ? Math.max(0, Math.round((nowMs - stamp) / DAY_MS)) : 0
    return Number(r.days_since_sale) + elapsed
  }
  return null
}
