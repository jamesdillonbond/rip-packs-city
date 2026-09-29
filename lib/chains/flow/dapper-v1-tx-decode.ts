// ── V1 Dapper NFTStorefront tx decoder ───────────────────────────────────────
//
// The V1 contract (A.4eb8a10cb9f87357.NFTStorefront) emits ListingCompleted
// events with a reduced payload — only listingResourceID, storefrontResourceID,
// purchased, nftType, nftID. Price, buyer, and seller must be recovered by
// fetching the full transaction and parsing three auxiliary events:
//
//   - <collection>.Deposit (.id, .to)     → buyer
//   - <collection>.Withdraw (.id, .from)  → seller
//   - DapperUtilityCoin.TokensWithdrawn   → gross payment (from = DUC contract)
//
// Dapper splits the buyer's payment via TokenForwarding into multiple downstream
// TokensWithdrawn events (seller cut, royalty, etc.). Only the events emitted
// directly from the DUC contract address `0xead892083b3e2c6c` represent the
// gross payment; downstream splits have `from = null`. Summing the contract-
// sourced amounts gives the gross. As a sanity check we sum the split amounts
// and require they match within 1¢; a mismatch flags the tx as uncertain so
// it can be sidelined to unmapped_sales for offline investigation rather than
// recording a bad price.

const FLOW_REST = "https://rest-mainnet.onflow.org"
const DUC_TOKENS_WITHDRAWN = "A.ead892083b3e2c6c.DapperUtilityCoin.TokensWithdrawn"
const DUC_CONTRACT_ADDRESS = "0xead892083b3e2c6c"
const PRICE_TOLERANCE = 0.01

function unwrapCdc(node: unknown): unknown {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(unwrapCdc)
  if (typeof node !== "object") return node
  const { type, value } = node as { type?: string; value?: unknown }
  if (type !== undefined && value !== undefined) {
    switch (type) {
      case "Optional":
        return value === null ? null : unwrapCdc(value)
      case "Array":
        return (value as unknown[]).map(unwrapCdc)
      case "Dictionary": {
        const out: Record<string, unknown> = {}
        for (const kv of value as Array<{ key: unknown; value: unknown }>) {
          out[String(unwrapCdc(kv.key))] = unwrapCdc(kv.value)
        }
        return out
      }
      case "Struct":
      case "Resource":
      case "Event":
      case "Contract":
      case "Enum": {
        const out: Record<string, unknown> = {}
        const fields = (value as { fields?: Array<{ name: string; value: unknown }> }).fields ?? []
        for (const f of fields) out[f.name] = unwrapCdc(f.value)
        return out
      }
      case "Type":
        return { staticType: (value as { staticType?: unknown }).staticType }
      default:
        return value
    }
  }
  return node
}

/**
 * Deposit targets that are CUSTODIANS, not buyers.
 *
 * ⛔ THIS IS NOT A NEW DECISION — it is a 2026-07-19 decision finally written where
 * a writer will see it. That day's handoff, on the counterparty-recovery worker:
 *
 *   "Set `buyer` to NULL for AllDay/UFC. Those collections deposit to a constant
 *    Dapper custodian (0xddfbe848a81b2236), so writing it as the buyer would be a
 *    LIE. Seller only."
 *
 * and the ledger for the same ship: the custodian "re-forwards to the real buyer in a
 * LATER tx", so `<collection>.Deposit.to` names the custodian, never the person.
 *
 * 🚨 THAT RULING REACHED THE RECOVERY WORKER AND NEVER REACHED THIS DECODER, which is
 * the primary sale path. Measured 2026-09-11 (register #83): 9,486 All Day sales
 * across 62 days and 1,819 editions carry the custodian in `buyer_address`, written
 * by `onchain_dapper_v2` (6,482) and `onchain_dapper_v1` (2,997) — the two lanes fed
 * from here. It is intermittent (a rare tx shape), it fell ~97% after July, and it is
 * not over: 561 rows on 09-10 alone, 511 of them ingested in REAL TIME.
 *
 * ⭐ WHY THIS IS A CONSTANT AND NOT A COMMENT: a decision recorded in prose reaches the
 * session that wrote it and nothing else. The address lived only in a handoff and a
 * ledger entry, which is exactly why one writer inherited the rule and the other did
 * not. A named constant is what makes it binding on the NEXT writer.
 *
 * ⚠ SCOPE, measured rather than assumed. Only All Day is affected today: UFC has no
 * buyer rows at all, and LaLiga Golazos' buyers are organically distributed (top
 * wallet 197 buys, then 62/57/54 — no custodial concentration). Top Shot deposits to
 * the REAL buyer and is decoded by `decodeTopShotSaleTx` below, which is untouched.
 * ⚠ Add an address here only with evidence; a wrong entry silently NULLs real buyers.
 */
const CUSTODIAL_DEPOSIT_TARGETS: ReadonlySet<string> = new Set([
  "0xddfbe848a81b2236", // NFL All Day — constant Dapper custodian, re-forwards later
])

/** True when a `Deposit.to` names a custodian rather than a person. Hex-normalised. */
export function isCustodialDepositTarget(addr: string): boolean {
  return CUSTODIAL_DEPOSIT_TARGETS.has(normHex(addr))
}

export interface V1TxDecodeConfig {
  depositEventType: string
  withdrawEventType: string
  nftId: string
}

export type PriceReason =
  | "matched"
  | "matched_no_splits"
  | "no_duc_from_contract"
  | "split_sum_mismatch"
  | "tx_fetch_failed"
  | "tx_no_events"

export interface V1TxDecodeResult {
  buyer: string | null
  seller: string | null
  priceDuc: number | null
  priceCertain: boolean
  priceReason: PriceReason
  sampleAmounts: number[]
}

export async function decodeV1SaleTx(
  txId: string,
  config: V1TxDecodeConfig,
  fetchTimeoutMs = 8000,
): Promise<V1TxDecodeResult> {
  const result: V1TxDecodeResult = {
    buyer: null,
    seller: null,
    priceDuc: null,
    priceCertain: false,
    priceReason: "tx_fetch_failed",
    sampleAmounts: [],
  }

  try {
    const clean = txId.replace(/^0x/, "")
    const res = await fetch(`${FLOW_REST}/v1/transaction_results/${clean}`, {
      signal: AbortSignal.timeout(fetchTimeoutMs),
    })
    if (!res.ok) {
      result.priceReason = "tx_fetch_failed"
      return result
    }
    const json = (await res.json()) as {
      events?: Array<{ type: string; payload: string; event_index: number }>
    }
    const events = json.events ?? []
    if (events.length === 0) {
      result.priceReason = "tx_no_events"
      return result
    }

    let grossSum = 0
    let splitSum = 0
    let grossCount = 0
    const allDucAmounts: number[] = []

    for (const evt of events) {
      let payload: Record<string, any> | null = null
      try {
        const raw = JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))
        payload = unwrapCdc(raw) as Record<string, any>
      } catch {
        continue
      }
      if (!payload) continue

      if (evt.type === config.depositEventType) {
        if (String(payload.id) === config.nftId) {
          const to = payload.to
          if (typeof to === "string" && to.length > 0) {
            // ⛔ A CUSTODIAL deposit target is NOT the buyer, and this repo already
            // decided that in writing. See CUSTODIAL_DEPOSIT_TARGETS below.
            result.buyer = isCustodialDepositTarget(to) ? null : to
          }
        }
        continue
      }
      if (evt.type === config.withdrawEventType) {
        if (String(payload.id) === config.nftId) {
          const from = payload.from
          if (typeof from === "string" && from.length > 0) result.seller = from
        }
        continue
      }
      if (evt.type === DUC_TOKENS_WITHDRAWN) {
        const amount = parseFloat(String(payload.amount ?? "0"))
        if (!Number.isFinite(amount) || amount <= 0) continue
        allDucAmounts.push(amount)
        const from = payload.from
        if (typeof from === "string" && from === DUC_CONTRACT_ADDRESS) {
          grossSum += amount
          grossCount += 1
        } else {
          splitSum += amount
        }
        continue
      }
    }

    result.sampleAmounts = allDucAmounts

    if (grossSum === 0) {
      result.priceReason = "no_duc_from_contract"
      return result
    }
    if (splitSum > 0 && Math.abs(splitSum - grossSum) > PRICE_TOLERANCE) {
      result.priceReason = "split_sum_mismatch"
      return result
    }

    result.priceDuc = grossSum
    result.priceCertain = true
    result.priceReason = splitSum === 0 ? "matched_no_splits" : "matched"
    return result
  } catch {
    return result
  }
}

// ── Multi-NFT V1 Dapper tx: price PER NFT ────────────────────────────────────
//
// decodeV1SaleTx returns the transaction's GROSS DUC, which is one NFT's price
// only when the tx moved one NFT. A cart purchase of several moments in one tx
// (6,292 two-NFT + 3,585 three-NFT + 31 four-NFT All Day txs were parked as
// "unsplittable" on 2026-09-28, ~23.5k rows) was treated as unpriceable.
//
// ⭐ It is splittable, because each listing is purchased in its own block of
// events, in order. Measured on real txs (fixtures in
// __tests__/fixtures/flow-v1-multi/):
//
//   ListingAvailable(nftID)
//   DapperUtilityCoin.TokensWithdrawn(amount, from = DUC contract)   ← THIS listing's gross
//   <collection>.Withdraw(id, from = seller)
//   DapperUtilityCoin.TokensWithdrawn(amount, from = null)           ← downstream split(s)
//   …TokenForwarding / Deposits…
//   NFTStorefront.ListingCompleted(nftID, purchased = true)          ← closes the block
//   <collection>.Deposit(id, to = buyer)
//
// So walking events by event_index and cutting a segment at every
// ListingCompleted attributes each contract-sourced payment to the NFT whose
// listing it paid for — e.g. $0.67 / $0.67 / $0.66 in one tx, not "$2.00 / 3".
//
// ⛔ CONSERVATIVE BY CONSTRUCTION — a guess here becomes a `sales` row, i.e.
// FMV input. A segment's price is certain ONLY when it holds exactly ONE
// contract-sourced payment and its downstream splits match it (the same 1¢
// rule as the single decoder). And the whole tx must reconcile: every
// contract-sourced payment in the tx must land in some purchased segment, or
// NOTHING in the tx is certain (a payment outside every listing block means
// the shape is not the one this relies on).

export const V1_LISTING_COMPLETED = "A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted"

export type MultiPriceReason =
  | "matched"
  | "matched_no_splits"
  | "segment_gross_count" // 0 or >1 contract-sourced payments in the segment
  | "split_sum_mismatch"
  | "unattributed_payment" // tx-level: a payment outside every purchased segment
  | "duplicate_nft_in_tx"
  | "tx_fetch_failed"
  | "tx_no_events"

export interface V1MultiNftPrice {
  priceDuc: number | null
  priceCertain: boolean
  priceReason: MultiPriceReason
  buyer: string | null
  seller: string | null
}

export interface V1MultiDecodeResult {
  ok: boolean
  reason: MultiPriceReason | "ok"
  /** Per purchased NFT of `nftType` in the tx, keyed by nftID. */
  perNft: Map<string, V1MultiNftPrice>
}

type RawEvent = { type: string; payload: string; event_index: number }

/** Pure: attribute each purchased listing's payment to its NFT. Exported for tests. */
export function attributeV1MultiSalePrices(
  events: RawEvent[],
  config: { depositEventType: string; withdrawEventType: string; nftType: string },
): V1MultiDecodeResult {
  const out: V1MultiDecodeResult = { ok: false, reason: "tx_no_events", perNft: new Map() }
  if (events.length === 0) return out

  const sorted = [...events].sort((a, b) => a.event_index - b.event_index)
  const buyers = new Map<string, string | null>()
  const sellers = new Map<string, string>()
  let seg = { gross: 0, grossCount: 0, split: 0 }
  let txGross = 0
  let attributedGross = 0
  const seen = new Set<string>()
  const dup = new Set<string>()

  for (const evt of sorted) {
    let p: Record<string, any> | null = null
    try {
      p = unwrapCdc(JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))) as Record<string, any>
    } catch {
      continue
    }
    if (!p) continue

    if (evt.type === DUC_TOKENS_WITHDRAWN) {
      const amount = parseFloat(String(p.amount ?? "0"))
      if (!Number.isFinite(amount) || amount <= 0) continue
      if (typeof p.from === "string" && p.from === DUC_CONTRACT_ADDRESS) {
        seg.gross += amount
        seg.grossCount += 1
        txGross += amount
      } else {
        seg.split += amount
      }
      continue
    }
    if (evt.type === config.depositEventType) {
      const to = p.to
      if (typeof to === "string" && to.length > 0) buyers.set(String(p.id), isCustodialDepositTarget(to) ? null : to)
      continue
    }
    if (evt.type === config.withdrawEventType) {
      const from = p.from
      if (typeof from === "string" && from.length > 0) sellers.set(String(p.id), from)
      continue
    }
    if (evt.type === V1_LISTING_COMPLETED) {
      const typeId = (p.nftType as { staticType?: { typeID?: string } } | undefined)?.staticType?.typeID
      const nftId = p.nftID != null ? String(p.nftID) : null
      if (p.purchased === true && nftId && typeId === config.nftType) {
        if (seen.has(nftId)) dup.add(nftId)
        seen.add(nftId)
        const certain =
          seg.grossCount === 1 && (seg.split === 0 || Math.abs(seg.split - seg.gross) <= PRICE_TOLERANCE)
        const reason: MultiPriceReason =
          seg.grossCount !== 1 ? "segment_gross_count"
          : !certain ? "split_sum_mismatch"
          : seg.split === 0 ? "matched_no_splits" : "matched"
        out.perNft.set(nftId, {
          priceDuc: certain ? Math.round(seg.gross * 1e8) / 1e8 : null,
          priceCertain: certain,
          priceReason: reason,
          buyer: null,
          seller: null,
        })
        attributedGross += seg.gross
      } else if (p.purchased === true) {
        // Another collection's purchase in the same tx consumed this segment's
        // payment — count it as attributed so the tx still reconciles.
        attributedGross += seg.gross
      }
      seg = { gross: 0, grossCount: 0, split: 0 }
      continue
    }
  }

  for (const [nftId, r] of out.perNft) {
    r.buyer = buyers.has(nftId) ? buyers.get(nftId)! : null
    r.seller = sellers.get(nftId) ?? null
    if (dup.has(nftId)) {
      r.priceDuc = null
      r.priceCertain = false
      r.priceReason = "duplicate_nft_in_tx"
    }
  }

  // Tx-level reconciliation: a contract-sourced payment that no purchased
  // listing closed over means the event shape is not the one relied on.
  if (Math.abs(txGross - attributedGross) > PRICE_TOLERANCE) {
    for (const r of out.perNft.values()) {
      r.priceDuc = null
      r.priceCertain = false
      r.priceReason = "unattributed_payment"
    }
    out.reason = "unattributed_payment"
    return out
  }
  out.ok = true
  out.reason = "ok"
  return out
}

/** Fetch a V1 tx and attribute each purchased NFT's price. Never throws. */
export async function decodeV1MultiSaleTx(
  txId: string,
  config: { depositEventType: string; withdrawEventType: string; nftType: string },
  fetchTimeoutMs = 8000,
): Promise<V1MultiDecodeResult> {
  try {
    const clean = txId.replace(/^0x/, "")
    const res = await fetch(`${FLOW_REST}/v1/transaction_results/${clean}`, {
      signal: AbortSignal.timeout(fetchTimeoutMs),
    })
    if (!res.ok) return { ok: false, reason: "tx_fetch_failed", perNft: new Map() }
    const json = (await res.json()) as { events?: RawEvent[] }
    return attributeV1MultiSalePrices(json.events ?? [], config)
  } catch {
    return { ok: false, reason: "tx_fetch_failed", perNft: new Map() }
  }
}

// ── Top Shot sale tx decoder (buyer + execution accounts) ────────────────────
//
// The TopShotMarketV3.MomentPurchased event carries id/price/seller but NOT the
// buyer — the buyer is the recipient of the moment, which on Flow requires no
// signature. We recover it from the same transaction's TopShot.Deposit (.to),
// mirroring the AllDay V1 buyer decode. In the SAME fetch we also capture the
// transaction's execution accounts (payer = gas, proposer = sequence) — the
// fields that distinguish a custodial front-end like dapper.market from a direct
// buyer, and the signal a new-venue monitor watches. Using
// /v1/transactions/{id}?expand=result gives both the envelope and the events in
// one round-trip.
//
// Verified 2026-06-09 against a live TS sale: TopShot.Deposit{id,to},
// TopShot.Withdraw{id,from}; payer/proposer come from the tx envelope without a
// 0x prefix, the event addresses with one — both normalized to 0x16hex here.

const TOPSHOT_DEPOSIT_EVENT = "A.0b2a3299cc857e29.TopShot.Deposit"
const TOPSHOT_WITHDRAW_EVENT = "A.0b2a3299cc857e29.TopShot.Withdraw"

function normHex(addr: string): string {
  const h = addr.trim().toLowerCase().replace(/^0x/, "")
  return "0x" + h
}

export interface TopShotSaleTxDecode {
  buyer: string | null
  seller: string | null
  payer: string | null
  proposer: string | null
  ok: boolean
  /**
   * HTTP status of the upstream lookup when one was made, else null.
   *
   * ⚠ ADDED 2026-08-29 BECAUSE `ok: false` CONFLATED THREE ANSWERS THAT NEED
   * OPPOSITE RESPONSES, and the spork path's own comment named all three before
   * treating them identically: a **404** (the transaction predates mainnet19 —
   * genuinely unresolvable, stop asking), an **auth failure** (401/403 — the
   * `SPORK_PROXY_SECRET` is wrong or expired), and a **5xx** (the proxy is down —
   * retry later).
   *
   * Measured that day: `topshot-buyer-backfill-historical` ran 36 times at
   * `decode_failed` = `rows_found` = 100%, writing zero rows, reporting `ok: true`
   * — and NOTHING in the row could say which of the three it was. The era-floor
   * reading was only establishable from OUTSIDE, by noticing the failure rate
   * tracked the cursor's DATE (0% above 2023-11-17, 29.8% across 11-08→11-17,
   * 100% below 11-08) rather than wall-clock. An auth failure would have flipped
   * at a time instead, and would have looked identical in every logged field.
   *
   * ⛔ Optional and additive on purpose: every existing caller destructures only
   * buyer/seller/payer/proposer and is unaffected.
   */
  status?: number | null
}

// Shared parser for the /v1/transactions/{id}?expand=result envelope — used by
// both the current-mainnet decode and the historical spork-proxy decode so the
// buyer/seller/payer/proposer extraction stays identical.
function parseTopShotSaleTxJson(
  json: {
    payer?: string
    proposal_key?: { address?: string }
    result?: { events?: Array<{ type: string; payload: string }> }
  },
  nftId: string,
): TopShotSaleTxDecode {
  const out: TopShotSaleTxDecode = { buyer: null, seller: null, payer: null, proposer: null, ok: false }
  if (json.payer) out.payer = normHex(json.payer)
  if (json.proposal_key?.address) out.proposer = normHex(json.proposal_key.address)

  const events = json.result?.events ?? []
  for (const evt of events) {
    if (evt.type !== TOPSHOT_DEPOSIT_EVENT && evt.type !== TOPSHOT_WITHDRAW_EVENT) continue
    let payload: Record<string, any> | null = null
    try {
      const raw = JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))
      payload = unwrapCdc(raw) as Record<string, any>
    } catch {
      continue
    }
    if (!payload || String(payload.id) !== nftId) continue
    if (evt.type === TOPSHOT_DEPOSIT_EVENT) {
      const to = payload.to
      if (typeof to === "string" && to.length > 0) out.buyer = normHex(to)
    } else {
      const from = payload.from
      if (typeof from === "string" && from.length > 0) out.seller = normHex(from)
    }
  }
  out.ok = true
  return out
}

export async function decodeTopShotSaleTx(
  txId: string,
  nftId: string,
  fetchTimeoutMs = 8000,
): Promise<TopShotSaleTxDecode> {
  const out: TopShotSaleTxDecode = { buyer: null, seller: null, payer: null, proposer: null, ok: false }
  try {
    const clean = txId.replace(/^0x/, "")
    const res = await fetch(`${FLOW_REST}/v1/transactions/${clean}?expand=result`, {
      signal: AbortSignal.timeout(fetchTimeoutMs),
    })
    if (!res.ok) return out
    const json = (await res.json()) as Parameters<typeof parseTopShotSaleTxJson>[0]
    return parseTopShotSaleTxJson(json, nftId)
  } catch {
    return out
  }
}

// ── Historical (pre-current-spork) Top Shot sale decode via spork-proxy ───────
//
// The current mainnet REST node only serves transactions from the current spork
// (heights ≥ 137,390,146, ~late-2024 onward), so decodeTopShotSaleTx returns
// ok:false for the 2022–2024 null-buyer tail. The spork-proxy Cloudflare Worker
// fronts the historical access nodes and (since 2026-06-19) walks the wired
// sporks (mainnet19→26) to find a tx by id. Same envelope shape, same parser.
//
// A 404 (tx_not_found_in_listed_sporks) means the tx is pre-mainnet19 (2020–21),
// which needs sporks not yet wired into the worker — left null, not an error.
//
// INERT until the operator (a) `wrangler deploy`s the updated spork-proxy and
// (b) verifies one known 2022 tx decodes. Gated behind the historical lane's
// env flag in /api/admin/backfill-topshot-buyers.
export async function decodeTopShotSaleTxViaSpork(
  txId: string,
  nftId: string,
  sporkProxyUrl: string,
  sporkProxySecret: string,
  fetchTimeoutMs = 25000,
): Promise<TopShotSaleTxDecode> {
  const out: TopShotSaleTxDecode = { buyer: null, seller: null, payer: null, proposer: null, ok: false }
  try {
    const clean = txId.replace(/^0x/, "")
    const u = new URL(sporkProxyUrl)
    u.searchParams.set("tx", clean)
    const res = await fetch(u.toString(), {
      headers: { Authorization: `Bearer ${sporkProxySecret}` },
      signal: AbortSignal.timeout(fetchTimeoutMs),
    })
    // Carry the status out so the caller can tell a pre-mainnet19 404 (stop) from
    // an auth or proxy fault (fix / retry). Still returns nulls either way — the
    // row stays unresolved — but the REASON is no longer lost.
    if (!res.ok) return { ...out, status: res.status }
    const json = (await res.json()) as Parameters<typeof parseTopShotSaleTxJson>[0]
    return parseTopShotSaleTxJson(json, nftId)
  } catch {
    return out
  }
}
