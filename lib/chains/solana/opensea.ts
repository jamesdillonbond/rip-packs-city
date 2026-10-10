// lib/chains/solana/opensea.ts
//
// Shared OpenSea (Solana) plumbing for the three Candy MLB OpenSea feeds:
//   /api/candy-opensea-listings-indexer  (asks  → candy_listings, venue='opensea')
//   /api/candy-opensea-sales-indexer     (sales → sales, marketplace='opensea')
//   /api/candy-opensea-offers-indexer    (bids  → candy_offers, venue='opensea')
//
// Every shape here is read from OpenSea's published OpenAPI spec
// (@opensea/api-types 0.16.0, `opensea-api.json`). Their API and docs hosts are
// unreachable from the build sandbox, so nothing below was inferred from the
// Ethereum-scoped Panini route. The facts that matter:
//   · A Solana order has NO `order_hash`. It carries `svm_order` { id =
//     "creation_signature:order_state", order_state, creation_signature,
//     asset_id?, maker }. `id` is what the get-order endpoint takes.
//   · Every v2 endpoint requires the `x-api-key` header (spec security ApiKeyAuth).
//   · OpenSea AGGREGATES other Solana marketplaces' orders; the feeds dedup
//     against the Magic Eden rows (each route says how).

import { CANDY_MLB_UUID } from "@/lib/chains/solana/normalize"
import { MAGIC_EDEN_SOLANA_ESCROW } from "@/lib/chains/solana/escrow"

export const OS_BASE = "https://api.opensea.io/api/v2"
// Spec maximum `limit` on the collection listings / offers / events endpoints.
export const OS_PAGE_LIMIT = 200
// Per-request cap: `fetch()` has no default timeout, and an upstream holding a
// connection open consumes the whole lambda (the 2026-08-27 44 h Candy blackout).
export const OS_FETCH_TIMEOUT_MS = 15_000
// Pages of a holder's NFTs read while discovering the collection slug.
const DISCOVERY_PAGES = 3

/** Order statuses that are POSITIVE evidence an order is gone. */
export const OS_TERMINAL_STATUSES = new Set(["FULFILLED", "CANCELLED", "EXPIRED", "INACTIVE"])

export interface OsPrice {
  currency?: string
  decimals?: number
  value?: string
}

export interface OsSvmOrder {
  id?: string
  order_state?: string
  creation_signature?: string
  asset_id?: string
  maker?: string
}

/** The fields the Candy feeds read off a Listing or an Offer. */
export interface OsOrder {
  chain?: string
  protocol_address?: string
  protocol?: string
  status?: string
  remaining_quantity?: number
  asset?: { identifier?: string | null; contract?: string } | null
  svm_order?: OsSvmOrder
  criteria?: unknown
}

export function openSeaApiKey(): string {
  return process.env.OPENSEA_API_KEY ?? ""
}

export async function osGet(path: string, apiKey: string): Promise<{ status: number; json: any }> {
  const resp = await fetch(`${OS_BASE}${path}`, {
    headers: { Accept: "application/json", "x-api-key": apiKey },
    signal: AbortSignal.timeout(OS_FETCH_TIMEOUT_MS),
  })
  if (!resp.ok) {
    const body = (await resp.text().catch(() => "")).slice(0, 200)
    const err = new Error(`OpenSea ${path.split("?")[0]} HTTP ${resp.status}: ${body}`) as Error & { status?: number }
    err.status = resp.status
    throw err
  }
  return { status: resp.status, json: await resp.json() }
}

/**
 * Convert an OpenSea price ({ currency, decimals, value } — a listing's
 * `price.current`, an offer's `price`) to { sol, usd }. SOL is priced in
 * lamports (decimals 9); a stablecoin is USD at face value. Any other currency,
 * or a non-positive amount, returns null — the order is skipped and counted,
 * never converted by a guessed rate.
 */
export function osPrice(p: OsPrice | undefined, solRate: number | null): { sol: number | null; usd: number | null } | null {
  if (!p || p.value == null || p.decimals == null) return null
  const raw = Number(p.value)
  if (!Number.isFinite(raw) || raw <= 0) return null
  const amount = raw / Math.pow(10, p.decimals)
  const cur = String(p.currency ?? "").toUpperCase()
  if (cur === "SOL" || cur === "WSOL") {
    return { sol: amount, usd: solRate != null ? Number((amount * solRate).toFixed(2)) : null }
  }
  if (cur === "USDC" || cur === "USDT") {
    return { sol: solRate ? Number((amount / solRate).toFixed(9)) : null, usd: Number(amount.toFixed(2)) }
  }
  return null
}

/** The asset mint an OpenSea Solana order is for; null for a collection/trait offer. */
export function orderMint(o: OsOrder): string | null {
  return o.asset?.identifier || o.svm_order?.asset_id || null
}

/**
 * One order's status from the get-order endpoint, or null when it could not be
 * read. ⚠ null is NOT "gone": callers retire only on a terminal status.
 */
export async function fetchOrderStatus(protocolAddress: string, orderId: string, apiKey: string): Promise<string | null> {
  try {
    const { json } = await osGet(
      `/orders/chain/solana/protocol/${encodeURIComponent(protocolAddress)}/${encodeURIComponent(orderId)}`,
      apiKey,
    )
    const status = json?.order?.status
    return typeof status === "string" && status ? status : null
  } catch {
    return null
  }
}

export interface SlugDiscovery {
  slug: string | null
  how: "env" | "holder_match" | "no_holder" | "no_match"
  sampleUrl: string | null
}

/**
 * Find Candy MLB's OpenSea collection slug from the chain, not from a guess:
 * take a real Candy holder from wallet_moments_cache, list that wallet's NFTs on
 * OpenSea, and read `collection` off an NFT whose identifier IS one of the
 * holder's Candy mints. If OpenSea's identifier is not the mint, nothing matches
 * and discovery fails LOUDLY (the caller logs ok=false) rather than adopting a
 * slug from some other collection the wallet holds.
 * `CANDY_MLB_OPENSEA_SLUG` overrides discovery. Throws on a failed DB read.
 */
export async function discoverCandyOpenSeaSlug(db: any, apiKey: string): Promise<SlugDiscovery> {
  const pinned = process.env.CANDY_MLB_OPENSEA_SLUG?.trim()
  if (pinned) return { slug: pinned, how: "env", sampleUrl: null }

  const { data: seed, error: seedErr } = await db
    .from("wallet_moments_cache")
    .select("wallet_address")
    .eq("collection_id", CANDY_MLB_UUID)
    .neq("wallet_address", MAGIC_EDEN_SOLANA_ESCROW)
    // No ORDER BY on purpose: any real holder serves, and sorting the Candy slice
    // of wmc by last_seen_at measured 21k buffers / 4.5 s per tick (2026-10-10).
    .limit(1)
  if (seedErr) throw new Error(`slug discovery: holder read failed: ${seedErr.message}`)
  const wallet: string | undefined = seed?.[0]?.wallet_address
  if (!wallet) return { slug: null, how: "no_holder", sampleUrl: null }

  const { data: mintRows, error: mintErr } = await db
    .from("wallet_moments_cache")
    .select("moment_id")
    .eq("collection_id", CANDY_MLB_UUID)
    .eq("wallet_address", wallet)
    .limit(1000)
  if (mintErr) throw new Error(`slug discovery: holder mints read failed: ${mintErr.message}`)
  const mints = new Set(((mintRows ?? []) as Array<{ moment_id: string }>).map((r) => r.moment_id))

  let next: string | null = null
  for (let p = 0; p < DISCOVERY_PAGES; p++) {
    const qs = `limit=${OS_PAGE_LIMIT}${next ? `&next=${encodeURIComponent(next)}` : ""}`
    const { json } = await osGet(`/chain/solana/account/${encodeURIComponent(wallet)}/nfts?${qs}`, apiKey)
    for (const n of (json?.nfts ?? []) as Array<{ identifier?: string; collection?: string; opensea_url?: string }>) {
      if (n.identifier && n.collection && mints.has(n.identifier)) {
        // `opensea_url` is logged so the Solana item-page format is MEASURED, not
        // guessed, before any surface links to it.
        return { slug: n.collection, how: "holder_match", sampleUrl: n.opensea_url ?? null }
      }
    }
    next = json?.next ?? null
    if (!next) break
  }
  return { slug: null, how: "no_match", sampleUrl: null }
}

/**
 * The item-page URL OpenSea itself returns for one NFT (`nft.opensea_url` from
 * GET /chain/solana/contract/{contract}/nfts/{identifier}), or null when it
 * could not be read or is not an https opensea.io URL. RPC stores this rather
 * than BUILDING a Solana item URL, whose format it could not verify.
 */
export async function fetchOpenSeaItemUrl(contract: string, identifier: string, apiKey: string): Promise<string | null> {
  try {
    const { json } = await osGet(
      `/chain/solana/contract/${encodeURIComponent(contract)}/nfts/${encodeURIComponent(identifier)}`,
      apiKey,
    )
    const url = json?.nft?.opensea_url
    return typeof url === "string" && /^https:\/\/([a-z0-9-]+\.)?opensea\.io\//i.test(url) ? url : null
  } catch {
    return null
  }
}
