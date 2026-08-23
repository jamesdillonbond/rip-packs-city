import { describe, it, expect } from "vitest"
import {
  classifyPinnacleTradeTxs,
  type PinnacleMoveEvent,
} from "@/lib/pinnacle/trade-classifier"

// The shapes below are the ones MEASURED on Flow mainnet 2026-08-22 over two
// independent 10,000-block windows and cross-checked against
// /v1/transaction_results. They are reproduced here as fixtures so a change to
// the classifier has to argue with the chain, not with a paraphrase of it.

let seq = 0
function mv(
  side: "withdraw" | "deposit",
  transactionId: string,
  nftId: string,
  address: string,
  blockHeight = 162_153_000 + seq++
): PinnacleMoveEvent {
  return {
    side,
    transactionId,
    nftId,
    address,
    blockHeight,
    blockTimestamp: "2026-08-22T20:00:00.000Z",
  }
}

const A = "0x23dde701491082ad"
const B = "0xf3494b5641de2837"
const C = "0x2a787a43b0624f09"

describe("classifyPinnacleTradeTxs — the trade shape", () => {
  it("classifies a two-wallet bidirectional swap as a trade and emits one leg per Pin", () => {
    const events = [
      mv("withdraw", "tx1", "n1", A),
      mv("deposit", "tx1", "n1", B),
      mv("withdraw", "tx1", "n2", B),
      mv("deposit", "tx1", "n2", A),
    ]
    const { trades, shapeCounts } = classifyPinnacleTradeTxs(events)
    expect(shapeCounts.trade).toBe(1)
    expect(trades).toHaveLength(2)
    expect(trades.map((t) => [t.fromWallet, t.toWallet])).toEqual([
      [A, B],
      [B, A],
    ])
    // pinsInTrade is trade SIZE. Both legs report 2, so a consumer summing
    // count(*) gets Pins-moved and a consumer reading pins_in_trade can recover
    // that these two rows are ONE trade.
    expect(trades.every((t) => t.pinsInTrade === 2)).toBe(true)
  })

  it("handles the largest observed swap (25 Pins, uneven sides) without dropping legs", () => {
    // Observed on chain: one tx, two wallets, 25 Pins. Nothing requires the
    // sides to be even, so this fixture is deliberately 20-for-5.
    const events: PinnacleMoveEvent[] = []
    for (let i = 0; i < 20; i++) {
      events.push(mv("withdraw", "tx-big", `a${i}`, A))
      events.push(mv("deposit", "tx-big", `a${i}`, B))
    }
    for (let i = 0; i < 5; i++) {
      events.push(mv("withdraw", "tx-big", `b${i}`, B))
      events.push(mv("deposit", "tx-big", `b${i}`, A))
    }
    const { trades, shapeCounts } = classifyPinnacleTradeTxs(events)
    expect(shapeCounts.trade).toBe(1)
    expect(trades).toHaveLength(25)
    expect(trades.every((t) => t.pinsInTrade === 25)).toBe(true)
  })
})

describe("classifyPinnacleTradeTxs — the shapes that are NOT trades", () => {
  it("does not classify a storefront sale as a trade", () => {
    // Measured: 26 of 26 geometry=NOT-trade transactions carried a storefront
    // event. Seller appears only as `from`, buyer only as `to`.
    const { trades, shapeCounts } = classifyPinnacleTradeTxs([
      mv("withdraw", "tx-sale", "n1", A),
      mv("deposit", "tx-sale", "n1", B),
    ])
    expect(shapeCounts.trade).toBe(0)
    expect(shapeCounts.sale_or_one_way).toBe(1)
    expect(trades).toHaveLength(0)
  })

  it("does not classify a mint as a trade — a mint deposits with no withdraw", () => {
    const { trades, shapeCounts } = classifyPinnacleTradeTxs([mv("deposit", "tx-mint", "n1", A)])
    expect(shapeCounts.trade).toBe(0)
    expect(shapeCounts.mint_or_deposit_only).toBe(1)
    expect(trades).toHaveLength(0)
  })

  it("does NOT classify a bulk ONE-WAY transfer as a trade, however many Pins it moves", () => {
    // ⚠ This is the case a weaker rule ("two wallets and several Pins") would
    // get wrong, and it would get it wrong SILENTLY — every bulk gift would be
    // relabelled a trade. A never receives; B never sends.
    const events: PinnacleMoveEvent[] = []
    for (let i = 0; i < 25; i++) {
      events.push(mv("withdraw", "tx-bulk", `n${i}`, A))
      events.push(mv("deposit", "tx-bulk", `n${i}`, B))
    }
    const { trades, shapeCounts } = classifyPinnacleTradeTxs(events)
    expect(shapeCounts.trade).toBe(0)
    expect(trades).toHaveLength(0)
    // It is not a SALE either — one sender and one receiver but 25 Pins, which
    // is not the one-Pin sale shape. It lands in `unclassified`, where it is
    // counted and reported rather than guessed at.
    expect(shapeCounts.unclassified).toBe(1)
  })

  it("does not classify a three-wallet circular move as a trade", () => {
    const { trades, shapeCounts } = classifyPinnacleTradeTxs([
      mv("withdraw", "tx3", "n1", A),
      mv("deposit", "tx3", "n1", B),
      mv("withdraw", "tx3", "n2", B),
      mv("deposit", "tx3", "n2", C),
      mv("withdraw", "tx3", "n3", C),
      mv("deposit", "tx3", "n3", A),
    ])
    expect(shapeCounts.trade).toBe(0)
    expect(shapeCounts.unclassified).toBe(1)
    expect(trades).toHaveLength(0)
  })

  it("drops a withdraw whose matching deposit was not read, rather than inferring the recipient", () => {
    // The counterparty is CONFIRMED from the deposit, never derived by
    // elimination from the two-party set — so an unmatched Pin is dropped and
    // pinsInTrade counts only what shipped. (Chunking cannot cause this: a
    // transaction's events all live in one block. A missing deposit means a
    // burn or a decode failure, which is exactly when guessing is worst.)
    const { trades, shapeCounts } = classifyPinnacleTradeTxs([
      mv("withdraw", "tx4", "n1", A),
      mv("deposit", "tx4", "n1", B),
      mv("withdraw", "tx4", "n2", B),
      mv("deposit", "tx4", "n2", A),
      mv("withdraw", "tx4", "n3", A), // deposit for n3 not in range
    ])
    expect(shapeCounts.trade).toBe(1)
    expect(trades).toHaveLength(2)
    expect(trades.map((t) => t.nftId).sort()).toEqual(["n1", "n2"])
    // ⚠ 2, not 3. pins_in_trade must never describe Pins this lane did not write.
    expect(trades.every((t) => t.pinsInTrade === 2)).toBe(true)
  })

  it("counts a withdraw with no deposit at all as unclassified, never as a trade", () => {
    const { trades, shapeCounts } = classifyPinnacleTradeTxs([mv("withdraw", "tx5", "n1", A)])
    expect(shapeCounts.trade).toBe(0)
    expect(shapeCounts.unclassified).toBe(1)
    expect(trades).toHaveLength(0)
  })
})

describe("classifyPinnacleTradeTxs — input hygiene and the census", () => {
  it("returns zeroed counts and no trades for an empty input", () => {
    expect(classifyPinnacleTradeTxs([])).toEqual({
      trades: [],
      shapeCounts: { trade: 0, sale_or_one_way: 0, mint_or_deposit_only: 0, unclassified: 0 },
    })
  })

  it("drops events missing a tx id, nft id or address instead of pairing them", () => {
    const bad = [
      { ...mv("withdraw", "", "n1", A) },
      { ...mv("withdraw", "tx6", "", A) },
      { ...mv("deposit", "tx6", "n1", "") },
    ]
    const { trades, shapeCounts } = classifyPinnacleTradeTxs(bad)
    expect(trades).toHaveLength(0)
    expect(shapeCounts.trade).toBe(0)
  })

  it("dedupes a re-read event so pinsInTrade cannot silently double", () => {
    // An NFT can be withdrawn at most once per transaction, so a second copy of
    // the same (tx, side, nftId) is always a re-read. If it were counted, the
    // trade would report 4 Pins where 2 moved — a wrong published number with
    // no error anywhere.
    const dup = [
      mv("withdraw", "tx1", "n1", A), mv("deposit", "tx1", "n1", B),
      mv("withdraw", "tx1", "n2", B), mv("deposit", "tx1", "n2", A),
      mv("withdraw", "tx1", "n1", A), mv("deposit", "tx1", "n1", B),
      mv("withdraw", "tx1", "n2", B), mv("deposit", "tx1", "n2", A),
    ]
    const { trades, shapeCounts } = classifyPinnacleTradeTxs(dup)
    expect(shapeCounts.trade).toBe(1)
    expect(trades).toHaveLength(2)
    expect(trades.every((t) => t.pinsInTrade === 2)).toBe(true)
    expect(trades.map((t) => t.nftId).sort()).toEqual(["n1", "n2"])
  })

  it("reports every transaction it saw in exactly one shape bucket", () => {
    // The census is what makes a change in Pinnacle's settlement shape visible.
    // If a tx could go uncounted, a silent drop to zero trades would read as a
    // quiet week rather than as a broken classifier.
    const events = [
      mv("withdraw", "t-trade", "n1", A), mv("deposit", "t-trade", "n1", B),
      mv("withdraw", "t-trade", "n2", B), mv("deposit", "t-trade", "n2", A),
      mv("withdraw", "t-sale", "n3", A), mv("deposit", "t-sale", "n3", B),
      mv("deposit", "t-mint", "n4", A),
      mv("withdraw", "t-odd", "n5", A),
    ]
    const { shapeCounts } = classifyPinnacleTradeTxs(events)
    const totalTxs = new Set(events.map((e) => e.transactionId)).size
    const counted =
      shapeCounts.trade +
      shapeCounts.sale_or_one_way +
      shapeCounts.mint_or_deposit_only +
      shapeCounts.unclassified
    expect(counted).toBe(totalTxs)
  })

  it("keeps transactions independent — one malformed tx does not suppress a good one", () => {
    const { trades, shapeCounts } = classifyPinnacleTradeTxs([
      mv("withdraw", "t-bad", "n9", A),
      mv("withdraw", "t-good", "n1", A), mv("deposit", "t-good", "n1", B),
      mv("withdraw", "t-good", "n2", B), mv("deposit", "t-good", "n2", A),
    ])
    expect(shapeCounts.trade).toBe(1)
    expect(shapeCounts.unclassified).toBe(1)
    expect(trades).toHaveLength(2)
  })
})
