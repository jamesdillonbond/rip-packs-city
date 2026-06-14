// lib/insights/top-sales.ts
//
// Shared fetch + @handle-enrichment for the public Top Sales / Whale Watch
// surface (/insights/top-sales). Used by BOTH the API route
// (app/api/public/insights/top-sales/route.ts) and the server page
// (app/insights/top-sales/page.tsx) so the query shape, validation, and the
// buyer/seller username resolution can never drift between them.
//
// Backing view: public.v_insights_top_sales (shipped Cowork
// `audit_20260613_v_insights_top_sales`, security_invoker=on, granted anon).
// Bounded: price_usd >= 100, last 30d, thumbnail present (~600 rows). The
// buyer/seller @handle resolution — RPC's dapper.market moat — is the reason
// this surface is differentiated, so it's done here, server-side, and lands in
// the raw HTML.
//
// IMPORTANT keying note: the view's `moment_id` is NULL across the board;
// `nft_id` is the on-chain moment id (numeric for TS) and is 100% populated.
// So the per-moment media CDN URL and the /moment/<id> drill-down both key on
// `nft_id`, not `moment_id`. (The 06-13 handoff said moment_id — that column is
// empty in this view; nft_id is the correct, populated id.)

import { supabaseAdmin } from "@/lib/supabase"
import { resolveUsernames, displayName } from "@/lib/flowty-username"

export type TopSaleRow = {
  sale_id: string
  edition_id: string | null
  external_id: string | null
  collection: string | null
  collection_id: string | null
  player_name: string | null
  set_name: string | null
  team_name: string | null
  tier: string | null
  circulation_count: number | null
  thumbnail_url: string | null
  nft_id: string | null
  serial_number: number | null
  price_usd: number | null
  sold_at: string | null
  buyer_address: string | null
  seller_address: string | null
  marketplace: string | null
  // Enriched server-side:
  buyer_name: string | null
  seller_name: string | null
}

export type TopSalesWindow = "7d" | "30d"
export type TopSalesSort = "price" | "recent"

export const TOP_SALES_VALID_COLLECTIONS = new Set([
  "nba_top_shot",
  "nfl_all_day",
  "laliga_golazos",
  "disney_pinnacle",
  "ufc_strike",
])

// moment_id intentionally omitted — it is NULL in the view (see header note).
const SELECT_COLS =
  "sale_id, edition_id, external_id, collection, collection_id, player_name, set_name, team_name, tier, circulation_count, thumbnail_url, nft_id, serial_number, price_usd, sold_at, buyer_address, seller_address, marketplace"

export function parseWindow(raw: string | null | undefined): TopSalesWindow {
  return raw === "30d" ? "30d" : "7d"
}

export function parseSort(raw: string | null | undefined): TopSalesSort {
  return raw === "recent" ? "recent" : "price"
}

export type FetchTopSalesOpts = {
  collection?: string | null
  window?: TopSalesWindow
  sort?: TopSalesSort
  limit?: number
}

// Fetch the board rows from the view, then resolve buyer + seller addresses to
// Top Shot @handles in one batched call and attach them as buyer_name /
// seller_name (truncated address when unresolved). Returns enriched rows.
export async function fetchTopSales(
  opts: FetchTopSalesOpts = {}
): Promise<{ rows: TopSaleRow[]; fetchedAt: string }> {
  const collection = opts.collection ?? null
  const window = opts.window ?? "7d"
  const sort = opts.sort ?? "price"
  const limit = Math.max(1, Math.min(200, opts.limit ?? 100))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (supabaseAdmin as any).from("v_insights_top_sales").select(SELECT_COLS)

  if (collection && TOP_SALES_VALID_COLLECTIONS.has(collection)) {
    q = q.eq("collection", collection)
  }

  // Default board window is 7d (fresher, the "this week's whales" framing); the
  // view itself is already bounded to 30d so the 30d branch needs no filter.
  if (window === "7d") {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    q = q.gte("sold_at", since)
  }

  if (sort === "recent") {
    q = q.order("sold_at", { ascending: false, nullsFirst: false })
  } else {
    q = q
      .order("price_usd", { ascending: false, nullsFirst: false })
      .order("sold_at", { ascending: false, nullsFirst: false })
  }

  q = q.limit(limit)

  const { data, error } = await q
  if (error) {
    throw new Error(error.message)
  }

  const raw = (data ?? []) as Omit<TopSaleRow, "buyer_name" | "seller_name">[]

  const names = await resolveUsernames(
    raw.flatMap((r) => [r.buyer_address, r.seller_address]).filter(Boolean) as string[]
  )

  const rows: TopSaleRow[] = raw.map((r) => ({
    ...r,
    buyer_name: r.buyer_address ? displayName(r.buyer_address, names) : null,
    seller_name: r.seller_address ? displayName(r.seller_address, names) : null,
  }))

  return { rows, fetchedAt: new Date().toISOString() }
}
