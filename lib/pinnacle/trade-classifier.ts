// Disney Pinnacle trade classifier — pure, deterministic, no I/O.
//
// Extracted from app/api/cron/pinnacle-trades-indexer/route.ts so the rule that
// decides what counts as a TRADE is exercised by the primary coverage gate
// (which measures lib/** but not app/**), and so it can be tested against the
// exact on-chain shapes that were measured rather than against a paraphrase.
//
// ── THE RULE, AND WHY IT IS SOUND ───────────────────────────────────────────
//
// Pinnacle's in-app peer-to-peer trade settles as ONE atomic transaction in
// which EXACTLY TWO wallets swap Pins in BOTH directions. Measured 2026-08-22
// against Flow REST over two independent 10,000-block windows (~3.5 h each):
//
//   window A  162,163,000–162,172,999 : 53 sale-shaped tx,  9 trade tx (54 Pins)
//   window B  162,153,000–162,162,999 : 26 sale-shaped tx,  5 trade tx (23 Pins)
//
// and validated in BOTH directions against per-transaction ground truth from
// /v1/transaction_results (which lists every event in the tx):
//
//   geometry says TRADE      → 14 tx /  77 Pins →  0 carried a storefront event
//   geometry says NOT-trade  → 26 tx /  26 Pins → 26 carried a storefront event
//
// Zero false positives, zero false negatives, over both windows. The rule
// therefore needs no storefront or mint lookup at all:
//
//   • a MINT emits Deposit with NO Withdraw  → excluded by requiring a Withdraw
//   • a SALE moves one Pin one way: the seller appears only as `from`, the buyer
//     only as `to` → fails the appears-on-both-sides test
//   • a TRADE has both wallets on both sides → the only shape that passes
//
// ⚠ THE TEST IS "BOTH WALLETS APPEAR ON BOTH SIDES", NOT "TWO WALLETS AND
// SEVERAL PINS". A bulk one-way transfer of 25 Pins from wallet A to wallet B
// also involves two wallets and many Pins, and it is NOT a trade — A never
// receives and B never sends. Weakening the test to a wallet count would
// silently relabel every bulk gift as a trade.
//
// ⚠ IT IS ALSO NOT "PINS BALANCE". A trade need not be even; nothing on chain
// requires each side to send the same number. What makes it a trade is that
// value moved in both directions inside one atomic transaction.

/** One Pinnacle.Withdraw or Pinnacle.Deposit event, already decoded. */
export interface PinnacleMoveEvent {
  side: "withdraw" | "deposit"
  transactionId: string
  nftId: string
  /** Withdraw.from or Deposit.to. */
  address: string
  blockHeight: number
  blockTimestamp: string
}

/** One Pin moving from one wallet to another as part of a trade. */
export interface PinnacleTradeLeg {
  transactionId: string
  nftId: string
  fromWallet: string
  toWallet: string
  blockHeight: number
  blockTimestamp: string
  /** Total Pins moved by the whole swap transaction (trade SIZE, not count). */
  pinsInTrade: number
}

export type PinnacleTxShape =
  /** ≥1 Withdraw, ≥1 Deposit, exactly two wallets, each on both sides. */
  | "trade"
  /** One Pin, one sender, one receiver — a storefront sale or a one-way transfer. */
  | "sale_or_one_way"
  /** Deposits with no Withdraw at all — a mint. */
  | "mint_or_deposit_only"
  /** Anything else. Counted and reported, never written. */
  | "unclassified"

export interface PinnacleTradeClassification {
  trades: PinnacleTradeLeg[]
  shapeCounts: Record<PinnacleTxShape, number>
}

/**
 * Group decoded Withdraw/Deposit events by transaction and classify each one.
 *
 * Only `trade` transactions produce legs. Every other shape is counted in
 * `shapeCounts` and otherwise dropped — the counts are what make a change in
 * Pinnacle's settlement shape visible instead of silently collapsing this lane
 * to zero output.
 */
export function classifyPinnacleTradeTxs(events: PinnacleMoveEvent[]): PinnacleTradeClassification {
  const byTx = new Map<string, PinnacleMoveEvent[]>()
  for (const e of events) {
    if (!e || !e.transactionId || !e.nftId || !e.address) continue
    const slot = byTx.get(e.transactionId)
    if (slot) slot.push(e)
    else byTx.set(e.transactionId, [e])
  }

  const shapeCounts: Record<PinnacleTxShape, number> = {
    trade: 0,
    sale_or_one_way: 0,
    mint_or_deposit_only: 0,
    unclassified: 0,
  }
  const trades: PinnacleTradeLeg[] = []

  for (const [transactionId, txEvents] of byTx) {
    const withdrawals = txEvents.filter((e) => e.side === "withdraw")
    const deposits = txEvents.filter((e) => e.side === "deposit")

    if (withdrawals.length === 0) {
      shapeCounts.mint_or_deposit_only++
      continue
    }
    if (deposits.length === 0) {
      // A Withdraw with no Deposit inside the same scanned range. Real on chain
      // only for a burn; far more often it means the chunk boundary split the
      // transaction. Either way it is not a trade and must not be guessed at.
      shapeCounts.unclassified++
      continue
    }

    const senders = new Set(withdrawals.map((e) => e.address))
    const receivers = new Set(deposits.map((e) => e.address))
    const parties = new Set([...senders, ...receivers])

    const isTrade = parties.size === 2 && senders.size === 2 && receivers.size === 2

    if (!isTrade) {
      // One sender and one receiver moving one Pin is the storefront-sale shape
      // (and the one-way-transfer shape, which is indistinguishable from these
      // two event streams alone — hence the honest joint label).
      if (senders.size === 1 && receivers.size === 1 && withdrawals.length === 1 && deposits.length === 1) {
        shapeCounts.sale_or_one_way++
      } else {
        shapeCounts.unclassified++
      }
      continue
    }

    // Pair each withdrawn Pin with its deposit. The counterparty is the other
    // party in the two-wallet swap; the deposit is used to confirm it rather
    // than to derive it, so a Pin whose deposit is missing is DROPPED, never
    // attributed to a wallet by elimination.
    const depositByNft = new Map<string, PinnacleMoveEvent>()
    for (const d of deposits) depositByNft.set(d.nftId, d)

    const legs: PinnacleTradeLeg[] = []
    for (const w of withdrawals) {
      const d = depositByNft.get(w.nftId)
      if (!d) continue
      if (d.address === w.address) continue // self-move inside a swap: not a transfer of ownership
      legs.push({
        transactionId,
        nftId: w.nftId,
        fromWallet: w.address,
        toWallet: d.address,
        blockHeight: w.blockHeight,
        blockTimestamp: w.blockTimestamp,
        pinsInTrade: 0, // filled below, once the real leg count is known
      })
    }

    if (legs.length === 0) {
      shapeCounts.unclassified++
      continue
    }

    // pinsInTrade is the number of legs actually WRITTEN, not the number of
    // withdrawals seen, so it can never describe Pins this lane did not record.
    for (const leg of legs) leg.pinsInTrade = legs.length
    trades.push(...legs)
    shapeCounts.trade++
  }

  return { trades, shapeCounts }
}
