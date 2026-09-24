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
// ingested_at. Every run now reads from the HEAD first and stops at the first
// page whose rows are ALL already stored; the sweep continues behind it with
// the remaining page budget, unchanged (it is what refreshes nft_status
// Sealed → Opened on old sales).
//
// ── HONESTY ────────────────────────────────────────────────────────────────
// * `rows_written` counts rows that did NOT exist before this run (a PK probe
//   per page), not rows offered to an upsert.
// * `ok` is derived from whether every write landed; a failed cursor write
//   fails the run and reports the cursor where it IS (R123).
// * The run logs itself to pipeline_runs — these lanes logged nothing until
//   now (R110), and a log-write error is surfaced, not swallowed.

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

export type PackSalesPage = {
  totalCount: number | null
  endCursor: string | null
  hasNextPage: boolean
  rows: PackSaleRow[]
}

export type PageResult = { ok: true; page: PackSalesPage } | { ok: false; error: string }

/** Flow addresses from the studio API come un-prefixed; storage is 0x-prefixed. */
export function flowAddr(a: string | null | undefined): string | null {
  if (!a) return null
  return a.startsWith("0x") ? a : "0x" + a
}

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
  for (const r of rows) m.set(r.tx_hash + "|" + r.pack_nft_id, r)
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

/**
 * Head-walk stop rule. Keep reading toward the past while the page still
 * brought NEW rows and the API says there is more. A page of only-known rows
 * means we have reached what an earlier run stored.
 */
export function shouldContinueHead(newOnPage: number, pageRows: number, hasNextPage: boolean): boolean {
  if (!hasNextPage) return false
  if (pageRows === 0) return false
  return newOnPage > 0
}

export const PACK_SALES_QUERY =
  `query($i: SearchPackMarketplaceHistoryInput!){ searchPackMarketplaceHistory(searchInput:$i){ totalCount pageInfo{ endCursor hasNextPage } edges{ node{ nft_id listing_resource_id sales_price purchased receiver_address storefront_address custom_id nft{ dist_id status } created_at{ block_height block_time transaction_hash } } } } }`

export type WalkerConfig = {
  pipeline: string
  collectionSlug: string
  table: string
  cursorTable: string
}

export type WalkerDeps = {
  fetchPage: (after: string | null) => Promise<PageResult>
  /** Returns the subset of `${tx}|${nft}` keys already stored, or an error. */
  existingKeys: (rows: PackSaleRow[]) => Promise<{ keys: Set<string>; error: string | null }>
  upsert: (rows: PackSaleRow[]) => Promise<string | null>
  readCursor: () => Promise<{ after: string | null; done: boolean; error: string | null }>
  writeCursor: (after: string | null, done: boolean, totalSeen: number | null) => Promise<string | null>
  sleep?: (ms: number) => Promise<void>
}

export type WalkerResult = {
  ok: boolean
  error: string | null
  head_pages: number
  head_new: number
  sweep_pages: number
  sweep_new: number
  sweep_skipped_done: boolean
  rows_found: number
  rows_written: number
  newest_block_time: string | null
  oldest_sweep_block_time: string | null
  cursor_before: string | null
  cursor_after: string | null
  sweep_has_next: boolean | null
  total_api: number | null
  /** true when a walk stopped on an error: the rows stored so far are a PARTIAL page set. */
  partial: boolean
}

/** Store one page: probe the PK for what is new, upsert all (refreshes nft_status). */
async function storePage(deps: WalkerDeps, rows: PackSaleRow[]): Promise<{ newCount: number; error: string | null }> {
  if (rows.length === 0) return { newCount: 0, error: null }
  const ex = await deps.existingKeys(rows)
  if (ex.error) return { newCount: 0, error: "probe: " + ex.error }
  const newCount = rows.filter((r) => !ex.keys.has(r.tx_hash + "|" + r.pack_nft_id)).length
  const upErr = await deps.upsert(rows)
  if (upErr) return { newCount: 0, error: "upsert: " + upErr }
  return { newCount, error: null }
}

export async function runPackSalesWalk(
  deps: WalkerDeps,
  opts: { headPages: number; totalPages: number; reset: boolean },
): Promise<WalkerResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const res: WalkerResult = {
    ok: false, error: null, head_pages: 0, head_new: 0, sweep_pages: 0, sweep_new: 0,
    sweep_skipped_done: false, rows_found: 0, rows_written: 0, newest_block_time: null,
    oldest_sweep_block_time: null, cursor_before: null, cursor_after: null, sweep_has_next: null,
    total_api: null, partial: false,
  }

  // ── 1. HEAD: newest first, until a page brings nothing new ──────────────
  let headAfter: string | null = null
  for (let i = 0; i < opts.headPages; i++) {
    const r = await deps.fetchPage(headAfter)
    if (!r.ok) { res.error = "head fetch: " + r.error; res.partial = true; break }
    res.head_pages++
    res.total_api = r.page.totalCount ?? res.total_api
    if (i === 0 && r.page.rows.length) res.newest_block_time = r.page.rows[0].block_time
    const s = await storePage(deps, r.page.rows)
    if (s.error) { res.error = "head " + s.error; res.partial = true; break }
    res.rows_found += r.page.rows.length
    res.head_new += s.newCount
    if (!shouldContinueHead(s.newCount, r.page.rows.length, r.page.hasNextPage)) break
    headAfter = r.page.endCursor
    await sleep(120)
  }

  // ── 2. SWEEP: resume the history cursor with the remaining budget ───────
  if (!res.error) {
    const c = await deps.readCursor()
    if (c.error) {
      res.error = "cursor read: " + c.error
    } else if (c.done && !opts.reset) {
      res.sweep_skipped_done = true
      res.cursor_before = c.after
      res.cursor_after = c.after
    } else {
      let after: string | null = opts.reset ? null : c.after
      res.cursor_before = after
      let hasNext = true
      const budget = Math.max(0, opts.totalPages - res.head_pages)
      for (; res.sweep_pages < budget && hasNext; ) {
        const r = await deps.fetchPage(after)
        if (!r.ok) { res.error = "sweep fetch: " + r.error; res.partial = true; break }
        res.sweep_pages++
        res.total_api = r.page.totalCount ?? res.total_api
        const s = await storePage(deps, r.page.rows)
        if (s.error) { res.error = "sweep " + s.error; res.partial = true; break }
        res.rows_found += r.page.rows.length
        res.sweep_new += s.newCount
        const last = r.page.rows[r.page.rows.length - 1]
        if (last?.block_time) res.oldest_sweep_block_time = last.block_time
        hasNext = r.page.hasNextPage
        after = r.page.endCursor ?? after
        await sleep(120)
      }
      res.sweep_has_next = hasNext
      // Persist progress even after a mid-sweep error: `after` only ever
      // advanced past pages that were stored. `done` only on a clean end.
      const wErr = await deps.writeCursor(after, !hasNext && !res.error, res.total_api)
      if (wErr) {
        res.error = (res.error ? res.error + "; " : "") + "cursor write: " + wErr
        res.cursor_after = res.cursor_before // the cursor is where it WAS
      } else {
        res.cursor_after = after
      }
    }
  }

  res.rows_written = res.head_new + res.sweep_new
  res.ok = res.error === null
  return res
}

/** Studio GraphQL fetch with bounded retries on 429/5xx/network. */
export function makeStudioFetch(
  packType: string,
  headers: Record<string, string>,
  endpoint = "https://api.production.studio-platform.dapperlabs.com/graphql",
) {
  return async (after: string | null): Promise<PageResult> => {
    const variables = { i: { first: 100, after, filters: [{ base_filter: { nft_type: { eq: packType } } }] } }
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const r = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ query: PACK_SALES_QUERY, variables }),
          signal: AbortSignal.timeout(20000),
        })
        if (!r.ok) {
          if ((r.status === 429 || r.status >= 500) && attempt < 4) {
            await new Promise((s) => setTimeout(s, 1000 * attempt))
            continue
          }
          return { ok: false, error: `HTTP ${r.status}` }
        }
        const j = await r.json()
        if (j.errors?.length) return { ok: false, error: String(j.errors[0].message) }
        return { ok: true, page: parsePage(j.data?.searchPackMarketplaceHistory) }
      } catch (e) {
        if (attempt < 4) {
          await new Promise((s) => setTimeout(s, 1000 * attempt))
          continue
        }
        return { ok: false, error: String(e) }
      }
    }
    return { ok: false, error: "retries exhausted" }
  }
}

/** Supabase-backed deps. `sb` is a supabase-js client (typed any, per repo convention). */
export function makeSupabaseDeps(sb: any, cfg: WalkerConfig, fetchPage: WalkerDeps["fetchPage"]): WalkerDeps {
  return {
    fetchPage,
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
export async function logWalk(sb: any, cfg: WalkerConfig, startedAt: string, r: WalkerResult): Promise<string | null> {
  const { error } = await sb.rpc("log_pipeline_run", {
    p_pipeline: cfg.pipeline,
    p_started_at: startedAt,
    p_rows_found: r.rows_found,
    p_rows_written: r.rows_written,
    p_rows_skipped: r.rows_found - r.rows_written,
    p_ok: r.ok,
    p_error: r.error,
    p_collection_slug: cfg.collectionSlug,
    p_cursor_before: r.cursor_before,
    p_cursor_after: r.cursor_after,
    p_extra: {
      head_pages: r.head_pages, head_new: r.head_new, sweep_pages: r.sweep_pages, sweep_new: r.sweep_new,
      sweep_skipped_done: r.sweep_skipped_done, sweep_has_next: r.sweep_has_next,
      newest_block_time: r.newest_block_time, oldest_sweep_block_time: r.oldest_sweep_block_time,
      total_api: r.total_api, partial: r.partial,
    },
  })
  return error ? error.message : null
}

/** Shared request handler for the three indexers. */
export async function handlePackSalesRequest(
  req: Request,
  sb: any,
  cfg: WalkerConfig & { packType: string; headers: Record<string, string>; defaultPages: number },
  gate: { key: string; keyOld: string },
): Promise<Response> {
  const url = new URL(req.url)
  if (!gate.key) return new Response("gate not configured", { status: 500 }) // fail CLOSED
  const k = url.searchParams.get("key")
  if (k !== gate.key && !(gate.keyOld && k === gate.keyOld)) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })
  }
  const reset = url.searchParams.get("reset") === "1"
  const totalPages = Math.min(60, Math.max(1, Number(url.searchParams.get("pages") || String(cfg.defaultPages))))
  const headPages = Math.min(10, Math.max(1, Number(url.searchParams.get("head") || "5")))
  const startedAt = new Date().toISOString()
  const deps = makeSupabaseDeps(sb, cfg, makeStudioFetch(cfg.packType, cfg.headers))
  const r = await runPackSalesWalk(deps, { headPages, totalPages, reset })
  const logErr = await logWalk(sb, cfg, startedAt, r)
  const body = { ...r, log_error: logErr }
  return new Response(JSON.stringify(body), {
    status: r.ok ? 200 : 502,
    headers: { "content-type": "application/json" },
  })
}
