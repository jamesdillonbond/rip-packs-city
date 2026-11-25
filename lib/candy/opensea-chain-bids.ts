// lib/candy/opensea-chain-bids.ts
//
// CANDY OFFERS ON OPENSEA, read key-free from the Solana chain (2026-11-24; Trevor: "Keep going" after the OpenSea
// listings lane, lib/candy/opensea-chain-listings.ts).
//
// OpenSea's Solana Marketplace Program (7Aru291A…, a Tensor-marketplace fork) keeps every open bid in a `BidState`
// account (Anchor discriminator base58 T4AJW1shazA). One getProgramAccounts returns the whole book (1,029 accounts on
// 11-24). A bid targets either ONE asset (target 0, target_id = the Core asset) or a WHITELIST (target 1 — a
// collection-wide bid). Only single-card bids fit candy_offers' grain (one row per card); collection bids are counted
// in the report and not written (11-24: 46 on 21 Candy collections, nearly all 0.0001–0.006 SOL lowballs).
//
// The bid's SOL sits in the BidState account itself. A bid is written only when the account's lamports cover
// amount × remaining quantity — a bid funded from a shared margin account cannot be confirmed here and is skipped
// (11-24: 1,007 of 1,029 accounts self-funded). Expired, filled, non-SOL and non-Candy bids are skipped.
// ⚠ 2026-11-24 (evening): the funding test counts only lamports ABOVE the account's rent-exempt minimum — rent is not
// bid money. Every BidState is 393 bytes (getProgramAccounts with and without `dataSize: 393` both return 1,101), and
// the census reads a 200-byte SLICE, so the size is a constant, never `data.length`. The minimum comes from the chain
// each run (getMinimumBalanceForRentExemption(393) = 2,646,680 on 11-24; the textbook (128 + bytes) × 6,960 formula
// gives 3,626,160 and is STALE — it briefly shipped here and would have wrongly skipped funded bids). 65 of 1,101
// accounts hold exactly the minimum, i.e. margin-funded bids with nothing escrowed; without the subtraction any such
// bid at or under ~0.0026 SOL passed. The three cheapest live offers hold exactly their bid above rent (funded).
//
// BidState layout (from the decoded accounts, 11-24): [0..8] discriminator · [8] version · [9] bump · [10..42] owner
// (bidder) · [42..74] bid id · [74] target (0 asset, 1 whitelist) · [75..107] target id · [107] field Option (+1) ·
// field id Option (+32) · quantity u32 · filled u32 · amount u64 lamports per unit · currency Option (+32) · expiry i64.
//
// Rows: candy_offers venue 'opensea', pda_address = the BidState account, price = the bid amount (what the bidder
// pays). Every active OpenSea offer this sweep did not confirm is retired, behind a plausible census. The Magic Eden
// offers lane retires only venue 'magic_eden' on absence (app/api/ingest/candy-offers, scoped 10-10); its expiry and
// unfunded passes act on positive evidence and are venue-agnostic by design. The key-based
// /api/candy-opensea-offers-indexer writes the same venue and is NOT scheduled — never schedule both.

import type { FetchFn } from "@/lib/candy/sale-buyer-paid"
import {
  CANDY_COLLECTION_UUID,
  CENSUS_RPC_URLS,
  OPENSEA_SOLANA_PROGRAM,
  RPC_TIMEOUT_MS,
  b64,
  chunk,
  encodeBase58,
} from "@/lib/candy/opensea-chain-listings"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export const BID_STATE_DISCRIMINATOR_B58 = "T4AJW1shazA"
/** Below this many BidState accounts a census is not trusted to retire anything (1,029 on 11-24). */
export const MIN_PLAUSIBLE_BID_ACCOUNTS = 200
/** Every OpenSea BidState account's size (verified on-chain 11-24: 1,101 of 1,101). The census reads a slice. */
export const BID_STATE_ACCOUNT_BYTES = 393
/** getMinimumBalanceForRentExemption(393) on 2026-11-24 — used only when the chain cannot be asked this run. */
export const BID_STATE_RENT_FALLBACK_LAMPORTS = 2_646_680

/** The chain's rent-exempt minimum for `bytes`; null when no RPC answers with a positive integer. */
export async function fetchRentExemptLamports(doFetch: FetchFn, bytes: number, urls = CENSUS_RPC_URLS): Promise<number | null> {
  for (const url of urls) {
    try {
      const r = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMinimumBalanceForRentExemption", params: [bytes] }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      })
      if (!r.ok) continue
      const j = (await r.json()) as { result?: unknown }
      if (typeof j.result === "number" && Number.isSafeInteger(j.result) && j.result > 0) return j.result
    } catch {
      // try the next RPC
    }
  }
  return null
}
const SLICE_LENGTH = 200

export interface DecodedBidState {
  pda: string
  owner: string
  /** 0 = one asset, 1 = whitelist (collection-wide). */
  target: number
  targetId: string
  quantity: number
  filled: number
  /** Lamports per unit. */
  amount: bigint
  sol: boolean
  /** Unix seconds; null when unset (≤ 0). */
  expirySec: number | null
}

/** Decode one BidState account's leading bytes; a reason string when the bytes are not a readable BidState. */
export function decodeBidState(pda: string, data: Uint8Array): DecodedBidState | string {
  if (data.length < 133) return "short"
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const owner = encodeBase58(data.subarray(10, 42))
  const target = data[74]
  if (target !== 0 && target !== 1) return "bad_target"
  const targetId = encodeBase58(data.subarray(75, 107))
  let o = 107
  const fieldTag = data[o]; o += 1
  if (fieldTag !== 0 && fieldTag !== 1) return "bad_field_tag"
  if (fieldTag === 1) o += 1
  const fieldIdTag = data[o]; o += 1
  if (fieldIdTag !== 0 && fieldIdTag !== 1) return "bad_field_id_tag"
  if (fieldIdTag === 1) o += 32
  if (o + 17 > data.length) return "short"
  const quantity = view.getUint32(o, true); o += 4
  const filled = view.getUint32(o, true); o += 4
  const amount = view.getBigUint64(o, true); o += 8
  const currencyTag = data[o]; o += 1
  if (currencyTag !== 0 && currencyTag !== 1) return "bad_currency_tag"
  if (currencyTag === 1) o += 32
  if (o + 8 > data.length) return "short"
  const expiry = Number(view.getBigInt64(o, true))
  return { pda, owner, target, targetId, quantity, filled, amount, sol: currencyTag === 0, expirySec: expiry > 0 ? expiry : null }
}

interface GpaAccount { pubkey?: string; account?: { data?: [string, string] | string[]; lamports?: number } }

/** OpenSea's whole Solana bid book. Throws on any failed or malformed answer (the caller then retires nothing). */
export async function fetchOpenSeaBidStates(doFetch: FetchFn, urls = CENSUS_RPC_URLS): Promise<{ accounts: GpaAccount[]; url: string }> {
  let last = "no rpc"
  for (const url of urls) {
    try {
      const r = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "getProgramAccounts",
          params: [OPENSEA_SOLANA_PROGRAM, {
            encoding: "base64",
            filters: [{ memcmp: { offset: 0, bytes: BID_STATE_DISCRIMINATOR_B58 } }],
            dataSlice: { offset: 0, length: SLICE_LENGTH },
          }],
        }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      })
      if (!r.ok) { last = `getProgramAccounts HTTP ${r.status} (${url})`; continue }
      const j = (await r.json()) as { result?: unknown; error?: { message?: string } }
      if (j.error) { last = `getProgramAccounts: ${j.error.message ?? "error"} (${url})`; continue }
      if (!Array.isArray(j.result)) { last = `getProgramAccounts: no result array (${url})`; continue }
      return { accounts: j.result as GpaAccount[], url }
    } catch (e) {
      last = `getProgramAccounts: ${e instanceof Error ? e.message : String(e)} (${url})`
    }
  }
  throw new Error(last)
}

export interface OpenSeaChainBidsReport {
  ok: boolean
  error: string | null
  rpc: string | null
  accounts: number
  decode_failed: number
  /** Collection-wide (whitelist) bids — counted, never written: candy_offers is one row per card. */
  collection_bids: number
  /** Single-card bids whose card is a Candy card. */
  candy_matched: number
  written: number
  skipped_not_sol: number
  skipped_expired: number
  skipped_filled: number
  /** The account's lamports do not cover amount × remaining — funded elsewhere or not at all; not confirmable. */
  skipped_unfunded: number
  skipped_no_edition: number
  /** Rent-exempt minimum subtracted from every account before the funding test, and where it came from. */
  rent_lamports: number
  rent_source: "rpc" | "fallback"
  retired: number | null
  retire_skipped: string | null
  previous_accounts: number | null
  sol_usd: number | null
}

export async function runOpenSeaChainBids(
  db: Db,
  opts: { fetchImpl?: FetchFn; now?: () => number; solUsd?: () => Promise<number | null>; urls?: string[]; previousAccounts?: number | null; rentLamports?: () => Promise<number | null> } = {},
): Promise<OpenSeaChainBidsReport> {
  const now = opts.now ?? Date.now
  const doFetch: FetchFn = opts.fetchImpl ?? ((u, i) => fetch(u, i))
  const sweepStartIso = new Date(now()).toISOString()
  const rep: OpenSeaChainBidsReport = {
    ok: false, error: null, rpc: null, accounts: 0, decode_failed: 0, collection_bids: 0, candy_matched: 0, written: 0,
    skipped_not_sol: 0, skipped_expired: 0, skipped_filled: 0, skipped_unfunded: 0, skipped_no_edition: 0,
    rent_lamports: BID_STATE_RENT_FALLBACK_LAMPORTS, rent_source: "fallback",
    retired: null, retire_skipped: null, previous_accounts: opts.previousAccounts ?? null, sol_usd: null,
  }

  // 1. The census, and the rent the funding test subtracts (see header).
  const { accounts, url } = await fetchOpenSeaBidStates(doFetch, opts.urls)
  let rentRead: number | null = null
  try { rentRead = opts.rentLamports ? await opts.rentLamports() : await fetchRentExemptLamports(doFetch, BID_STATE_ACCOUNT_BYTES, opts.urls) } catch { rentRead = null }
  if (rentRead != null && Number.isSafeInteger(rentRead) && rentRead > 0) { rep.rent_lamports = rentRead; rep.rent_source = "rpc" }
  const rent = BigInt(rep.rent_lamports)
  rep.rpc = url
  rep.accounts = accounts.length
  // `bidLamports` = the account's lamports minus its rent-exempt minimum (see header): only that can fund the bid.
  const single: Array<DecodedBidState & { bidLamports: bigint }> = []
  for (const a of accounts) {
    const pda = a.pubkey
    const data = a.account?.data?.[0]
    const held = a.account?.lamports
    if (typeof pda !== "string" || typeof data !== "string" || typeof held !== "number") { rep.decode_failed++; continue }
    const d = decodeBidState(pda, b64(data))
    if (typeof d === "string") { rep.decode_failed++; continue }
    if (d.target === 1) { rep.collection_bids++; continue }
    single.push({ ...d, bidLamports: BigInt(held) - rent })
  }

  // 2. Which target a Candy card — the census maps each Core asset id to its edition.
  const assets = [...new Set(single.map((d) => d.targetId))]
  const census = new Map<string, string | null>()
  for (const slice of chunk(assets, 200)) {
    const { data, error } = await db
      .from("wallet_moments_cache")
      .select("moment_id, edition_key")
      .eq("collection_id", CANDY_COLLECTION_UUID)
      .in("moment_id", slice)
    if (error) throw new Error(`wmc read: ${error.message}`)
    for (const r of (data ?? []) as Array<{ moment_id: string; edition_key: string | null }>) {
      if (!census.get(r.moment_id)) census.set(r.moment_id, r.edition_key)
    }
  }
  const candy = single.filter((d) => census.has(d.targetId))
  rep.candy_matched = candy.length

  const keys = [...new Set(candy.map((d) => census.get(d.targetId)).filter((k): k is string => !!k))]
  const idByKey = new Map<string, string>()
  for (const slice of chunk(keys, 200)) {
    const { data, error } = await db
      .from("editions")
      .select("id, external_id")
      .eq("collection_id", CANDY_COLLECTION_UUID)
      .in("external_id", slice)
    if (error) throw new Error(`editions read: ${error.message}`)
    for (const r of (data ?? []) as Array<{ id: string; external_id: string }>) idByKey.set(r.external_id, r.id)
  }

  // 3. Rows.
  let solRate: number | null = null
  try { solRate = opts.solUsd ? await opts.solUsd() : null } catch { solRate = null }
  rep.sol_usd = solRate
  const nowSec = Math.floor(now() / 1000)
  const nowIso = new Date(now()).toISOString()
  const rows: Record<string, unknown>[] = []
  for (const d of candy) {
    if (!d.sol) { rep.skipped_not_sol++; continue }
    if (d.expirySec !== null && d.expirySec <= nowSec) { rep.skipped_expired++; continue }
    const remaining = d.quantity - d.filled
    if (remaining <= 0) { rep.skipped_filled++; continue }
    if (d.bidLamports < d.amount * BigInt(remaining)) { rep.skipped_unfunded++; continue }
    const key = census.get(d.targetId)
    const editionId = key ? idByKey.get(key) ?? null : null
    if (!editionId) { rep.skipped_no_edition++; continue }
    const priceSol = Number(d.amount) / 1e9
    rows.push({
      pda_address: d.pda,
      token_mint: d.targetId,
      edition_id: editionId,
      collection_id: CANDY_COLLECTION_UUID,
      buyer: d.owner,
      auction_house: OPENSEA_SOLANA_PROGRAM,
      price_sol: priceSol,
      price_usd: solRate != null ? Number((priceSol * solRate).toFixed(2)) : null,
      token_size: remaining,
      expiry: d.expirySec !== null ? new Date(d.expirySec * 1000).toISOString() : null,
      last_seen_at: nowIso,
      is_active: true,
      venue: "opensea",
    })
  }
  for (const batch of chunk(rows, 100)) {
    const { error } = await db.from("candy_offers").upsert(batch, { onConflict: "pda_address" })
    if (error) throw new Error(`candy_offers upsert: ${error.message}`)
    rep.written += batch.length
  }

  // 4. Retire every active OpenSea offer this sweep did not confirm — only behind a full, plausible census.
  const prev = opts.previousAccounts ?? null
  if (rep.decode_failed > rep.accounts / 10) rep.retire_skipped = `decode_failed ${rep.decode_failed} of ${rep.accounts}`
  else if (rep.accounts < MIN_PLAUSIBLE_BID_ACCOUNTS) rep.retire_skipped = `only ${rep.accounts} accounts (< ${MIN_PLAUSIBLE_BID_ACCOUNTS})`
  else if (prev !== null && rep.accounts * 2 < prev) rep.retire_skipped = `${rep.accounts} accounts vs ${prev} last run (< half)`
  if (rep.retire_skipped === null) {
    const { count, error: upErr } = await db
      .from("candy_offers")
      .update({ is_active: false }, { count: "exact" })
      .eq("venue", "opensea")
      .eq("is_active", true)
      .lt("last_seen_at", sweepStartIso)
    if (upErr) throw new Error(`opensea offers retire: ${upErr.message}`)
    if (typeof count !== "number") throw new Error("opensea offers retire: no count returned")
    rep.retired = count
  }

  rep.ok = true
  return rep
}
