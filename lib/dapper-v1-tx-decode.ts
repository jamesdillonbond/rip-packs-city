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
