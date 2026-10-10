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
  // candy_mlb added 2026-09-19. This set is a 400-gate on ?collection=, and it
  // was narrower than the view it guards: `v_insights_top_sales` already carries
  // Candy rows (7 in the 30d window, top sale $203.72, measured that day), so
  // /api/public/insights/top-sales?collection=candy_mlb answered
  // "collection must be one of …" for rows it was ALREADY serving under
  // collection=all. A filter that rejects data the endpoint returns is a bug in
  // the filter, not a policy.
  "candy_mlb",
  // panini_blockchain added 2026-10-10. Its rows come from a SECOND view,
  // v_panini_top_sales (service-role only: panini_sales is not anon-readable, so it
  // cannot join the anon-granted v_insights_top_sales), merged below with the same
  // filters and order. Its buyer/seller are Panini USERNAMES, shown as-is.
  "panini_blockchain",
])

export const PANINI_TOP_SALES_COLLECTION = "panini_blockchain"

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

  const since = window === "7d" ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() : null
  // One query shape for both views, so the merge below compares like with like.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const build = (view: string, eqCollection: string | null): PromiseLike<{ data: any[] | null; error: { message: string } | null }> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q = (supabaseAdmin as any).from(view).select(SELECT_COLS)
    if (eqCollection) q = q.eq("collection", eqCollection)
    // Default board window is 7d (fresher, the "this week's whales" framing); the
    // views themselves are already bounded to 30d so the 30d branch needs no filter.
    if (since) q = q.gte("sold_at", since)
    if (sort === "recent") {
      q = q.order("sold_at", { ascending: false, nullsFirst: false })
    } else {
      q = q
        .order("price_usd", { ascending: false, nullsFirst: false })
        .order("sold_at", { ascending: false, nullsFirst: false })
    }
    return q.limit(limit)
  }

  const known = collection && TOP_SALES_VALID_COLLECTIONS.has(collection) ? collection : null
  const wantFlow = known !== PANINI_TOP_SALES_COLLECTION
  const wantPanini = known === null || known === PANINI_TOP_SALES_COLLECTION
  const [flow, panini] = await Promise.all([
    wantFlow ? build("v_insights_top_sales", known) : Promise.resolve({ data: [], error: null }),
    wantPanini ? build("v_panini_top_sales", null) : Promise.resolve({ data: [], error: null }),
  ])
  // Either read failing fails the board: a merged list missing one source would
  // publish "the top sales" with a collection silently absent.
  if (flow.error) throw new Error(flow.error.message)
  if (panini.error) throw new Error(`v_panini_top_sales: ${panini.error.message}`)

  const byOrder = (a: { price_usd: number | null; sold_at: string | null }, b: { price_usd: number | null; sold_at: string | null }) => {
    const t = (x: string | null) => (x ? Date.parse(x) : -Infinity)
    if (sort === "recent") return t(b.sold_at) - t(a.sold_at)
    return (Number(b.price_usd ?? -Infinity) - Number(a.price_usd ?? -Infinity)) || t(b.sold_at) - t(a.sold_at)
  }
  const flowRaw = (flow.data ?? []) as Omit<TopSaleRow, "buyer_name" | "seller_name">[]
  const paniniRaw = (panini.data ?? []) as Omit<TopSaleRow, "buyer_name" | "seller_name">[]
  const raw = [...flowRaw, ...paniniRaw].sort(byOrder).slice(0, limit)

  // Only chain addresses go to the resolver; a Panini username is already a name.
  const names = await resolveUsernames(
    raw
      .filter((r) => r.collection !== PANINI_TOP_SALES_COLLECTION)
      .flatMap((r) => [r.buyer_address, r.seller_address])
      .filter(Boolean) as string[]
  )

  const nameOf = (r: Omit<TopSaleRow, "buyer_name" | "seller_name">, a: string | null) =>
    !a ? null : r.collection === PANINI_TOP_SALES_COLLECTION ? a : displayName(a, names)
  const rows: TopSaleRow[] = raw.map((r) => ({
    ...r,
    buyer_name: nameOf(r, r.buyer_address),
    seller_name: nameOf(r, r.seller_address),
  }))

  return { rows, fetchedAt: new Date().toISOString() }
}
