// lib/candy/offer-funding.ts
//
// Is a Magic Eden Candy bid FUNDABLE? (2026-11-21, Claude Code.)
//
// Magic Eden keeps serving bids whose bidder can no longer pay. Candy drained SOL from its custody
// wallets at the 10-12 lock, and on 2026-11-20 the whole active Candy bid book was 4 bids from one such
// wallet: 0.00089 SOL against ~1.5 SOL of bids, no Magic Eden escrow (verified on chain by Cowork). A
// one-off retirement (20261121073043) was undone by the next sweep, because /api/ingest/candy-offers
// re-upserts every bid Magic Eden serves as active. These bids fed the "best bid" line of edition
// market-history charts and the offer-spread board.
//
// RULE: a bid is UNFUNDABLE only when BOTH the bidder's Magic Eden bid escrow AND their wallet hold less
// SOL than the bid. Either read failing, or answering in a shape we do not recognise, means UNKNOWN —
// and unknown keeps the bid (fail open). Lenient on purpose: counting the wallet too means a bidder who
// can top up escrow from their wallet is never dropped.

/** Funding read for one bidder. `null` = unknown (read failed or unrecognised shape). */
export interface BidderFunding {
  escrowSol: number | null
  walletSol: number | null
  /** Why a leg is unknown (e.g. "escrow:http 404", "wallet:shape"). Empty when both read. Recorded on the run
   *  (2026-11-21: the first live run read funding_unknown 1 with no way to tell which leg or why). */
  reasons: string[]
}

/** True only on positive evidence that neither escrow nor wallet covers the bid. */
export function isUnfundable(priceSol: number, f: BidderFunding | undefined): boolean {
  if (!f || f.escrowSol == null || f.walletSol == null) return false
  if (!Number.isFinite(priceSol) || priceSol <= 0) return false
  return f.escrowSol < priceSol && f.walletSol < priceSol
}

const LAMPORTS_PER_SOL = 1e9

/**
 * Magic Eden `GET /v2/wallets/{wallet}/escrow_balance`. Observed live 2026-11-21 4:50 PM PT (the run recorded
 * `escrow:shape keys=buyerEscrow|balance`): `{ buyerEscrow: <escrow address>, balance: <number> }` — the first
 * guess, `{ buyerEscrowBalance }`, never matched, so every bid failed open. `balance` is read as SOL. If it were
 * lamports instead, a funded bidder reads as MORE funded (kept) and an empty escrow is 0 either way, so the error
 * can only keep a bid, never drop one. The old key is still accepted. Anything else → null (unknown → kept).
 */
export function parseEscrowBalance(json: unknown): number | null {
  if (!json || typeof json !== "object") return null
  const o = json as Record<string, unknown>
  const v = typeof o.balance === "number" ? o.balance : o.buyerEscrowBalance
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null
}

/** Solana JSON-RPC `getBalance` → `{ result: { value: <lamports> } }`. Anything else → null. */
export function parseGetBalance(json: unknown): number | null {
  if (!json || typeof json !== "object") return null
  const r = (json as Record<string, unknown>).result
  if (!r || typeof r !== "object") return null
  const v = (r as Record<string, unknown>).value
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v / LAMPORTS_PER_SOL : null
}

export const SOLANA_PUBLIC_RPC = "https://api.mainnet-beta.solana.com"

/** Reads both balances for one bidder. Never throws: each failed leg is null (unknown). */
export async function readBidderFunding(
  bidder: string,
  deps: {
    fetchImpl?: typeof fetch
    meBase: string
    meHeaders: Record<string, string>
    timeoutMs: number
  },
): Promise<BidderFunding> {
  const f = deps.fetchImpl ?? fetch
  const reasons: string[] = []
  // A short, value-free description of an unrecognised body: its top-level keys, never its values.
  const shapeOf = (j: unknown) =>
    j && typeof j === "object" ? `keys=${Object.keys(j as object).slice(0, 5).join("|") || "none"}` : typeof j
  let escrowSol: number | null = null
  let walletSol: number | null = null
  try {
    const r = await f(`${deps.meBase}/wallets/${encodeURIComponent(bidder)}/escrow_balance`, {
      headers: deps.meHeaders,
      signal: AbortSignal.timeout(deps.timeoutMs),
    })
    if (!r.ok) reasons.push(`escrow:http ${r.status}`)
    else {
      const j = await r.json()
      escrowSol = parseEscrowBalance(j)
      if (escrowSol == null) reasons.push(`escrow:shape ${shapeOf(j)}`)
    }
  } catch (e) {
    reasons.push(`escrow:error ${(e instanceof Error ? e.name : "unknown")}`)
  }
  try {
    const r = await f(SOLANA_PUBLIC_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [bidder] }),
      signal: AbortSignal.timeout(deps.timeoutMs),
    })
    if (!r.ok) reasons.push(`wallet:http ${r.status}`)
    else {
      const j = await r.json()
      walletSol = parseGetBalance(j)
      if (walletSol == null) reasons.push(`wallet:shape ${shapeOf(j)}`)
    }
  } catch (e) {
    reasons.push(`wallet:error ${(e instanceof Error ? e.name : "unknown")}`)
  }
  return { escrowSol, walletSol, reasons }
}
