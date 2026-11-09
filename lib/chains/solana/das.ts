// lib/chains/solana/das.ts
//
// Solana Digital Asset Standard (DAS) read client for Candy Digital (chain
// two — Metaplex Core on Solana). Every call goes through the deployed
// `helius-proxy` Cloudflare Worker so the upstream API key never ships to the
// client and Vercel/Supabase egress stays off the keyed endpoint — consistent
// with RPC's proxy-everything rule (see workers/helius-proxy/README.md).
//
// Auth surface is its OWN rotation domain: HELIUS_PROXY_SECRET sent as the
// X-Proxy-Secret header — never TS_PROXY_SECRET / INGEST_SECRET_TOKEN.
//
// This is the read path only. Nothing here mutates state. The Candy collection
// is inert (is_active=false) until Item 0 discovery lands the collection
// address + serial/edition attribute keys (see lib/chains/solana/normalize.ts).

// DAS path + HELIUS_PROXY_SECRET verified live end-to-end FROM VERCEL 2026-07-17
// (getAsset/getAssetsByGroup returned 200 via helius-proxy after reconciling the
// shared secret between Vercel + the worker; the 2026-07-16 check was worker-direct only).
const HELIUS_PROXY_URL = process.env.HELIUS_PROXY_URL || ""
const HELIUS_PROXY_SECRET = process.env.HELIUS_PROXY_SECRET || ""

// One asset as returned by DAS (interface "MplCore"). Only the fields RPC reads
// are typed; DAS returns more. `[k: string]: unknown` keeps it permissive so a
// schema drift doesn't break the type-check before discovery confirms shapes.
export interface DasAsset {
  id: string // asset mint pubkey (base58) — the per-serial id
  grouping?: Array<{ group_key: string; group_value: string }>
  content?: {
    json_uri?: string
    metadata?: {
      name?: string
      symbol?: string
      attributes?: Array<{ trait_type?: string; value?: unknown }>
    }
    files?: Array<{ uri?: string; mime?: string; cdn_uri?: string }>
    links?: { image?: string; animation_url?: string; external_url?: string }
  }
  ownership?: { owner?: string; frozen?: boolean; delegated?: boolean }
  burnt?: boolean // Metaplex Core native burn (Diamond Economy) — see normalize.isBurnt
  royalty?: { basis_points?: number }
  supply?: { print_max_supply?: number; print_current_supply?: number } | null
  [k: string]: unknown
}

interface DasPage {
  total: number
  limit: number
  page: number
  items: DasAsset[]
}

/** Per-request cap on a DAS proxy call. See the note at the `fetch` below. */
const DAS_FETCH_TIMEOUT_MS = 25_000

/**
 * Low-level JSON-RPC call through helius-proxy. Returns the `result` field;
 * throws on a JSON-RPC `error`, a non-2xx proxy response, or a timeout.
 */
export async function dasCall<T = unknown>(
  method: string,
  params: Record<string, unknown>
): Promise<T> {
  if (!HELIUS_PROXY_URL || !HELIUS_PROXY_SECRET) {
    throw new Error(
      "helius-proxy not configured (HELIUS_PROXY_URL / HELIUS_PROXY_SECRET missing)"
    )
  }
  const resp = await fetch(HELIUS_PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Proxy-Secret": HELIUS_PROXY_SECRET,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    // 25s cap. `fetch()` has no default timeout, so a proxy that accepts the
    // connection and holds it open consumes the CALLER's entire lambda budget —
    // and every caller of this helper is a candy ingest route running inside
    // `after()`, where a maxDuration kill writes NO terminal pipeline_runs row
    // at all. The failure is therefore invisible and reads as "the cron never
    // fired". That exact outage was measured on the sibling
    // /api/candy-listings-indexer on 2026-08-27: 15 heartbeats, ONE terminal row
    // in 48h, and a PUBLIC board 44 hours stale.
    //
    // ⚠ Deliberately looser than the 8s used for CoinGecko below: a DAS page
    // (getAssetsByGroup at limit 1000) is real work, not a price lookup, so a
    // tight cap would convert working behaviour into failure. This bounds a
    // HANG, it does not police latency.
    //
    // ⚠ This helper THROWS on abort, like every other failure here, and callers
    // already handle a throw. `candy-sales-indexer` budgets 400 asset fetches a
    // tick — unbounded, one stuck call could eat all 300s on its own.
    signal: AbortSignal.timeout(DAS_FETCH_TIMEOUT_MS),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(`DAS ${method} HTTP ${resp.status}: ${text.slice(0, 200)}`)
  }
  const json = (await resp.json()) as { result?: T; error?: { message?: string } }
  if (json.error) {
    throw new Error(`DAS ${method} error: ${json.error.message ?? "unknown"}`)
  }
  return json.result as T
}

/** All assets grouped under a Metaplex Core collection address, one page. */
export function getAssetsByGroup(
  collection: string,
  page = 1,
  limit = 1000
): Promise<DasPage> {
  return dasCall<DasPage>("getAssetsByGroup", {
    groupKey: "collection",
    groupValue: collection,
    page,
    limit,
  })
}

/**
 * All assets grouped under a collection address, one page, CURSOR-paged (keyset on asset
 * id). Pass null for the first page, then the `cursor` the previous page returned.
 *
 * Why not `page`: DAS serves `page=N` as an OFFSET, so its cost grows with N. On 2026-11-09
 * the census read "2022 Leadoff ICONs" (~230k items) to page 227 and then failed at page
 * 228 on four consecutive hourly runs with the provider's own "canceling statement due to
 * statement timeout" — a page that can never be read, so the walk could never finish.
 * A cursor read costs the same at any depth.
 *
 * `cursor` is absent from the response when the provider did not answer in cursor mode;
 * a caller must treat a FULL page without one as an error, never as the end of the walk.
 */
export function getAssetsByGroupCursor(
  collection: string,
  cursor: string | null,
  limit = 1000
): Promise<DasPage & { cursor?: string | null }> {
  const params: Record<string, unknown> = {
    groupKey: "collection",
    groupValue: collection,
    limit,
    sortBy: { sortBy: "id", sortDirection: "asc" },
  }
  if (cursor) params.cursor = cursor
  return dasCall<DasPage & { cursor?: string | null }>("getAssetsByGroup", params)
}

/** A wallet's holdings, one page (unfiltered — caller filters to Candy). */
export function getAssetsByOwner(
  owner: string,
  page = 1,
  limit = 1000
): Promise<DasPage> {
  return dasCall<DasPage>("getAssetsByOwner", { ownerAddress: owner, page, limit })
}

/** One asset by mint pubkey — discovery / per-sale edition resolution. */
export function getAsset(id: string): Promise<DasAsset> {
  return dasCall<DasAsset>("getAsset", { id })
}

/** Several assets (or Core collection accounts) by id, one call — up to 1,000 ids. */
export function getAssetBatch(ids: string[]): Promise<Array<DasAsset | null>> {
  return dasCall<Array<DasAsset | null>>("getAssetBatch", { ids })
}

// Walk every page of a paged DAS method, invoking onPage per page. Stops on the
// first short page (items.length < limit) or when MAX_PAGES is hit (a runaway
// guard so a bad collection address can't loop forever). Returns the total
// number of assets seen.
const MAX_PAGES = 200
const PAGE_LIMIT = 1000

export async function paginateGroup(
  collection: string,
  onPage: (items: DasAsset[], page: number) => Promise<void> | void
): Promise<number> {
  let seen = 0
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await getAssetsByGroup(collection, page, PAGE_LIMIT)
    const items = res.items ?? []
    if (items.length === 0) break
    await onPage(items, page)
    seen += items.length
    if (items.length < PAGE_LIMIT) break
  }
  return seen
}

export async function paginateOwner(
  owner: string,
  onPage: (items: DasAsset[], page: number) => Promise<void> | void
): Promise<number> {
  let seen = 0
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await getAssetsByOwner(owner, page, PAGE_LIMIT)
    const items = res.items ?? []
    if (items.length === 0) break
    await onPage(items, page)
    seen += items.length
    if (items.length < PAGE_LIMIT) break
  }
  return seen
}

// ── SOL → USD spot, cached per UTC day ─────────────────────────────────────
// Magic Eden activity prices are denominated in SOL. We record sales in USD, so
// we need a SOL→USD rate. CoinGecko's free simple-price endpoint is fine here —
// it's not a Flow/TopShot/Flowty host, so direct Vercel egress is allowed (no
// proxy). The rate is cached per UTC day. NOTE: a sale's `source` names the
// resolver/feed, NOT the rate basis — so solUsdOn() below refuses to price a
// days-old sale at today's spot rather than record a basis nobody can see.
//
// NOTE: solUsd() is the SPOT rate (today), suitable for live ASK/BID snapshots
// (listings/offers) whose USD value is inherently "as of now". For a realized
// SALE, use solUsdOn(saleMs) below instead — it prices the trade on the SOL/USD
// rate that prevailed on the sale's own UTC day, which matters once the drain
// re-attempts sales that are days old (deep-history backfill).
let solUsdCache: { day: string; rate: number } | null = null

export async function solUsd(): Promise<number | null> {
  const day = new Date().toISOString().slice(0, 10)
  if (solUsdCache && solUsdCache.day === day) return solUsdCache.rate
  try {
    const resp = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      // 8s cap: CoinGecko rate-limits datacenter egress hard and can hold a
      // connection open indefinitely. fetch() has no default timeout, so an
      // unbounded call here can consume a caller's ENTIRE lambda budget for a
      // value this function is happy to return from cache. On abort the catch
      // below falls through to the last cached rate (or null), which every
      // caller already handles.
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) }
    )
    if (!resp.ok) return solUsdCache?.rate ?? null
    const json = (await resp.json()) as { solana?: { usd?: number } }
    const rate = json.solana?.usd
    if (typeof rate === "number" && rate > 0) {
      solUsdCache = { day, rate }
      return rate
    }
  } catch {
    // fall through to the last cached rate (or null)
  }
  return solUsdCache?.rate ?? null
}

// ── SOL → USD for a specific sale's UTC day (historical) ────────────────────
// Resolves the SOL/USD rate that prevailed on the UTC day a sale actually
// traded, so a realized `sales` row is priced on its own day even when it is
// ingested (or re-attempted by the dead-letter drain) days after the fact.
//
// Basis policy (known-issues "solUsdOn", fixed 2026-11-03):
//   - no usable timestamp, or a sale from today / the future → live SPOT;
//   - a past-day sale → that day's settled close (HISTORICAL);
//   - history unavailable AND the sale is under SPOT_FALLBACK_MAX_AGE_MS old →
//     SPOT (within a day, spot ≈ the day's close: 0 of 1,878 sales in the 60 d
//     to 11-02 were priced later than that);
//   - history unavailable AND the sale is OLDER → null. Both callers park a
//     null-rate sale ("no_sol_rate") and retry it, so the sale is delayed, never
//     dropped — and never written at a rate from a different week. (Before this,
//     it silently took today's spot and nothing downstream could tell.)
// A failed history day is negative-cached for NEGATIVE_TTL_MS only, so a
// rate-limited endpoint costs one call per day per window rather than one per
// sale, and a warm lambda still retries later instead of never.
export type SolUsdBasis = "historical" | "spot"

const SPOT_FALLBACK_MAX_AGE_MS = 24 * 3_600_000
const NEGATIVE_TTL_MS = 15 * 60_000

const solUsdDayCache = new Map<string, number>()
const solUsdDayMiss = new Map<string, number>() // day → expiry (ms)

// CoinGecko's /coins/{id}/history endpoint keys on a dd-mm-yyyy (UTC) date.
function coingeckoHistoryDate(atMs: number): string {
  const d = new Date(atMs)
  const dd = String(d.getUTCDate()).padStart(2, "0")
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0")
  const yyyy = d.getUTCFullYear()
  return `${dd}-${mm}-${yyyy}`
}

async function spotWithBasis(): Promise<{ rate: number; basis: SolUsdBasis } | null> {
  const rate = await solUsd()
  return rate == null ? null : { rate, basis: "spot" }
}

export async function solUsdOnWithBasis(
  atMs: number | null | undefined
): Promise<{ rate: number; basis: SolUsdBasis } | null> {
  // No usable timestamp → treat as "now".
  if (typeof atMs !== "number" || !Number.isFinite(atMs)) return spotWithBasis()

  const nowMs = Date.now()
  const saleDay = new Date(atMs).toISOString().slice(0, 10) // yyyy-mm-dd (UTC)
  const today = new Date(nowMs).toISOString().slice(0, 10)
  // ISO yyyy-mm-dd strings order lexicographically. Today or later has no
  // settled historical close — use the live spot rate.
  if (saleDay >= today) return spotWithBasis()

  const cached = solUsdDayCache.get(saleDay)
  if (cached != null) return { rate: cached, basis: "historical" }

  const missUntil = solUsdDayMiss.get(saleDay)
  if (missUntil == null || missUntil <= nowMs) {
    try {
      const resp = await fetch(
        `https://api.coingecko.com/api/v3/coins/solana/history?date=${coingeckoHistoryDate(atMs)}&localization=false`,
        // Same 8s cap as solUsd(): CoinGecko rate-limits datacenter egress hard.
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) }
      )
      if (resp.ok) {
        const json = (await resp.json()) as {
          market_data?: { current_price?: { usd?: number } }
        }
        const rate = json.market_data?.current_price?.usd
        if (typeof rate === "number" && rate > 0) {
          solUsdDayCache.set(saleDay, rate)
          solUsdDayMiss.delete(saleDay)
          return { rate, basis: "historical" }
        }
      }
    } catch {
      // fall through to the negative-cache + age-gated fallback below
    }
    solUsdDayMiss.set(saleDay, nowMs + NEGATIVE_TTL_MS)
  }

  // History unavailable. Spot is an acceptable stand-in only for a recent sale.
  if (nowMs - atMs < SPOT_FALLBACK_MAX_AGE_MS) return spotWithBasis()
  return null
}

/** Rate only — see solUsdOnWithBasis for the basis policy (null = park the sale). */
export async function solUsdOn(atMs: number | null | undefined): Promise<number | null> {
  return (await solUsdOnWithBasis(atMs))?.rate ?? null
}

// ── Prime the per-day cache from ONE range call ─────────────────────────────
// 2026-11-08: the later-set walks parked 2,273 Candy sales across 48 trade days
// (08-12 → 10-10), all `no_sol_rate`. solUsdOnWithBasis asks /history once per
// DAY, so a drain over a multi-week backlog makes dozens of calls per tick and
// CoinGecko throttles this egress after the first few; every miss is then
// negative-cached for 15 min and the sale re-parked. One /market_chart/range call
// returns the whole window.
//
// SAME BASIS, measured: /history?date=12-08-2026 answered 76.21620473970299 and
// the range series' point at 2026-08-12T00:00:00Z is 76.21620473970299 — /history
// is the 00:00 UTC snapshot. So only a point sitting EXACTLY on a day's 00:00 UTC
// (within 60 s) primes that day; a day without one is left alone and falls back
// to the per-day /history call, unchanged. Today is never primed (it has no
// settled snapshot yet — spot policy above). Returns the number of days primed;
// any failure returns 0 and changes nothing.
const DAY_MS = 86_400_000

export async function primeSolUsdHistory(fromMs: number, toMs: number = Date.now()): Promise<number> {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0
  const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS
  const from = Math.floor(fromMs / DAY_MS) * DAY_MS
  const to = Math.min(Math.floor(toMs / DAY_MS) * DAY_MS, todayStart - DAY_MS)
  if (from > to) return 0
  try {
    const resp = await fetch(
      `https://api.coingecko.com/api/v3/coins/solana/market_chart/range?vs_currency=usd&from=${Math.floor(from / 1000)}&to=${Math.floor((to + 3_600_000) / 1000)}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) }
    )
    if (!resp.ok) return 0
    const json = (await resp.json()) as { prices?: unknown }
    if (!Array.isArray(json.prices)) return 0
    let primed = 0
    for (const p of json.prices) {
      if (!Array.isArray(p) || p.length < 2) continue
      const ms = Number(p[0])
      const usd = Number(p[1])
      if (!Number.isFinite(ms) || !(usd > 0)) continue
      const dayStart = Math.floor(ms / DAY_MS) * DAY_MS
      if (ms - dayStart >= 60_000 || dayStart < from || dayStart > to) continue
      const day = new Date(dayStart).toISOString().slice(0, 10)
      if (solUsdDayCache.has(day)) continue
      solUsdDayCache.set(day, usd)
      solUsdDayMiss.delete(day)
      primed++
    }
    return primed
  } catch {
    return 0
  }
}
