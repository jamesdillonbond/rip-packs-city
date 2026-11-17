// lib/sniper/hub.ts — pure helpers for the /sniper hub (app/sniper/page.tsx).
// Kept out of the page file: Next.js rejects non-route exports from page.tsx.

export const HUB_TOP_N = 12

export type SniperDealRow = {
  external_id: string | null
  name: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  fmv_usd: number | null
  low_ask: number | null
  discount_pct: number | null
  collection_name: string | null
  detail_url: string | null
  low_confidence_fmv: boolean | null
}

/** A PT wall-clock stamp for `data_as_of`; null in → null out, never now(). */
export function formatAsOfPt(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return (
    d.toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }) + " PT"
  )
}

/**
 * The hub's list: confident rows only (a discount against a LOW-confidence FMV is
 * a guess, and the hub has no room for the caveat the full board carries), in the
 * board's own order (biggest discount first), top N.
 */
export function pickHubDeals(rows: SniperDealRow[], n: number = HUB_TOP_N): SniperDealRow[] {
  return rows.filter((r) => r.low_confidence_fmv !== true && r.discount_pct != null && r.low_ask != null).slice(0, n)
}
