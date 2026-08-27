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
// proxy). The rate is cached per UTC day; the basis is recorded honestly in the
// sale's `source` so the USD figure can be re-derived later if needed.
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
// traded, so a realized `sales` row is priced honestly even when it is ingested
// (or re-attempted by the dead-letter drain) days after the fact — the "revisit
// with a per-day historical series if backfilling deep history" follow-up.
//
// Safety: this can NEVER price a sale worse than the pre-existing spot-only path.
// A settled daily close only exists for a PAST day, so a sale from today (or a
// clock-skewed future timestamp) falls back to the live spot rate, as does ANY
// failure — rate-limit, network, or a missing field. Results are cached per UTC
// day INCLUDING negatives, so a gated/rate-limited history endpoint costs at
// most one failed call per distinct day for the lifetime of the process rather
// than one per sale.
const solUsdDayCache = new Map<string, number | null>()

// CoinGecko's /coins/{id}/history endpoint keys on a dd-mm-yyyy (UTC) date.
function coingeckoHistoryDate(atMs: number): string {
  const d = new Date(atMs)
  const dd = String(d.getUTCDate()).padStart(2, "0")
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0")
  const yyyy = d.getUTCFullYear()
  return `${dd}-${mm}-${yyyy}`
}

export async function solUsdOn(atMs: number | null | undefined): Promise<number | null> {
  // No usable timestamp → treat as "now".
  if (typeof atMs !== "number" || !Number.isFinite(atMs)) return solUsd()

  const saleDay = new Date(atMs).toISOString().slice(0, 10) // yyyy-mm-dd (UTC)
  const today = new Date().toISOString().slice(0, 10)
  // ISO yyyy-mm-dd strings order lexicographically. Today or later has no
  // settled historical close — use the live spot rate.
  if (saleDay >= today) return solUsd()

  if (solUsdDayCache.has(saleDay)) {
    // A cached null means the history endpoint was unavailable for that day;
    // fall back to spot rather than dropping the sale.
    return solUsdDayCache.get(saleDay) ?? solUsd()
  }

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
        return rate
      }
    }
  } catch {
    // fall through to the negative-cache + spot fallback below
  }
  // Negative-cache the day so we don't re-hit a gated endpoint per sale.
  solUsdDayCache.set(saleDay, null)
  return solUsd()
}
