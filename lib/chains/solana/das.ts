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

/**
 * Low-level JSON-RPC call through helius-proxy. Returns the `result` field;
 * throws on a JSON-RPC `error` or a non-2xx proxy response.
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
// NOTE: this is a spot rate applied at ingest time, NOT the rate at the moment
// of each historical sale. For a thin fresh book that's acceptable; revisit
// with a per-day historical SOL/USD series if backfilling deep history.
let solUsdCache: { day: string; rate: number } | null = null

export async function solUsd(): Promise<number | null> {
  const day = new Date().toISOString().slice(0, 10)
  if (solUsdCache && solUsdCache.day === day) return solUsdCache.rate
  try {
    const resp = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { headers: { Accept: "application/json" } }
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
