// lib/candy/collections-market.ts
//
// The MARKET half of the non-registry Candy collections (2026-11-08; Trevor: "we need to
// track and measure all of this"). The rotating census (collections-census.ts) records who
// holds each of the ~398 catalogued collections; this lane records what they trade at.
// Each run takes collections oldest-checked first, inside a time budget, and per collection:
//
//   1. Symbol. Each collection trades under its own Magic Eden symbol, read from ME's own
//      /tokens/<mint> record for one card the census already holds. No symbol → stamped and
//      re-tried after SYMBOL_RETRY_MS (a collection ME does not list is not an error).
//   2. Stats. /collections/<symbol>/stats → one candy_collection_market_daily row per UTC
//      day. ⚠ ME answers {"listedCount":0} with NO floorPrice for a symbol that does not
//      exist, so stats_has_floor is recorded beside it: a 0 without a floor is "no listings
//      OR unknown", never a confirmed empty market.
//   3. Sales. The activity feed, newest first, back to the collection's own high-water mark
//      (sales_high_water_at; a first walk looks back FIRST_WALK_LOOKBACK_MS). Each new sale is
//      OFFERED to candy_sales_unresolved (candy_park_unresolved_sale, reason
//      QUEUE_REASON); the sales indexer's drain prices it on its trade day's SOL rate,
//      resolves its edition from the census and writes `sales` — one writer for Candy sales,
//      not two. A sale already in `sales` or already queued is not offered again (the park
//      RPC would count a re-offer as a failed attempt).
//
// Honesty: the high-water mark advances only after a walk that reached it (or its lookback
// floor) AND whose every offer landed. A walk stopped by the time budget or a failed write
// advances nothing, so the next run re-walks it; one stopped by the page cap advances and says
// so (`truncated`) — the gap is reported, not hidden. Any collection error fails the run.

import { CANDY_MLB_UUID } from "@/lib/chains/solana/normalize"
import { solUsd } from "@/lib/chains/solana/das"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

const ME_BASE = "https://api-mainnet.magiceden.dev/v2"
const ME_LIMIT = 500
const ME_FETCH_TIMEOUT_MS = 15_000
// ME rejects offset > 15,000 (HTTP 400, seen on the All-Star walk 11-08), so 20 pages of 500
// is the deepest a walk can read in any case.
const MAX_PAGES = 20
const FIRST_WALK_LOOKBACK_MS = 30 * 86_400_000
const SYMBOL_RETRY_MS = 7 * 86_400_000
const SALE_TYPES = new Set(["buyNow", "buyNowFill", "acceptBid"])
export const QUEUE_REASON = "queued_collections_walk"

interface MeActivity {
  signature?: string
  type?: string
  tokenMint?: string
  blockTime?: number
  price?: number
  buyer?: string | null
  seller?: string | null
}

export interface CollectionMarketReport {
  address: string
  name: string
  symbol: string | null
  symbol_found_now: boolean
  stats_written: boolean
  pages: number
  sales_seen: number
  sales_offered: number
  truncated: boolean
  high_water_advanced: boolean
  error: string | null
}

export interface CollectionsMarketResult {
  ok: boolean
  collections: CollectionMarketReport[]
  checked: number
  symbols_found: number
  without_symbol: number
  stats_written: number
  sales_offered: number
  error: string | null
}

export async function runCollectionsMarket(
  db: Db,
  opts: { budgetMs: number; now?: () => number; fetchImpl?: FetchFn; pauseMs?: number },
): Promise<CollectionsMarketResult> {
  const now = opts.now ?? Date.now
  const doFetch: FetchFn = opts.fetchImpl ?? ((u, i) => fetch(u, i))
  const pauseMs = opts.pauseMs ?? 250
  const deadline = now() + opts.budgetMs
  const out: CollectionsMarketResult = {
    ok: false, collections: [], checked: 0, symbols_found: 0, without_symbol: 0,
    stats_written: 0, sales_offered: 0, error: null,
  }

  const me = async (path: string): Promise<unknown> => {
    const headers: Record<string, string> = { Accept: "application/json" }
    const key = process.env.MAGIC_EDEN_API_KEY
    if (key) headers["Authorization"] = `Bearer ${key}`
    for (let attempt = 0; attempt < 2; attempt++) {
      if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs))
      const resp = await doFetch(`${ME_BASE}${path}`, { headers, signal: AbortSignal.timeout(ME_FETCH_TIMEOUT_MS) })
      if (resp.status === 429 && attempt === 0) { await new Promise((r) => setTimeout(r, 2000)); continue }
      if (resp.status === 404) return null
      if (!resp.ok) throw new Error(`ME ${path.split("?")[0]} HTTP ${resp.status}`)
      return await resp.json()
    }
    throw new Error(`ME ${path.split("?")[0]} HTTP 429`)
  }

  const { data: queue, error: qErr } = await db
    .from("candy_collections")
    .select("address,name,set_id,me_symbol,me_symbol_checked_at,sales_high_water_at")
    .neq("kind", "test")
    .eq("census", false)
    .not("set_id", "is", null)
    .order("market_checked_at", { ascending: true, nullsFirst: true })
    .order("address", { ascending: true })
    .limit(500)
  if (qErr) {
    out.error = `queue read failed: ${qErr.message ?? String(qErr)}`
    return out
  }

  let solRate: number | null = null
  try { solRate = await solUsd() } catch { solRate = null }

  const errors: string[] = []
  type Row = { address: string; name: string; set_id: string; me_symbol: string | null; me_symbol_checked_at: string | null; sales_high_water_at: string | null }
  for (const c of (queue ?? []) as Row[]) {
    if (now() > deadline) break
    const rep: CollectionMarketReport = {
      address: c.address, name: c.name, symbol: c.me_symbol, symbol_found_now: false, stats_written: false,
      pages: 0, sales_seen: 0, sales_offered: 0, truncated: false, high_water_advanced: false, error: null,
    }
    out.collections.push(rep)
    out.checked++
    const patch: Record<string, unknown> = { market_checked_at: new Date(now()).toISOString(), market_error: null }
    try {
      // 1. Symbol.
      if (!rep.symbol) {
        const checked = c.me_symbol_checked_at ? new Date(c.me_symbol_checked_at).getTime() : 0
        if (checked && now() - checked < SYMBOL_RETRY_MS) {
          out.without_symbol++
          await stamp(db, c.address, patch, rep, errors)
          continue
        }
        const mint = await sampleMint(db, c.set_id)
        const tok = mint ? ((await me(`/tokens/${encodeURIComponent(mint)}`)) as { collection?: string } | null) : null
        const sym = typeof tok?.collection === "string" && tok.collection ? tok.collection : null
        patch.me_symbol_checked_at = new Date(now()).toISOString()
        if (!sym) {
          out.without_symbol++
          await stamp(db, c.address, patch, rep, errors)
          continue
        }
        patch.me_symbol = sym
        rep.symbol = sym
        rep.symbol_found_now = true
        out.symbols_found++
      }
      const symbol = rep.symbol as string

      // 2. Stats.
      const st = (await me(`/collections/${encodeURIComponent(symbol)}/stats`)) as Record<string, unknown> | null
      if (st) {
        const lamports = (k: string) => (typeof st[k] === "number" ? (st[k] as number) / 1e9 : null)
        const { error } = await db.from("candy_collection_market_daily").upsert({
          address: c.address,
          day: new Date(now()).toISOString().slice(0, 10),
          me_symbol: symbol,
          floor_sol: lamports("floorPrice"),
          listed_count: typeof st.listedCount === "number" ? st.listedCount : null,
          avg_price_24h_sol: lamports("avgPrice24hr"),
          volume_all_sol: lamports("volumeAll"),
          stats_has_floor: typeof st.floorPrice === "number",
          sol_usd: solRate,
          captured_at: new Date(now()).toISOString(),
        }, { onConflict: "address,day" })
        if (error) throw new Error(`stats write: ${error.message}`)
        rep.stats_written = true
        out.stats_written++
      }

      // 3. Sales feed back to the high-water mark.
      const hwMs = c.sales_high_water_at ? new Date(c.sales_high_water_at).getTime() : null
      const floorMs = hwMs ?? now() - FIRST_WALK_LOOKBACK_MS
      let newestMs: number | null = null
      let reachedFloor = false
      let budgetStop = false
      const sales: MeActivity[] = []
      for (let page = 0; page < MAX_PAGES; page++) {
        if (now() > deadline) { budgetStop = true; break }
        const acts = ((await me(`/collections/${encodeURIComponent(symbol)}/activities?offset=${page * ME_LIMIT}&limit=${ME_LIMIT}`)) ?? []) as MeActivity[]
        rep.pages++
        for (const a of acts) {
          const tMs = (a.blockTime ?? 0) * 1000
          if (newestMs === null || tMs > newestMs) newestMs = tMs
          if (tMs <= floorMs) { reachedFloor = true; continue }
          if (a.type && SALE_TYPES.has(a.type) && a.signature && a.tokenMint) sales.push(a)
        }
        if (reachedFloor || acts.length < ME_LIMIT) { reachedFloor = true; break }
        if (page === MAX_PAGES - 1) rep.truncated = true
      }
      rep.sales_seen = sales.length

      // Offer only sales not already in `sales` or the queue.
      const sigs = [...new Set(sales.map((s) => s.signature as string))]
      const known = new Set<string>()
      for (let i = 0; i < sigs.length; i += 200) {
        const chunk = sigs.slice(i, i + 200)
        const q = await db.from("candy_sales_unresolved").select("signature").in("signature", chunk)
        if (q.error) throw new Error(`queue read: ${q.error.message}`)
        for (const r of (q.data ?? []) as Array<{ signature: string }>) known.add(r.signature)
        const s = await db.from("sales").select("transaction_hash").eq("collection_id", CANDY_MLB_UUID).in("transaction_hash", chunk)
        if (s.error) throw new Error(`sales read: ${s.error.message}`)
        for (const r of (s.data ?? []) as Array<{ transaction_hash: string }>) known.add(r.transaction_hash)
      }
      for (const a of sales) {
        if (known.has(a.signature as string)) continue
        const { error } = await db.rpc("candy_park_unresolved_sale", {
          p_signature: a.signature,
          p_token_mint: a.tokenMint,
          p_block_time: new Date((a.blockTime ?? 0) * 1000).toISOString(),
          p_price_sol: typeof a.price === "number" ? a.price : null,
          p_buyer: a.buyer ?? null,
          p_seller: a.seller ?? null,
          p_skip_reason: QUEUE_REASON,
        })
        if (error) throw new Error(`offer ${a.signature}: ${error.message}`)
        known.add(a.signature as string)
        rep.sales_offered++
        out.sales_offered++
      }

      if (!budgetStop && (reachedFloor || rep.truncated) && newestMs !== null && (hwMs === null || newestMs > hwMs)) {
        patch.sales_high_water_at = new Date(newestMs).toISOString()
        rep.high_water_advanced = true
      }
    } catch (e) {
      rep.error = (e instanceof Error ? e.message : String(e)).slice(0, 200)
      patch.market_error = rep.error
      errors.push(`${c.name}: ${rep.error}`)
      // A failed walk advances no high-water mark.
      delete patch.sales_high_water_at
    }
    await stamp(db, c.address, patch, rep, errors)
  }

  out.error = errors.length ? errors.slice(0, 5).join(" | ").slice(0, 900) : null
  out.ok = errors.length === 0
  return out
}

async function stamp(db: Db, address: string, patch: Record<string, unknown>, rep: CollectionMarketReport, errors: string[]) {
  const { error } = await db.from("candy_collections").update(patch).eq("address", address)
  if (error) {
    rep.error = rep.error ?? `state write: ${error.message}`
    errors.push(`${rep.name}: state write: ${error.message}`)
  }
}

// One card of the collection the census already holds: an edition of its set, then a holding of
// that edition. Null when the census has not reached the collection yet.
async function sampleMint(db: Db, setId: string): Promise<string | null> {
  const { data: eds, error } = await db
    .from("editions")
    .select("external_id")
    .eq("collection_id", CANDY_MLB_UUID)
    .eq("set_id", setId)
    .limit(5)
  if (error) throw new Error(`editions read: ${error.message}`)
  const keys = ((eds ?? []) as Array<{ external_id: string }>).map((e) => e.external_id)
  if (keys.length === 0) return null
  const { data: w, error: wErr } = await db
    .from("wallet_moments_cache")
    .select("moment_id")
    .eq("collection_id", CANDY_MLB_UUID)
    .in("edition_key", keys)
    .limit(1)
  if (wErr) throw new Error(`holdings read: ${wErr.message}`)
  return ((w ?? []) as Array<{ moment_id: string }>)[0]?.moment_id ?? null
}
