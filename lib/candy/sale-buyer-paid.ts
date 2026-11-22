// lib/candy/sale-buyer-paid.ts
//
// Candy sale price = WHAT THE BUYER PAID (Trevor, 2026-11-21: "Switch to buyer-paid" → "we need to
// fix this first"). Until now every Candy `sales` row carried Magic Eden's activity `price`, which
// is the LISTED price. Read on-chain 11-21 (12 sales, 8 sets, MLB and DC):
//
//   · A listing bought outright (M2 BuyV2 / CoreExecuteSaleV2): the buyer pays the listed price
//     PLUS ~12% on top — the creator royalty (10%, split over the collection's creators) and Magic
//     Eden's 2% fee. Skenes 2025 All-Star ICONS 1/1: listed 20.311 SOL, buyer paid 22.749 SOL
//     (seller 20.311 · ME fee 0.406 · royalties 0.670 + 0.670 + 0.691).
//   · A sale INTO a buyer's pool / bid (MMM SolMplCoreFulfillBuy): the buyer pays exactly the
//     recorded price; the royalty and fee come out of the SELLER's side.
//
// So the buyer-paid price is read from the transaction itself, not from a rate: who funded the
// royalty + fee legs decides. Venue-agnostic, and a collection with a different royalty is
// measured, not assumed.
//
// Rule (lamports, exact):
//   extras  = Σ positive balance changes of accounts that are neither buyer nor seller and that
//             EXISTED before the transaction (pre > 0) — the royalty creators and fee wallets.
//             A NEW account (pre = 0) receiving lamports is rent, not a payment.
//   funded  = Σ |negative balance changes| of accounts other than the seller that still exist
//             after it (post > 0; a CLOSED account's balance is rent being returned), minus the
//             network fee where that account paid it.
//   If funded covers listed + extras → the BUYER side paid them: buyer_paid = listed + extras.
//   Otherwise the seller's proceeds paid them: buyer_paid = listed.
// The ratio buyer_paid / listed must sit in [1, 1.25]; anything else is recorded as an error and
// the sale is left at its listed price (never a guessed number).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

// A Magic Eden LISTING (ask) costs its buyer the listed price + royalty + ME fee, so an ask is stored
// in USD at that cost — the same basis as the buyer-paid sales and FMV it is compared with (else
// every Candy ask would read ~12% under value: a fake deal). 1.12 = measured on-chain 11-21 on every
// M2 purchase sampled (10 of 10, 8 sets, MLB and DC: 10% royalty + 2% fee). Re-measure from
// candy_sale_buyer_paid (paid_by='buyer') before changing it. `price_sol` stays the LISTED price.
export const CANDY_ME_LISTING_BUYER_MULTIPLIER = 1.12

export function candyAskBuyerCostUsd(listedSol: number, solUsdRate: number | null): number | null {
  return solUsdRate != null ? Number((listedSol * CANDY_ME_LISTING_BUYER_MULTIPLIER * solUsdRate).toFixed(2)) : null
}

export const CANDY_COLLECTION_ID = "209ade70-32c5-4470-bc7c-4793d660f713"
const LAMPORTS = 1_000_000_000
// price_native is stored to 8 decimals, so a listed price read back can be off by ≤ 10 lamports.
const TOLERANCE_LAMPORTS = 10_000
export const MAX_RATIO = 1.25

export interface SolanaTx {
  meta: {
    fee: number
    err: unknown
    preBalances: number[]
    postBalances: number[]
    loadedAddresses?: { writable?: string[]; readonly?: string[] } | null
  } | null
  transaction: { message: { accountKeys: Array<string | { pubkey: string }> } }
}

export type BuyerPaid =
  | { ok: true; paid_by: "buyer" | "seller"; listed_sol: number; extras_sol: number; buyer_paid_sol: number; ratio: number }
  | { ok: false; error: string }

export function buyerPaidFromTx(tx: SolanaTx, sale: { buyer: string | null; seller: string | null; listedSol: number }): BuyerPaid {
  if (!tx.meta) return { ok: false, error: "no_meta" }
  if (tx.meta.err) return { ok: false, error: "tx_failed" }
  if (!(sale.listedSol > 0)) return { ok: false, error: "no_listed_price" }
  const keys = [
    ...tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey)),
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ]
  const pre = tx.meta.preBalances
  const post = tx.meta.postBalances
  if (pre.length !== keys.length || post.length !== keys.length) return { ok: false, error: "balance_shape" }
  const listed = Math.round(sale.listedSol * LAMPORTS)
  let extras = 0
  let funded = 0
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    if (k === sale.seller) continue
    let delta = post[i] - pre[i]
    if (i === 0) delta += tx.meta.fee // the fee payer's network fee is not a payment to anyone
    if (k !== sale.buyer && pre[i] > 0 && delta > 0) extras += delta
    if (delta < 0 && post[i] > 0) funded += -delta
  }
  const buyerSide = funded + TOLERANCE_LAMPORTS >= listed + extras && extras > 0
  const paid = buyerSide ? listed + extras : listed
  const ratio = paid / listed
  if (!(ratio >= 1 && ratio <= MAX_RATIO)) return { ok: false, error: `ratio_out_of_range:${ratio.toFixed(4)}` }
  return {
    ok: true,
    paid_by: buyerSide ? "buyer" : "seller",
    listed_sol: listed / LAMPORTS,
    extras_sol: (buyerSide ? extras : 0) / LAMPORTS,
    buyer_paid_sol: paid / LAMPORTS,
    ratio,
  }
}

// Keyless Solana RPC. publicnode answers recent transactions fast but returns null for older ones
// (measured 11-21: null for a 10-day-old sale), so a null falls through to mainnet-beta, which holds
// full history but rate-limits (~1–2 getTransaction/s per IP).
export const RPC_URLS = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"]

export async function fetchTx(sig: string, doFetch: FetchFn, urls: string[] = RPC_URLS, retryDelayMs = 1500): Promise<SolanaTx | null | "rate_limited"> {
  let limited = false
  for (const url of urls) {
    let resp: Response
    try {
      resp = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }] }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      limited = true
      continue
    }
    if (resp.status === 429) {
      // mainnet-beta (the only keyless RPC holding Candy's history) answers 429 in bursts; one
      // backed-off retry recovers most of them (2026-11-22: 6–7 refusals per run without it).
      await new Promise((r) => setTimeout(r, retryDelayMs))
      try {
        resp = await doFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }] }),
          signal: AbortSignal.timeout(15_000),
        })
      } catch {
        limited = true
        continue
      }
      if (resp.status === 429) { limited = true; continue }
    }
    if (!resp.ok) { limited = true; continue }
    const j = (await resp.json().catch(() => null)) as { result?: SolanaTx | null; error?: { code?: number } } | null
    if (j?.error) { limited = true; continue }
    if (j?.result) return j.result
  }
  return limited ? "rate_limited" : null
}

export interface BuyerPaidRunResult {
  ok: boolean
  targets: number
  read: number
  applied: number
  paid_by_buyer: number
  paid_by_seller: number
  errors_recorded: number
  not_found: number
  rate_limited: number
  budget_stopped: boolean
  error: string | null
}

interface Target {
  transaction_hash: string
  nft_id: string
  sold_at: string
  price_native: number | string
  buyer_address: string | null
  seller_address: string | null
}

export async function runCandyBuyerPaid(
  db: Db,
  opts: { budgetMs: number; limit?: number; now?: () => number; fetchImpl?: FetchFn; pauseMs?: number; urls?: string[]; concurrency?: number; retryDelayMs?: number },
): Promise<BuyerPaidRunResult> {
  const now = opts.now ?? Date.now
  const doFetch: FetchFn = opts.fetchImpl ?? ((u, i) => fetch(u, i))
  const pauseMs = opts.pauseMs ?? 700
  const deadline = now() + opts.budgetMs
  const out: BuyerPaidRunResult = {
    ok: false, targets: 0, read: 0, applied: 0, paid_by_buyer: 0, paid_by_seller: 0,
    errors_recorded: 0, not_found: 0, rate_limited: 0, budget_stopped: false, error: null,
  }

  const { data, error } = await db.rpc("candy_buyer_paid_targets", { p_limit: opts.limit ?? 600 })
  if (error) { out.error = `targets: ${error.message ?? String(error)}`; return out }
  const rows = (data ?? []) as Target[]
  // One transaction can carry more than one Candy sale (a sweep): it is priced once, over the sum.
  const byTx = new Map<string, Target[]>()
  for (const r of rows) {
    const g = byTx.get(r.transaction_hash)
    if (g) g.push(r)
    else byTx.set(r.transaction_hash, [r])
  }
  out.targets = byTx.size

  const pending: Array<Record<string, unknown>> = []
  let consecutiveLimited = 0
  const flush = async () => {
    if (pending.length === 0) return
    const batch = pending.splice(0, pending.length)
    const { data: n, error: aErr } = await db.rpc("candy_apply_buyer_paid", { p_rows: batch })
    if (aErr) throw new Error(`apply: ${aErr.message ?? String(aErr)}`)
    out.applied += Number(n ?? 0)
  }

  try {
    // Reads can go out `concurrency` at a time; results are handled in order, and 5 straight refusals
    // stop the run.
    const entries = [...byTx]
    // Default 1 (2026-11-22): at 4 the history reads hit mainnet-beta's per-IP limit and a run read
    // ~10 transactions before 5 refusals stopped it — worse than sequential (~50).
    const concurrency = Math.max(1, opts.concurrency ?? 1)
    outer: for (let b = 0; b < entries.length; b += concurrency) {
      if (now() > deadline) { out.budget_stopped = true; break }
      if (consecutiveLimited >= 5) { out.budget_stopped = true; break } // the RPC is refusing us: stop, retry next run
      if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs))
      const batch = entries.slice(b, b + concurrency)
      const txs = await Promise.all(batch.map(([sig, group]) => {
        // publicnode keeps only recent history (null for a 10-day-old sale, measured 11-21), so an
        // older sale goes straight to mainnet-beta instead of spending a call on a known miss.
        const old = Date.parse(group[0].sold_at) < now() - 5 * 86_400_000
        const urls = opts.urls ?? (old ? RPC_URLS.slice(1) : RPC_URLS)
        return fetchTx(sig, doFetch, urls, opts.retryDelayMs ?? 1500)
      }))
      for (let k = 0; k < batch.length; k++) {
      const [sig, group] = batch[k]
      const tx = txs[k]
      if (tx === "rate_limited") { out.rate_limited++; consecutiveLimited++; if (consecutiveLimited >= 5) { out.budget_stopped = true; break outer } continue }
      consecutiveLimited = 0
      if (tx === null) { out.not_found++; continue } // not retried as an error: next run tries again
      out.read++
      const sellers = new Set(group.map((g) => g.seller_address))
      const buyers = new Set(group.map((g) => g.buyer_address))
      const listedSol = group.reduce((s, g) => s + Number(g.price_native), 0)
      const res: BuyerPaid = sellers.size === 1 && buyers.size === 1
        ? buyerPaidFromTx(tx, { buyer: group[0].buyer_address, seller: group[0].seller_address, listedSol })
        : { ok: false, error: "multi_party_tx" }
      if (res.ok) {
        if (res.paid_by === "buyer") out.paid_by_buyer++
        else out.paid_by_seller++
      } else {
        out.errors_recorded++
      }
      for (const g of group) {
        pending.push({
          transaction_hash: sig,
          nft_id: g.nft_id,
          sold_at: g.sold_at,
          listed_sol: Number(g.price_native),
          ratio: res.ok ? res.ratio : null,
          paid_by: res.ok ? res.paid_by : null,
          extras_sol: res.ok ? res.extras_sol : null,
          error: res.ok ? null : res.error,
        })
      }
      if (pending.length >= 50) await flush()
      }
    }
    await flush()
  } catch (e) {
    out.error = (e instanceof Error ? e.message : String(e)).slice(0, 500)
    return out
  }
  out.ok = true
  return out
}
