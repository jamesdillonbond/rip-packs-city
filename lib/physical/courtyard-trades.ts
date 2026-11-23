/**
 * Courtyard (Polygon) trade-event decoder + windowed log reader
 * (prototype, NOT wired; no metadata fetch).
 *
 * Measured from the chain on 2026-11-22 (public RPC, ~4,750 sampled blocks):
 *
 *   - Registry (ERC-721, name "Courtyard"): 0x251be3a1…89dcad, totalSupply 438,204.
 *   - Secondary trades settle through 0x7c57a444…2d64e50e, which emits
 *     topic0 0x279d1d02… with topic1 = BUYER (pays USDC), topic2 = SELLER and
 *     data = (uint256[] tokenIds, bytes, address erc20, uint256 amount,
 *     uint256, uint256, bytes32 orderHash). Settlement token on every sampled
 *     trade was native USDC (0x3c499c54…3d5c3359, 6 decimals).
 *   - ⚠ ~94 % of those trades have ONE buyer, 0x66dbff2c…eaf5e642 — an EOA that
 *     also receives the USDC from pack purchases. It is Courtyard's house
 *     buyback desk. Its prices are a set fraction of Courtyard's own estimate,
 *     so using them as comparables would just re-price Courtyard's number.
 *     They are classified "house" and excluded, the same way Dapper's
 *     pack-distribution account is excluded from Top Shot leaderboards.
 *   - Pack purchases ("primary") go through 0x07d79f0f…6d16083e (topic0
 *     0xcaa93258…) with payment via 0x776023a4…2bef516e. These are rips, not
 *     market prices.
 *
 * Card IDENTITY is not on chain: tokenURI points at api.courtyard.io metadata,
 * which Courtyard's Terms (§11.1, §14.8) keep off-limits without a data
 * partnership. This module therefore yields prices keyed by tokenId only.
 */

export const COURTYARD = {
  registry: "0x251be3a17af4892035c37ebf5890f4a4d889dcad",
  tradeSettler: "0x7c57a44474ddd74c055ae5ad08b3c9d22d64e50e",
  tradeTopic0: "0x279d1d0274c98fe823227d8ca6e26bc93a760c8277c64309f8ac9132aa0e706c",
  packPurchaser: "0x07d79f0f6879f4d555431573320236628d16083e",
  packTopic0: "0xcaa9325838005b5b7578713a64b079f8be640ba4bffcd8c45085b387f9d5fe48",
  houseBuyback: "0x66dbff2ce099d19b4e8c5dc8b254ec7aeaf5e642",
  usdc: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
} as const

/** Addresses whose trades are not market evidence. Extend, never inline. */
export const COURTYARD_EXCLUDED_COUNTERPARTIES = new Set<string>([COURTYARD.houseBuyback])

export type RawLog = {
  address: string
  topics: string[]
  data: string
  blockNumber: string
  transactionHash: string
  logIndex: string
}

export type CourtyardTrade = {
  txHash: string
  logIndex: number
  blockNumber: number
  buyer: string
  seller: string
  tokenIds: string[] // 0x-prefixed 32-byte hex
  erc20: string
  amountRaw: bigint
  amountUsd: number | null // null when the settlement token is not USDC
  orderHash: string
  kind: "peer" | "house"
}

const word = (hex: string, i: number) => hex.slice(i * 64, i * 64 + 64)
// base58-fold: intentional — EVM log words/topics are hex by construction (Polygon), never base58.
const addrFromWord = (w: string) => "0x" + w.slice(24).toLowerCase()
// base58-fold: intentional — EVM log topics are hex by construction (Polygon), never base58.
const addrFromTopic = (t: string) => "0x" + t.slice(26).toLowerCase()

export function decodeCourtyardTrade(log: RawLog): CourtyardTrade | null {
  if (log.address.toLowerCase() !== COURTYARD.tradeSettler) return null
  if ((log.topics[0] ?? "").toLowerCase() !== COURTYARD.tradeTopic0) return null
  if (log.topics.length < 3) return null
  const d = log.data.startsWith("0x") ? log.data.slice(2) : log.data
  if (d.length < 64 * 7) return null

  const idsOffsetWords = Number(BigInt("0x" + word(d, 0)) / BigInt(32))
  const n = Number(BigInt("0x" + word(d, idsOffsetWords)))
  if (!Number.isSafeInteger(n) || n < 0 || n > 10_000) return null
  const tokenIds: string[] = []
  for (let i = 0; i < n; i++) tokenIds.push("0x" + word(d, idsOffsetWords + 1 + i))

  const buyer = addrFromTopic(log.topics[1])
  const seller = addrFromTopic(log.topics[2])
  const erc20 = addrFromWord(word(d, 2))
  const amountRaw = BigInt("0x" + word(d, 3))
  const amountUsd = erc20 === COURTYARD.usdc ? Number(amountRaw) / 1e6 : null
  const house =
    COURTYARD_EXCLUDED_COUNTERPARTIES.has(buyer) || COURTYARD_EXCLUDED_COUNTERPARTIES.has(seller)

  return {
    txHash: log.transactionHash,
    logIndex: parseInt(log.logIndex, 16),
    blockNumber: parseInt(log.blockNumber, 16),
    buyer,
    seller,
    tokenIds,
    erc20,
    amountRaw,
    amountUsd,
    orderHash: "0x" + word(d, 6),
    kind: house ? "house" : "peer",
  }
}

/**
 * Per-token price for a multi-token trade is NOT knowable (one amount, many
 * tokens). Only single-token trades become comparables.
 */
export function comparablePrice(t: CourtyardTrade): number | null {
  if (t.kind !== "peer" || t.amountUsd == null || t.tokenIds.length !== 1) return null
  return t.amountUsd
}

export type GetLogs = (filter: {
  address?: string
  topics: (string | string[] | null)[]
  fromBlock: string
  toBlock: string
}) => Promise<RawLog[]>

/**
 * Reads trade logs in windows no wider than `maxSpan` blocks (free public
 * Polygon endpoints cap eth_getLogs ranges; dRPC's free plan refuses >100).
 */
export async function readCourtyardTrades(
  getLogs: GetLogs,
  fromBlock: number,
  toBlock: number,
  maxSpan = 99,
): Promise<CourtyardTrade[]> {
  const out: CourtyardTrade[] = []
  for (let start = fromBlock; start <= toBlock; start += maxSpan + 1) {
    const end = Math.min(start + maxSpan, toBlock)
    const logs = await getLogs({
      address: COURTYARD.tradeSettler,
      topics: [COURTYARD.tradeTopic0],
      fromBlock: "0x" + start.toString(16),
      toBlock: "0x" + end.toString(16),
    })
    for (const l of logs) {
      const t = decodeCourtyardTrade(l)
      if (t) out.push(t)
    }
  }
  return out
}
