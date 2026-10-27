// lib/alerts/pinnacle-ask.ts
//
// The TS twin of the Disney Pinnacle arm of public.dispatch_triggered_fmv_alerts (2026-10-26).
// Used by GET /api/alerts to preview whether a Pinnacle alert is currently triggered, so the
// preview and the dispatcher apply one rule.

/**
 * Disney Pinnacle's ask for an alert: the catalog's render floor, only while the floor map is fresh
 * (its own once-per-sweep stamp, 48 h = the Set Tracker's PINNACLE_FLOOR_MAP_STALE_HOURS) and only
 * when the pin has an FMV and the ask is <= 3x it — the same "no FMV -> no ask" and disconnected-ask
 * rules as edition_live_ask. The SQL twin is the Pinnacle arm of dispatch_triggered_fmv_alerts.
 */
export const PINNACLE_ALERT_FLOOR_STALE_HOURS = 48;
export function pinnacleAlertAsk(
  row: { fmv_usd: number | string | null; floor_ask: number | string | null; floor_ask_updated_at: string | null },
  nowMs: number,
): number | null {
  const fmv = row.fmv_usd == null ? null : Number(row.fmv_usd);
  const ask = row.floor_ask == null ? null : Number(row.floor_ask);
  if (fmv == null || !(fmv > 0) || ask == null || !(ask > 0) || ask > fmv * 3) return null;
  const at = row.floor_ask_updated_at ? Date.parse(row.floor_ask_updated_at) : NaN;
  if (!Number.isFinite(at) || nowMs - at > PINNACLE_ALERT_FLOOR_STALE_HOURS * 3_600_000) return null;
  return ask;
}
