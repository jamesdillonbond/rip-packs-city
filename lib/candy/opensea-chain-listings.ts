// lib/candy/opensea-chain-listings.ts
//
// CANDY LISTINGS ON OPENSEA, read straight from the chain — no OpenSea API key (2026-11-23; Trevor: "Option 2 for
// now", i.e. the key-free route over requesting a permanent OpenSea key).
//
// Why. Program 7Aru291A64wrTkUDaRv6HqxVBre6ivXWL94cUoCtQF9V — the one the candy-chain-sales lane has decoded fills on
// since 11-22 as `solana_7aru` — is OpenSea's Solana Marketplace Program (named in OpenSea's own Bugcrowd bounty scope,
// found 11-23). Its fills were ~half of Candy's sale dollars in the week to 11-23 (98 sales / $4,376 vs Magic Eden
// 182 / $4,670), yet RPC held none of its ASKS: every ask in candy_listings came from Magic Eden's API. So OpenSea-only
// asks never reached the confirmed floor, the FMV ask cap, "% listed" or the squeeze boards.
//
// How — a CENSUS, not an event walk. The program is built from Tensor's open-source marketplace, so every live listing is
// one `ListState` account it owns (Anchor discriminator sha256("account:ListState")[0..8]). One getProgramAccounts with
// that memcmp returns OpenSea's ENTIRE live Solana book (13,406 accounts, ~2 MB, read 11-23 8:50 PM PT), so the set of
// accounts IS the set of live listings: an account present = listed; absent = delisted, sold or expired. Each account is
// decoded (owner, asset, price, currency, expiry), the assets that are Candy cards are matched through the census
// (wallet_moments_cache.moment_id = the Core asset id), and written to candy_listings with venue 'opensea' and the
// ListState account as pda_address. Active OpenSea rows this sweep did not confirm are retired.
//
// ⚠ A ListState ACCOUNT IS NOT A LIVE LISTING. The program ESCROWS the asset: a live listing's Core asset is OWNED BY
// its ListState account. 11-23 positive control on 40 Candy listings: 26 assets owned by their ListState, 10 back in a
// plain wallet, 2 in Magic Eden's escrow, 2 burned — so ~1 in 3 ListState accounts is an orphan whose card moved on
// (delisting does not always close the account). Every candidate is therefore confirmed by reading the asset account
// itself (getMultipleAccounts, owner at bytes [1..33]) and written only when that owner IS the ListState. The census
// owner (wallet_moments_cache.wallet_address) cannot answer this — it never sees the escrow — so it is not used.
//
// Layout (Tensor marketplace ListState, Borsh): [0..8] discriminator · [8] version · [9] bump · [10..42] owner ·
// [42..74] asset_id · [74..82] amount (u64 lamports) · [82] currency Option tag (+32 if Some) · expiry (i64 seconds) ·
// private_taker Option · maker_broker Option · rent_payer … Only SOL-priced listings (currency None) are written; a
// private listing (private_taker Some) is a sale to one named buyer, not a public ask, and is skipped.
//
// Honesty:
//  - Retirement runs ONLY behind a census that answered in full and is plausible (≥ MIN_PLAUSIBLE_ACCOUNTS accounts and
//    ≥ half the previous run's count when one is recorded); otherwise nothing is retired and the run says why.
//  - A listing whose asset is not in its ListState's escrow is skipped (an orphan account: the ask is dead); a failed
//    asset read fails the run, so no unconfirmed ask is written and none is retired. A Candy asset the census has not reached cannot be told apart from a non-Candy asset and is not written — the
//    census covers ~94–100 % of Candy items, so this under-counts, never invents.
//  - price_usd = listed SOL × the SOL rate: on this venue the seller pays the fees, so the buyer pays the listed price
//    (the chain-sales lane measured buyer-paid = listed on every decoded fill). No rate → price_usd NULL (the row stays
//    out of every USD floor rather than carrying a guessed dollar figure).
//  - Tensor's own program (TCMPhJ…) is NOT censused here: 106,271 live listings (~24 MB of envelopes alone, 11-23) for
//    ~1 Candy fill a week. Recorded as a gap, not hidden.
//  - The key-based route app/api/candy-opensea-listings-indexer (OpenSea API, 10-10) writes the same venue and is NOT
//    scheduled (no OPENSEA_API_KEY). This lane retires every OpenSea row it did not confirm, so never schedule both.
//  - No OpenSea item URL is built (venue_url stays NULL — the estate's rule: RPC never builds a Solana OpenSea URL), so
//    readers show the ask with no buy link; the edition CTA deep-links Magic Eden asks only.

import type { FetchFn } from "@/lib/candy/sale-buyer-paid"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export const OPENSEA_SOLANA_PROGRAM = "7Aru291A64wrTkUDaRv6HqxVBre6ivXWL94cUoCtQF9V"
export const CANDY_COLLECTION_UUID = "209ade70-32c5-4470-bc7c-4793d660f713"
/** base58 of sha256("account:ListState")[0..8] (Anchor), the memcmp filter at offset 0. */
export const LIST_STATE_DISCRIMINATOR_B58 = "ECt8xkbczt2"
/** The first bytes of a ListState that the decoder needs (through maker_broker at its widest). */
const SLICE_LENGTH = 200
/** The full book read 13,406 on 11-23; fewer than this is a partial or failed answer, never "everything delisted". */
export const MIN_PLAUSIBLE_ACCOUNTS = 1000
// mainnet-beta answered this census from Supabase on 11-23; publicnode is the fallback.
export const CENSUS_RPC_URLS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"]
const RPC_TIMEOUT_MS = 60_000

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

/** Base58 (Bitcoin alphabet) of a byte array — Solana's public-key encoding. Pure. */
export function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  const digits: number[] = []
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let out = "1".repeat(zeros)
  for (let k = digits.length - 1; k >= 0; k--) out += B58[digits[k]]
  return out
}

export interface DecodedListState {
  pda: string
  owner: string
  asset: string
  lamports: bigint
  /** True when the listing is priced in SOL (currency None). */
  sol: boolean
  /** Unix seconds; null when unset (≤ 0). */
  expirySec: number | null
  /** A listing reserved for one named buyer. */
  privateTaker: boolean
}

/** Decode one ListState account's leading bytes. Returns a reason string when the bytes are not a readable ListState. */
export function decodeListState(pda: string, data: Uint8Array): DecodedListState | string {
  if (data.length < 91) return "short"
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let o = 8
  o += 2 // version, bump
  const owner = encodeBase58(data.subarray(o, o + 32)); o += 32
  const asset = encodeBase58(data.subarray(o, o + 32)); o += 32
  const lamports = view.getBigUint64(o, true); o += 8
  const currencyTag = data[o]; o += 1
  if (currencyTag !== 0 && currencyTag !== 1) return "bad_currency_tag"
  if (currencyTag === 1) o += 32
  if (o + 9 > data.length) return "short"
  const expiry = Number(view.getBigInt64(o, true)); o += 8
  const ptTag = data[o]
  if (ptTag !== 0 && ptTag !== 1) return "bad_private_taker_tag"
  return {
    pda,
    owner,
    asset,
    lamports,
    sol: currencyTag === 0,
    expirySec: expiry > 0 ? expiry : null,
    privateTaker: ptTag === 1,
  }
}

function b64(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "base64"))
}

interface GpaAccount { pubkey?: string; account?: { data?: [string, string] | string[] } }

/** OpenSea's whole live Solana book. Throws on any failed or malformed answer (the caller then retires nothing). */
export async function fetchOpenSeaListStates(doFetch: FetchFn, urls = CENSUS_RPC_URLS): Promise<{ accounts: GpaAccount[]; url: string }> {
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
            filters: [{ memcmp: { offset: 0, bytes: LIST_STATE_DISCRIMINATOR_B58 } }],
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

const chunk = <T,>(xs: T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/**
 * Current owner of each Core asset (bytes [1..33] of the account; key byte 1 = AssetV1). Missing / non-Core accounts
 * are absent from the map. Throws on a failed or malformed answer — an unconfirmed escrow must not be written.
 */
export async function fetchAssetOwners(doFetch: FetchFn, assets: string[], url: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const slice of chunk(assets, 100)) {
    const r = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "getMultipleAccounts",
        params: [slice, { encoding: "base64", dataSlice: { offset: 0, length: 33 } }],
      }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    })
    if (!r.ok) throw new Error(`getMultipleAccounts HTTP ${r.status}`)
    const j = (await r.json()) as { result?: { value?: unknown }; error?: { message?: string } }
    if (j.error) throw new Error(`getMultipleAccounts: ${j.error.message ?? "error"}`)
    const value = j.result?.value
    if (!Array.isArray(value) || value.length !== slice.length) throw new Error("getMultipleAccounts: malformed result")
    value.forEach((acc, i) => {
      const data = (acc as { data?: string[] } | null)?.data?.[0]
      if (typeof data !== "string") return
      const bytes = b64(data)
      if (bytes.length < 33 || bytes[0] !== 1) return
      out.set(slice[i], encodeBase58(bytes.subarray(1, 33)))
    })
  }
  return out
}

export interface OpenSeaChainListingsReport {
  ok: boolean
  error: string | null
  rpc: string | null
  accounts: number
  decode_failed: number
  candy_matched: number
  written: number
  skipped_not_sol: number
  skipped_private: number
  skipped_expired: number
  /** The asset is no longer owned by its ListState account — an orphan, not a live ask. */
  skipped_not_escrowed: number
  /** The asset account does not exist (burned) or is not a Core asset. */
  skipped_asset_unreadable: number
  /** A Candy card the census has not given an edition (edition_key missing or unknown). */
  skipped_no_edition: number
  retired: number | null
  /** Why retirement did not run, when it did not. */
  retire_skipped: string | null
  previous_accounts: number | null
  sol_usd: number | null
}

export async function runOpenSeaChainListings(
  db: Db,
  opts: { fetchImpl?: FetchFn; now?: () => number; solUsd?: () => Promise<number | null>; urls?: string[]; previousAccounts?: number | null } = {},
): Promise<OpenSeaChainListingsReport> {
  const now = opts.now ?? Date.now
  const doFetch: FetchFn = opts.fetchImpl ?? ((u, i) => fetch(u, i))
  const sweepStartIso = new Date(now()).toISOString()
  const rep: OpenSeaChainListingsReport = {
    ok: false, error: null, rpc: null, accounts: 0, decode_failed: 0, candy_matched: 0, written: 0,
    skipped_not_sol: 0, skipped_private: 0, skipped_expired: 0, skipped_not_escrowed: 0, skipped_asset_unreadable: 0, skipped_no_edition: 0,
    retired: null, retire_skipped: null, previous_accounts: opts.previousAccounts ?? null, sol_usd: null,
  }

  // 1. The census.
  const { accounts, url } = await fetchOpenSeaListStates(doFetch, opts.urls)
  rep.rpc = url
  rep.accounts = accounts.length
  const decoded: DecodedListState[] = []
  const allPdas = new Set<string>()
  for (const a of accounts) {
    const pda = a.pubkey
    const data = a.account?.data?.[0]
    if (typeof pda !== "string" || typeof data !== "string") { rep.decode_failed++; continue }
    allPdas.add(pda)
    const d = decodeListState(pda, b64(data))
    if (typeof d === "string") { rep.decode_failed++; continue }
    decoded.push(d)
  }

  // 2. Which are Candy cards — the census maps each Core asset id to its edition and current owner.
  const assets = [...new Set(decoded.map((d) => d.asset))]
  const census = new Map<string, { edition_key: string | null }>()
  for (const slice of chunk(assets, 200)) {
    const { data, error } = await db
      .from("wallet_moments_cache")
      .select("moment_id, edition_key")
      .eq("collection_id", CANDY_COLLECTION_UUID)
      .in("moment_id", slice)
    if (error) throw new Error(`wmc read: ${error.message}`)
    for (const r of (data ?? []) as Array<{ moment_id: string; edition_key: string | null }>) {
      const prev = census.get(r.moment_id)
      if (!prev || (!prev.edition_key && r.edition_key)) census.set(r.moment_id, { edition_key: r.edition_key })
    }
  }
  const candy = decoded.filter((d) => census.has(d.asset))
  rep.candy_matched = candy.length

  const keys = [...new Set(candy.map((d) => census.get(d.asset)?.edition_key).filter((k): k is string => !!k))]
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

  // 3. Escrow check — the asset's on-chain owner must be the ListState account (see header). Throws on a failed read.
  const owners = await fetchAssetOwners(doFetch, [...new Set(candy.map((d) => d.asset))], url)

  // 4. Rows.
  let solRate: number | null = null
  try { solRate = opts.solUsd ? await opts.solUsd() : null } catch { solRate = null }
  rep.sol_usd = solRate
  const nowSec = Math.floor(now() / 1000)
  const rows: Record<string, unknown>[] = []
  for (const d of candy) {
    const c = census.get(d.asset)!
    if (!d.sol) { rep.skipped_not_sol++; continue }
    if (d.privateTaker) { rep.skipped_private++; continue }
    if (d.expirySec !== null && d.expirySec <= nowSec) { rep.skipped_expired++; continue }
    const chainOwner = owners.get(d.asset)
    if (!chainOwner) { rep.skipped_asset_unreadable++; continue }
    if (chainOwner !== d.pda) { rep.skipped_not_escrowed++; continue }
    const editionId = c.edition_key ? idByKey.get(c.edition_key) ?? null : null
    if (!editionId) { rep.skipped_no_edition++; continue }
    const priceSol = Number(d.lamports) / 1e9
    rows.push({
      pda_address: d.pda,
      token_mint: d.asset,
      edition_id: editionId,
      collection_id: CANDY_COLLECTION_UUID,
      seller: d.owner,
      auction_house: OPENSEA_SOLANA_PROGRAM,
      price_sol: priceSol,
      price_usd: solRate != null ? Number((priceSol * solRate).toFixed(2)) : null,
      token_size: 1,
      expiry: d.expirySec !== null ? new Date(d.expirySec * 1000).toISOString() : null,
      last_seen_at: new Date(now()).toISOString(),
      is_active: true,
      venue: "opensea",
    })
  }
  for (const batch of chunk(rows, 100)) {
    const { error } = await db.from("candy_listings").upsert(batch, { onConflict: "pda_address" })
    if (error) throw new Error(`candy_listings upsert: ${error.message}`)
    rep.written += batch.length
  }

  // 5. Retire every active OpenSea ask this sweep did not confirm (account gone, orphaned, expired or moved) — only
  //    behind a full, plausible census. Rows written above carry last_seen_at = now ≥ sweepStart, so they are untouched.
  const prev = opts.previousAccounts ?? null
  if (rep.decode_failed > rep.accounts / 10) rep.retire_skipped = `decode_failed ${rep.decode_failed} of ${rep.accounts}`
  else if (rep.accounts < MIN_PLAUSIBLE_ACCOUNTS) rep.retire_skipped = `only ${rep.accounts} accounts (< ${MIN_PLAUSIBLE_ACCOUNTS})`
  else if (prev !== null && rep.accounts * 2 < prev) rep.retire_skipped = `${rep.accounts} accounts vs ${prev} last run (< half)`
  if (rep.retire_skipped === null) {
    const { count, error: upErr } = await db
      .from("candy_listings")
      .update({ is_active: false }, { count: "exact" })
      .eq("venue", "opensea")
      .eq("is_active", true)
      .lt("last_seen_at", sweepStartIso)
    if (upErr) throw new Error(`opensea retire: ${upErr.message}`)
    if (typeof count !== "number") throw new Error("opensea retire: no count returned")
    rep.retired = count
  }

  rep.ok = true
  return rep
}
