// lib/market/hub.ts — server-side reads for the /market hub (app/market/page.tsx).
//
// ⛔ SERVER ONLY: imports the service-role client. Never import this from a
// "use client" module (__tests__/client-modules-never-reach-lib-supabase.test.ts).
//
// Two reads, both reused rather than re-written:
//   * `get_market_pulse_all()` — 24 h sales / volume per collection (the RPC the
//     overview stats already use). One call, ~0.6 s, ~13k buffers measured
//     2026-09-28; the page caches it for 5 minutes.
//   * the last recorded sale, ONLY for a collection whose 24 h count is zero.
//
// ⚠ WHY THE SECOND READ EXISTS. A zero from the pulse means "no row in `sales`
// in 24 h", which is identical for a quiet market and a STALLED FEED. Measured
// the day this shipped: LaLiga Golazos read 0 / $0 while its last recorded sale
// was 2026-09-12 — sixteen days. Publishing "0 sales today" there states a market
// fact the data cannot support. So a zero is shown WITH its last recorded sale,
// and the reader can see how old the evidence is.
//
// ⚠ THREE STATES per tile, never two: the pulse read failed (or the collection is
// ABSENT from its payload — Panini is not in it) → null, rendered as no numbers;
// a real count → the count; zero → zero plus the last-sale date.

import { supabaseAdmin } from "@/lib/supabase"
import { toDbSlug, getCollectionUuid } from "@/lib/collections"

// Collections whose `get_market_pulse_all` arm reads the `sales` table (the
// function's own IN-list; Disney Pinnacle is a separate `pinnacle_sales` arm).
export const SALES_TABLE_FED = new Set(["nba-top-shot", "nfl-all-day", "laliga-golazos", "ufc", "candy-mlb"])

export type PulseRow = {
  slug: string
  sales_24h: number | null
  volume_24h: number | null
  top_sale_24h: number | null
}

export type MarketTileStats = {
  sales24h: number
  volume24h: number | null
  topSale24h: number | null
  /** Set only when sales24h === 0: when the newest recorded sale happened (null = none in 120 d). */
  lastSaleAt?: string | null
}

/** `{ ok:false }` on any failure — never a list of zeros. */
export async function fetchMarketPulse(): Promise<{ ok: true; rows: PulseRow[] } | { ok: false }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabaseAdmin as any).rpc("get_market_pulse_all")
    if (error || !Array.isArray(data)) return { ok: false }
    return { ok: true, rows: data as PulseRow[] }
  } catch {
    return { ok: false }
  }
}

/** Newest sale in the last 120 days for one collection; undefined when the read fails. */
export async function fetchLastSaleAt(collectionUuid: string): Promise<string | null | undefined> {
  try {
    const since = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabaseAdmin as any)
      .from("sales")
      .select("sold_at")
      .eq("collection_id", collectionUuid)
      .gte("sold_at", since)
      .order("sold_at", { ascending: false })
      .limit(1)
    if (error) return undefined
    const row = (data ?? [])[0] as { sold_at?: string } | undefined
    return row?.sold_at ?? null
  } catch {
    return undefined
  }
}

/**
 * Per-collection stats for the given registry ids. A collection whose stats
 * cannot be stated is ABSENT from the map (never zero-filled).
 */
export async function fetchMarketTileStats(
  collectionIds: string[],
  deps: { pulse?: typeof fetchMarketPulse; lastSale?: typeof fetchLastSaleAt } = {},
): Promise<{ pulseOk: boolean; stats: Map<string, MarketTileStats> }> {
  const pulse = await (deps.pulse ?? fetchMarketPulse)()
  const stats = new Map<string, MarketTileStats>()
  if (!pulse.ok) return { pulseOk: false, stats }
  const byDbSlug = new Map(pulse.rows.map((r) => [r.slug, r]))
  const zeroes: Array<Promise<void>> = []
  for (const id of collectionIds) {
    const dbSlug = toDbSlug(id)
    const row = dbSlug ? byDbSlug.get(dbSlug) : undefined
    if (!row || typeof row.sales_24h !== "number") continue
    const s: MarketTileStats = {
      sales24h: row.sales_24h,
      volume24h: row.sales_24h > 0 ? row.volume_24h : null,
      topSale24h: row.sales_24h > 0 ? row.top_sale_24h : null,
    }
    if (row.sales_24h === 0) {
      // ⛔ Only a collection whose pulse is fed by `sales` can be dated from
      // `sales`: Pinnacle's pulse reads `pinnacle_sales`, so a `sales` lookup
      // would answer "no sale in 120 days" about the wrong table.
      const uuid = SALES_TABLE_FED.has(id) ? getCollectionUuid(id) : null
      if (!uuid) continue
      zeroes.push(
        (deps.lastSale ?? fetchLastSaleAt)(uuid).then((at) => {
          // A failed last-sale read leaves the zero unqualified — drop the tile's
          // numbers rather than publish a bare "0 sales" we cannot date.
          if (at === undefined) return
          stats.set(id, { ...s, lastSaleAt: at })
        }),
      )
      continue
    }
    stats.set(id, s)
  }
  await Promise.all(zeroes)
  return { pulseOk: true, stats }
}
