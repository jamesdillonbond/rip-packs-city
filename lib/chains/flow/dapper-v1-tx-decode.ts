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
          if (typeof to === "string" && to.length > 0) result.buyer = to
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
    if (!res.ok) return out // 404 = pre-mainnet19, or worker/auth error — leave null
    const json = (await res.json()) as Parameters<typeof parseTopShotSaleTxJson>[0]
    return parseTopShotSaleTxJson(json, nftId)
  } catch {
    return out
  }
}
