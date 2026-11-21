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
//      (sales_high_water_at; a first walk reads to the end of the feed, bounded by MAX_PAGES — a
//      30-day first-walk window run inside the 10-12 → 11-06 market lock stranded ~5.5k pre-lock
//      sales on 320 legacy symbols, 11-14). Each new sale is
//      OFFERED to candy_sales_unresolved (candy_park_unresolved_sale, reason
//      QUEUE_REASON); the sales indexer's drain prices it on its trade day's SOL rate,
//      resolves its edition from the census and writes `sales` — one writer for Candy sales,
//      not two. A sale already in `sales` or already queued is not offered again (the park
//      RPC would count a re-offer as a failed attempt).
//   4. Listings (2026-11-14). The collection's current Magic Eden asks → candy_listings, so the
//      FMV ask-ceiling covers legacy cards; see sweepListings for the retirement rule.
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
// ME rejects offset > 15,000 (HTTP 400, seen on the All-Star walk 11-08), so offsets
// 0, 500 … 15,000 — 31 pages of 500 — are the deepest a walk can read. (Was 20, which stopped
// at offset 9,500 and left the 10,000–15,000 band unread on the deepest symbols: the 11-14
// Magic Eden pull planned 31 pages for knight_terrors, superman_19392011_1 and 2022_leadoff_icons.)
const MAX_PAGES = 31
// Listings (asks). ME's /collections/<symbol>/listings accepts limit <= 100 (500 is HTTP 400,
// candy-listings-indexer 07-24). The largest legacy book measured 11-14 was 473 asks, so 20
// pages is far above any real book; a sweep that hits the cap is incomplete and retires nothing.
const LISTING_LIMIT = 100
const LISTING_MAX_PAGES = 20
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
  listings_seen: number
  listings_written: number
  listings_unresolved: number
  listings_refreshed_unresolved: number
  listings_complete: boolean
  listings_retired: number | null
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
  listings_written: number
  listings_retired: number
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
    stats_written: 0, sales_offered: 0, listings_written: 0, listings_retired: 0, error: null,
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
      pages: 0, sales_seen: 0, sales_offered: 0, truncated: false, high_water_advanced: false,
      listings_seen: 0, listings_written: 0, listings_unresolved: 0, listings_refreshed_unresolved: 0, listings_complete: false, listings_retired: null,
      error: null,
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
      const listedCount = typeof st?.listedCount === "number" ? (st.listedCount as number) : null

      // 3. Sales feed back to the high-water mark.
      const hwMs = c.sales_high_water_at ? new Date(c.sales_high_water_at).getTime() : null
      const floorMs = hwMs ?? 0 // no high-water mark: walk the whole feed (page cap reports `truncated`)
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

      // 4. Listings. Its own try: a failed listings sweep fails the RUN (it is recorded) but must
      // not throw away a sales walk that completed above.
      try {
        await sweepListings(db, me, c.set_id, symbol, listedCount, solRate, now, deadline, rep)
        out.listings_written += rep.listings_written
        out.listings_retired += rep.listings_retired ?? 0
      } catch (e) {
        const msg = `listings: ${(e instanceof Error ? e.message : String(e)).slice(0, 180)}`
        rep.error = msg
        patch.market_error = msg
        errors.push(`${c.name}: ${msg}`)
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

// The collection's current asks → candy_listings (venue magic_eden), so the FMV ask-ceiling
// (candy_listing_floor → lib/fmv-candy-ceiling.ts) covers legacy cards too. Before 11-14 only the
// registry sets' indexer wrote asks: 0 legacy rows against ~10,650 legacy asks on ME.
//
// A mint resolves to its edition through the census (wallet_moments_cache.edition_key →
// editions.external_id), exactly as candy-listings-indexer does; a mint the census has not
// reached is counted (listings_unresolved), not written. A listing ME still serves for a card
// whose owner has since moved is skipped (candy_listing_owner_moved_pdas, same rule as the
// indexer).
//
// Retirement — an ask ME stopped serving is set inactive — runs ONLY behind a sweep that is
// complete (a short page, inside the page cap and the time budget) AND plausible: ME's listings
// endpoint has answered 420, 7 and 22 for the same book inside six hours (07-27), so a sweep
// that saw fewer than half the asks /stats reports retires nothing. Retirement is scoped to
// this collection's set (candy_retire_unseen_set_listings) and to rows last seen before this
// sweep began, so it can never touch a registry set or an ask written by this sweep.
async function sweepListings(
  db: Db,
  me: (path: string) => Promise<unknown>,
  setId: string,
  symbol: string,
  listedCount: number | null,
  solRate: number | null,
  now: () => number,
  deadline: number,
  rep: CollectionMarketReport,
): Promise<void> {
  const sweepStartIso = new Date(now()).toISOString()
  const listings: MeListing[] = []
  let complete = false
  let endpointMissing = false
  for (let page = 0; page < LISTING_MAX_PAGES; page++) {
    if (now() > deadline) break
    const got = (await me(`/collections/${encodeURIComponent(symbol)}/listings?offset=${page * LISTING_LIMIT}&limit=${LISTING_LIMIT}`)) as MeListing[] | null
    if (got === null) { endpointMissing = true; break }
    const arr = Array.isArray(got) ? got : []
    listings.push(...arr)
    if (arr.length < LISTING_LIMIT) { complete = true; break }
  }
  const valid = listings.filter((l) => l.pdaAddress && l.tokenMint && typeof l.price === "number" && l.price > 0)
  rep.listings_seen = valid.length

  // Resolve mints → edition ids.
  const mints = [...new Set(valid.map((l) => l.tokenMint as string))]
  const keyByMint = new Map<string, string>()
  for (let i = 0; i < mints.length; i += 200) {
    const { data, error } = await db
      .from("wallet_moments_cache")
      .select("moment_id, edition_key")
      .eq("collection_id", CANDY_MLB_UUID)
      .in("moment_id", mints.slice(i, i + 200))
    if (error) throw new Error(`wmc read: ${error.message}`)
    for (const r of (data ?? []) as Array<{ moment_id: string; edition_key: string | null }>) {
      if (r.edition_key && !keyByMint.has(r.moment_id)) keyByMint.set(r.moment_id, r.edition_key)
    }
  }
  const keys = [...new Set(keyByMint.values())]
  const idByKey = new Map<string, string>()
  for (let i = 0; i < keys.length; i += 200) {
    const { data, error } = await db
      .from("editions")
      .select("id, external_id")
      .eq("collection_id", CANDY_MLB_UUID)
      .in("external_id", keys.slice(i, i + 200))
    if (error) throw new Error(`editions read: ${error.message}`)
    for (const r of (data ?? []) as Array<{ id: string; external_id: string }>) {
      if (!idByKey.has(r.external_id)) idByKey.set(r.external_id, r.id)
    }
  }

  // Owner-moved asks are not live asks.
  const ownerMoved = new Set<string>()
  const pdas = [...new Set(valid.map((l) => l.pdaAddress as string))]
  if (pdas.length) {
    const { data, error } = await db.rpc("candy_listing_owner_moved_pdas", { p_pdas: pdas })
    if (error) throw new Error(`owner_moved read: ${error.message}`)
    const sellerByPda = new Map(valid.map((l) => [l.pdaAddress as string, l.seller ?? null]))
    for (const r of (Array.isArray(data) ? data : []) as Array<{ pda_address: string; seller: string | null }>) {
      if (sellerByPda.get(r.pda_address) === r.seller) ownerMoved.add(r.pda_address)
    }
  }

  const seenAt = new Date(now()).toISOString()
  const rows: Record<string, unknown>[] = []
  const seenPdas = new Set<string>()
  const unresolved = new Map<string, MeListing>()
  for (const l of valid) {
    const pda = l.pdaAddress as string
    if (seenPdas.has(pda) || ownerMoved.has(pda)) continue
    const key = keyByMint.get(l.tokenMint as string)
    const editionId = key ? idByKey.get(key) ?? null : null
    if (!editionId) {
      if (!unresolved.has(pda)) { rep.listings_unresolved++; unresolved.set(pda, l) }
      continue
    }
    seenPdas.add(pda)
    rows.push({
      pda_address: pda,
      token_mint: l.tokenMint,
      edition_id: editionId,
      collection_id: CANDY_MLB_UUID,
      seller: l.seller ?? null,
      auction_house: l.auctionHouse ?? null,
      price_sol: l.price,
      price_usd: solRate != null ? Number(((l.price as number) * solRate).toFixed(2)) : null,
      token_size: l.tokenSize ?? null,
      expiry: l.expiry && l.expiry > 0 ? new Date(l.expiry * 1000).toISOString() : null,
      last_seen_at: seenAt,
      is_active: true,
      venue: "magic_eden",
    })
  }
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100)
    const { error } = await db.from("candy_listings").upsert(batch, { onConflict: "pda_address" })
    if (error) throw new Error(`candy_listings upsert: ${error.message}`)
    rep.listings_written += batch.length
  }

  // An ask ME still serves whose card the census no longer resolves (its mint dropped out of
  // wallet_moments_cache after the row was written) keeps the row it already has: refresh its
  // seen time and price so last_seen_at keeps meaning "ME served it then". Before 2026-11-20 such
  // a row stopped advancing while staying active — #257 read it as a stale ask (one $64.96 Blackest
  // Night ask, last_seen 11-15, served by ME on every sweep since). Only EXISTING active rows are
  // touched; an unresolved ask with no row is still never written under a guessed edition.
  const unresolvedPdas = [...unresolved.keys()]
  for (let i = 0; i < unresolvedPdas.length; i += 200) {
    const { data, error } = await db
      .from("candy_listings")
      .select("pda_address")
      .eq("is_active", true)
      .in("pda_address", unresolvedPdas.slice(i, i + 200))
    if (error) throw new Error(`candy_listings read: ${error.message}`)
    for (const r of (data ?? []) as Array<{ pda_address: string }>) {
      const l = unresolved.get(r.pda_address)
      if (!l) continue
      const { error: upErr } = await db
        .from("candy_listings")
        .update({
          last_seen_at: seenAt,
          price_sol: l.price,
          price_usd: solRate != null ? Number(((l.price as number) * solRate).toFixed(2)) : null,
        })
        .eq("pda_address", r.pda_address)
      if (upErr) throw new Error(`candy_listings refresh: ${upErr.message}`)
      rep.listings_refreshed_unresolved++
    }
  }

  // A pda ME still serves keeps its row even when it was not written this sweep (owner-moved
  // or unresolved): only an ask ME no longer serves is retired.
  const plausible = listedCount === null ? valid.length > 0 : valid.length * 2 >= listedCount
  rep.listings_complete = complete && !endpointMissing
  if (rep.listings_complete && plausible) {
    const { data, error } = await db.rpc("candy_retire_unseen_set_listings", {
      p_set_id: setId,
      p_seen_pdas: pdas,
      p_before: sweepStartIso,
    })
    if (error) throw new Error(`retire: ${error.message}`)
    rep.listings_retired = typeof data === "number" ? data : Number(data ?? 0)
  }
}

interface MeListing {
  pdaAddress?: string
  tokenMint?: string
  auctionHouse?: string
  seller?: string
  price?: number
  tokenSize?: number
  expiry?: number
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
