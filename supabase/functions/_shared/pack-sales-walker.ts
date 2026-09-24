// pack-sales-walker — the shared body of the Dapper-studio pack SALES indexers
// (backfill-topshot-pack-sales, backfill-allday-pack-sales, backfill-golazos-pack-sales).
//
// Source: Dapper studio-platform `searchPackMarketplaceHistory`, filtered by the
// collection's PackNFT type. Page 1 is the NEWEST sale; `after` walks back in time.
//
// ── WHY HEAD-FIRST (2026-09-23) ─────────────────────────────────────────────
// Until v33/v32 each run resumed ONE cursor that walks the whole history
// (~595k Top Shot rows at 4,000 rows / 3 min ≈ 7.5 h), latched `done`, and was
// reset by `unlatch_pack_sales_cursors(30)` 30 min later. A new sale therefore
// waited for the entire sweep + 30 min before it landed — measured 09-23 at a
// mean of 5.2 h (Top Shot) and 11.1 h (All Day) between block_time and
// ingested_at. The generic engine (./head-sweep-walker.ts) reads the HEAD first
// and sweeps behind it; this file is the pack-sales row shape + wiring.

import {
  checkGate,
  type HeadSweepDeps,
  type HeadSweepResult,
  logHeadSweep,
  type Page,
  type PageFetch,
  runHeadSweepWalk,
  shouldContinueHead,
  studioGql,
} from "./head-sweep-walker.ts"

export { shouldContinueHead }

export type PackSaleRow = {
  tx_hash: string
  pack_nft_id: string
  listing_resource_id: string | null
  sale_price_usd: number | null
  purchased: boolean
  buyer_address: string | null
  storefront_address: string | null
  custom_id: string | null
  dist_id: string | null
  nft_status: string | null
  block_height: number | null
  block_time: string | null
}

export type PackSalesPage = Page<PackSaleRow>
export type PageResult = PageFetch<PackSaleRow>
export type WalkerDeps = HeadSweepDeps<PackSaleRow>
export type WalkerResult = HeadSweepResult

/** Flow addresses from the studio API come un-prefixed; storage is 0x-prefixed. */
export function flowAddr(a: string | null | undefined): string | null {
  if (!a) return null
  return a.startsWith("0x") ? a : "0x" + a
}

export const saleKey = (r: PackSaleRow) => r.tx_hash + "|" + r.pack_nft_id

/** One GraphQL edge → one row. Returns null when the edge carries no key. */
export function mapEdgeToRow(edge: any): PackSaleRow | null {
  const n = edge?.node
  if (!n) return null
  const ci = n.created_at || {}
  const tx = ci.transaction_hash
  if (!tx || n.nft_id == null || n.nft_id === "") return null
  return {
    tx_hash: String(tx),
    pack_nft_id: String(n.nft_id),
    listing_resource_id: n.listing_resource_id ? String(n.listing_resource_id) : null,
    // DUC/FUT UFix64 on the wire: ÷1e8 = USD.
    sale_price_usd: n.sales_price != null ? Number(n.sales_price) / 1e8 : null,
    purchased: n.purchased === true,
    buyer_address: flowAddr(n.receiver_address),
    storefront_address: flowAddr(n.storefront_address),
    custom_id: n.custom_id ?? null,
    dist_id: n.nft?.dist_id ? String(n.nft.dist_id) : null,
    nft_status: n.nft?.status ?? null,
    block_height: ci.block_height != null ? Number(ci.block_height) : null,
    block_time: ci.block_time ?? null,
  }
}

/** Dedupe a page on the table's primary key (tx_hash, pack_nft_id); last wins. */
export function dedupeRows(rows: PackSaleRow[]): PackSaleRow[] {
  const m = new Map<string, PackSaleRow>()
  for (const r of rows) m.set(saleKey(r), r)
  return Array.from(m.values())
}

export function parsePage(data: any): PackSalesPage {
  const edges = Array.isArray(data?.edges) ? data.edges : []
  const rows: PackSaleRow[] = []
  for (const e of edges) {
    const r = mapEdgeToRow(e)
    if (r) rows.push(r)
  }
  return {
    totalCount: typeof data?.totalCount === "number" ? data.totalCount : null,
    endCursor: data?.pageInfo?.endCursor ?? null,
    hasNextPage: data?.pageInfo?.hasNextPage === true,
    rows: dedupeRows(rows),
  }
}

export const PACK_SALES_QUERY =
  `query($i: SearchPackMarketplaceHistoryInput!){ searchPackMarketplaceHistory(searchInput:$i){ totalCount pageInfo{ endCursor hasNextPage } edges{ node{ nft_id listing_resource_id sales_price purchased receiver_address storefront_address custom_id nft{ dist_id status } created_at{ block_height block_time transaction_hash } } } } }`

export type WalkerConfig = {
  pipeline: string
  collectionSlug: string
  table: string
  cursorTable: string
}

/** Pack-sales walk: the generic engine with the sales key and block_time. */
export function runPackSalesWalk(
  deps: Omit<WalkerDeps, "keyOf" | "timeOf"> & Partial<Pick<WalkerDeps, "keyOf" | "timeOf">>,
  opts: { headPages: number; totalPages: number; reset: boolean },
): Promise<WalkerResult> {
  return runHeadSweepWalk<PackSaleRow>(
    { keyOf: saleKey, timeOf: (r) => r.block_time, ...deps },
    opts,
  )
}

/**
 * Explicit sort with a UNIQUE tiebreak (#135, 2026-09-24). With no sortBy the API
 * orders by block_time alone, yet its cursor resumes at "listing_resource_id <
 * last seen" inside a tied block_time. Rows inside a tie do not come back in that
 * order, so a page boundary inside a bulk transaction SKIPS rows: measured on
 * Golazos (≈11 packs per tx), one boundary inside a 115-row tx lost 72. With the
 * listing id as priority 2 the tie order matches the cursor; the same 200 rows
 * paged as 100+100 came back complete, and `totalCount` fell by exactly 100.
 * Top Shot and All Day (one sale per tx) return the identical head set either way.
 */
export const PACK_SALES_SORT = {
  created_at: { block_time: { direction: "DESC", priority: 1 } },
  listing_resource_id: { direction: "DESC", priority: 2 },
}

export function makeStudioFetch(packType: string, headers: Record<string, string>) {
  return async (after: string | null): Promise<PageResult> => {
    const variables = {
      i: { first: 100, after, sortBy: PACK_SALES_SORT, filters: [{ base_filter: { nft_type: { eq: packType } } }] },
    }
    const r = await studioGql(PACK_SALES_QUERY, variables, headers)
    if (!r.ok) return r
    return { ok: true, page: parsePage(r.data?.searchPackMarketplaceHistory) }
  }
}

/** Supabase-backed deps. `sb` is a supabase-js client (typed any, per repo convention). */
export function makeSupabaseDeps(sb: any, cfg: WalkerConfig, fetchPage: WalkerDeps["fetchPage"]): WalkerDeps {
  return {
    fetchPage,
    keyOf: saleKey,
    timeOf: (r) => r.block_time,
    existingKeys: async (rows) => {
      const txs = Array.from(new Set(rows.map((r) => r.tx_hash)))
      const { data, error } = await sb.from(cfg.table).select("tx_hash,pack_nft_id").in("tx_hash", txs)
      if (error) return { keys: new Set<string>(), error: error.message }
      return { keys: new Set<string>((data ?? []).map((d: any) => d.tx_hash + "|" + d.pack_nft_id)), error: null }
    },
    upsert: async (rows) => {
      const { error } = await sb.from(cfg.table).upsert(rows, { onConflict: "tx_hash,pack_nft_id" })
      return error ? error.message : null
    },
    readCursor: async () => {
      const { data, error } = await sb.from(cfg.cursorTable).select("after_cursor,done").eq("id", 1).maybeSingle()
      if (error) return { after: null, done: false, error: error.message }
      return { after: data?.after_cursor ?? null, done: data?.done === true, error: null }
    },
    writeCursor: async (after, done, totalSeen) => {
      const { error } = await sb.from(cfg.cursorTable).upsert({
        id: 1, after_cursor: after, done, total_seen: totalSeen, updated_at: new Date().toISOString(),
      })
      return error ? error.message : null
    },
  }
}

/** Log the run. Returns the log error (never swallowed by the caller). */
export function logWalk(sb: any, cfg: WalkerConfig, startedAt: string, r: WalkerResult): Promise<string | null> {
  return logHeadSweep(sb, cfg, startedAt, r)
}

/** Shared request handler for the three indexers. */
export async function handlePackSalesRequest(
  req: Request,
  sb: any,
  cfg: WalkerConfig & { packType: string; headers: Record<string, string>; defaultPages: number },
  gate: { key: string; keyOld: string },
): Promise<Response> {
  const url = new URL(req.url)
  const denied = checkGate(url, gate)
  if (denied) return denied
  const reset = url.searchParams.get("reset") === "1"
  const totalPages = Math.min(60, Math.max(1, Number(url.searchParams.get("pages") || String(cfg.defaultPages))))
  const headPages = Math.min(10, Math.max(1, Number(url.searchParams.get("head") || "5")))
  const startedAt = new Date().toISOString()
  const deps = makeSupabaseDeps(sb, cfg, makeStudioFetch(cfg.packType, cfg.headers))
  const r = await runHeadSweepWalk(deps, { headPages, totalPages, reset })
  const logErr = await logWalk(sb, cfg, startedAt, r)
  const body = { ...r, log_error: logErr }
  return new Response(JSON.stringify(body), {
    status: r.ok ? 200 : 502,
    headers: { "content-type": "application/json" },
  })
}
