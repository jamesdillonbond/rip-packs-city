// lib/candy/chain-sales.ts
//
// CANDY SALES THAT SETTLE OFF MAGIC EDEN, read from the chain (2026-11-22; Trevor: "dig deeper into
// … any others that aren't 100% confirmed").
//
// Why it exists. Every Candy `sales` row came from Magic Eden's activity feed, so a fill on any
// other venue was invisible. An on-chain census of all 398 Candy collection accounts, 11-06 → 11-22,
// found 16 fills on program 7Aru291A64wrTkUDaRv6HqxVBre6ivXWL94cUoCtQF9V (Tensor marketplace code
// at a non-Tensor address — known-issues #256's falsifier), all on 11-20 / 11-21 PT, ~12.9 SOL with
// one 7.5 SOL card; none were in `sales`. The program is NOT attributed to a named marketplace (no
// official source names it), so its sales carry marketplace `solana_7aru`. Tensor's own program
// (TCMPhJ…, the code 7Aru… is built from) is decoded the same way, as marketplace `tensor`.
//
// What it does. Every Metaplex Core transfer of a Candy asset passes its collection account, so
// `getSignaturesForAddress(<collection>)` lists every ownership change on any venue (the 10-25
// census method). Per collection, the signatures newer than its cursor are read; each transaction
// that invokes 7Aru's BuyCore is decoded (asset, price, buyer, seller) and OFFERED to the drain
// queue with its venue (candy_park_chain_sale), so candy-sales-indexer stays the ONE writer of
// Candy `sales`. Everything else (Magic Eden fills, listings, mints, transfers) is ignored here.
//
// Price = what the buyer paid: the sum of the buyer's system transfers inside the BuyCore call
// (royalties + the venue fee + the seller's proceeds). On this venue the seller pays the fees, so
// that equals the listed price, and the buyer-paid lane (Magic Eden rows only) never touches it.
//
// Not decoded: 7Aru TakeBidCore (a bid filled; the price leaves a program-owned escrow, not a system
// transfer). Counted in `take_bids_seen`, never guessed. Any other 7Aru instruction name is counted
// in `unknown_ix` so a new fill shape surfaces instead of disappearing.
//
// Honesty: a collection's cursor advances only behind a walk that read every new signature, fetched
// every transaction it needed and landed every offer, inside the budget. A failed read fails the
// collection (and the run); the next run re-reads the same range.

import type { FetchFn } from "@/lib/candy/sale-buyer-paid"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export const CHAIN_MARKET_PROGRAM = "7Aru291A64wrTkUDaRv6HqxVBre6ivXWL94cUoCtQF9V"
export const CHAIN_MARKETPLACE = "solana_7aru"
// Tensor's own marketplace program (the code 7Aru… is built from); Candy listings were seen on it
// (11-06 → 11-22: 3 ListCore, 3 DelistCore, 0 fills). Decoded the same way.
export const TENSOR_PROGRAM = "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp"
export const CHAIN_PROGRAMS: Record<string, string> = { [CHAIN_MARKET_PROGRAM]: CHAIN_MARKETPLACE, [TENSOR_PROGRAM]: "tensor" }
export const CHAIN_QUEUE_REASON = "queued_chain_walk"
const CORE_PROGRAM = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
const SYSTEM_PROGRAM = "11111111111111111111111111111111"
// Where a collection with no cursor starts. NOT the 11-06 reopening: since 11-06 the 398 accounts
// hold tens of thousands of signatures (mints, listings), and the keyless RPC that still has those
// transactions (mainnet-beta) refuses a lane that reads them all — the 11-22 11:11 AM PT run
// finished 71 collections, 70 of them on getTransaction 429. 11-06 → this floor was back-filled
// ONCE from a session (see the ledger, 2026-11-22); the lane carries it forward from here.
export const CHAIN_FLOOR_ISO = "2026-11-22T12:00:00Z"
export const CHAIN_RPC_URLS = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"]
const KNOWN_IX = new Set(["ListCore", "DelistCore", "EditCore", "TcompNoop", "BuyCore", "TakeBidCore"])

export interface ChainFill {
  signature: string
  asset: string
  collection: string
  blockTime: number
  priceSol: number
  buyer: string
  seller: string | null
  marketplace: string
}

interface ParsedIx {
  programId: string
  accounts?: string[]
  parsed?: { type?: string; info?: { source?: string; destination?: string; lamports?: number } }
}
export interface ParsedTx {
  blockTime?: number | null
  meta: {
    err: unknown
    fee?: number
    preBalances?: number[]
    postBalances?: number[]
    logMessages?: string[] | null
    innerInstructions?: Array<{ index: number; instructions: ParsedIx[] }> | null
  } | null
  transaction: { message: { instructions: ParsedIx[]; accountKeys?: Array<{ pubkey: string; signer?: boolean }> } }
}

export interface DecodeResult {
  fills: ChainFill[]
  takeBids: number
  unknownIx: string[]
}

// The top-level instruction names of every invocation of `program` at depth 1, in order.
function topLevelNames(logs: string[], program: string): string[] {
  const names: string[] = []
  for (let i = 0; i < logs.length; i++) {
    if (logs[i] === `Program ${program} invoke [1]`) {
      const m = /^Program log: Instruction: (\w+)$/.exec(logs[i + 1] ?? "")
      names.push(m ? m[1] : "?")
    }
  }
  return names
}

export function decodeChainFills(signature: string, tx: ParsedTx): DecodeResult {
  const out: DecodeResult = { fills: [], takeBids: 0, unknownIx: [] }
  if (!tx.meta || tx.meta.err) return out
  const top = tx.transaction.message.instructions
  const names: Record<string, string[]> = {}
  const seen: Record<string, number> = {}
  for (let idx = 0; idx < top.length; idx++) {
    const program = top[idx].programId
    const marketplace = CHAIN_PROGRAMS[program]
    if (!marketplace) continue
    names[program] ??= topLevelNames(tx.meta.logMessages ?? [], program)
    const name = names[program][(seen[program] = (seen[program] ?? -1) + 1)] ?? "?"
    if (!KNOWN_IX.has(name)) { out.unknownIx.push(`${marketplace}:${name}`); continue }
    const inner = tx.meta.innerInstructions?.find((g) => g.index === idx)?.instructions ?? []
    if (name === "TakeBidCore") {
      out.takeBids++
      const bid = decodeTakeBid(signature, tx, inner, marketplace)
      if (typeof bid === "string") out.unknownIx.push(`${marketplace}:TakeBidCore:${bid}`)
      else out.fills.push(bid)
      continue
    }
    if (name !== "BuyCore") continue
    // Core Transfer: [asset, collection, payer, authority, new_owner, …].
    const core = inner.find((i) => i.programId === CORE_PROGRAM && (i.accounts?.length ?? 0) >= 5)
    if (!core?.accounts) { out.unknownIx.push(`${marketplace}:BuyCore:no_core_transfer`); continue }
    const [asset, collection, , , buyer] = core.accounts
    let lamports = 0
    let seller: string | null = null
    let top1 = -1
    for (const i of inner) {
      if (i.programId !== SYSTEM_PROGRAM || i.parsed?.type !== "transfer") continue
      const info = i.parsed.info ?? {}
      if (info.source !== buyer || typeof info.lamports !== "number") continue
      lamports += info.lamports
      if (info.lamports > top1) { top1 = info.lamports; seller = info.destination ?? null }
    }
    if (!(lamports > 0)) { out.unknownIx.push(`${marketplace}:BuyCore:no_payment`); continue }
    out.fills.push({ signature, asset, collection, blockTime: tx.blockTime ?? 0, priceSol: lamports / 1e9, buyer, seller, marketplace })
  }
  return out
}

// A bid filled (the seller signs; the bidder's SOL was escrowed in a program account, so it leaves
// as a balance change, not a system transfer). Price = the escrow's debit (the most-debited account
// other than the signer) minus what came back to the bidder (the closed escrow's rent). NOT "what
// the seller and the royalty accounts received": a seller whose own listing closes in the same tx
// gets that listing's rent too (seen 11-11: it would have read 0.00426 SOL for a 0.002 bid).
// Checked on 6 real 7Aru fills 11-11 → 11-20, each to the lamport against the payouts.
function decodeTakeBid(signature: string, tx: ParsedTx, inner: ParsedIx[], marketplace: string): ChainFill | string {
  const meta = tx.meta!
  const keys = tx.transaction.message.accountKeys
  if (!keys || !meta.preBalances || !meta.postBalances) return "no_balances"
  const core = inner.find((i) => i.programId === CORE_PROGRAM && (i.accounts?.length ?? 0) >= 5)
  if (!core?.accounts) return "no_core_transfer"
  const [asset, collection, , , bidder] = core.accounts
  const seller = keys.find((k) => k.signer)?.pubkey ?? null
  if (!seller || seller === bidder) return "self_fill"
  let escrowDebit = 0
  let bidderCredit = 0
  keys.forEach((k, i) => {
    const d = meta.postBalances![i] - meta.preBalances![i]
    if (k.pubkey === bidder && d > 0) bidderCredit += d
    if (k.pubkey !== seller && d < 0 && -d > escrowDebit) escrowDebit = -d
  })
  const lamports = escrowDebit - bidderCredit
  if (!(lamports > 0)) return "no_payment"
  return { signature, asset, collection, blockTime: tx.blockTime ?? 0, priceSol: lamports / 1e9, buyer: bidder, seller, marketplace }
}

async function rpc<T>(doFetch: FetchFn, method: string, params: unknown[], urls: string[]): Promise<T> {
  let last = "no rpc"
  for (const url of urls) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await doFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(15_000),
        })
        if (r.status === 429) { last = `${method} 429`; await new Promise((s) => setTimeout(s, 1000 + 1500 * attempt)); continue }
        if (!r.ok) { last = `${method} HTTP ${r.status}`; break }
        const j = (await r.json()) as { result?: T; error?: { message?: string } }
        if (j.error) { last = `${method}: ${j.error.message ?? "error"}`; break }
        // A transaction the first RPC no longer (or not yet) holds: ask the next one.
        if (j.result == null && method === "getTransaction") { last = `${method}: not found`; break }
        return j.result as T
      } catch (e) {
        last = `${method}: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }
  throw new Error(last)
}

interface SigInfo { signature: string; blockTime?: number | null; err?: unknown }

// RPCs that keep an account's FULL signature history. A listing that ends early on any other RPC
// may be its retention edge, not the account's start: 2026-11-22 publicnode answered a collection
// from 11-21 onward, short of the 1,000 limit, hours after it had listed that collection's 11-20
// fills — and the first version of this walk took the short page as "done" and advanced the cursor
// past five fills.
export const ARCHIVE_RPC_URLS = new Set(["https://api.mainnet-beta.solana.com"])

// Every signature on `address` newer than `cursor` (or, with no cursor, since floorSec), newest
// first, plus the newest signature seen at all (the next cursor, even when it is older than the
// floor). A listing is accepted only when it is PROVEN complete on that RPC: with a cursor, the
// signature just older than the oldest one read must BE the cursor; without one, the walk must
// pass the floor, or end on an archive RPC. Otherwise the next RPC is asked; when none can prove
// it, this throws — a partial list must never advance a cursor.
export async function newSignatures(doFetch: FetchFn, address: string, cursor: string | null, floorSec: number, urls = CHAIN_RPC_URLS): Promise<{ sigs: SigInfo[]; newest: string | null }> {
  let last = "no rpc"
  for (const url of urls) {
    try {
      return await walkSignatures(doFetch, address, cursor, floorSec, url)
    } catch (e) {
      last = e instanceof Error ? e.message : String(e)
    }
  }
  throw new Error(last)
}

async function walkSignatures(doFetch: FetchFn, address: string, cursor: string | null, floorSec: number, url: string): Promise<{ sigs: SigInfo[]; newest: string | null }> {
  const out: SigInfo[] = []
  let newest: string | null = null
  let before: string | undefined
  for (let page = 0; page < 50; page++) {
    const opts: Record<string, unknown> = { limit: 1000 }
    if (cursor) opts.until = cursor
    if (before) opts.before = before
    const res = await rpc<SigInfo[]>(doFetch, "getSignaturesForAddress", [address, opts], [url])
    if (newest == null && res.length > 0) newest = res[0].signature
    let older = false
    for (const s of res) {
      if (!cursor && (s.blockTime ?? 0) < floorSec) { older = true; break }
      out.push(s)
    }
    if (older) return { sigs: out, newest }
    if (res.length < 1000) {
      if (cursor) {
        const anchor = out.length > 0 ? out[out.length - 1].signature : null
        const probe = await rpc<SigInfo[]>(doFetch, "getSignaturesForAddress", [address, anchor ? { limit: 1, before: anchor } : { limit: 1 }], [url])
        if (probe[0]?.signature !== cursor) throw new Error(`getSignaturesForAddress ${address}: listing at ${url} does not reach the cursor`)
        return { sigs: out, newest: newest ?? cursor }
      }
      if (!ARCHIVE_RPC_URLS.has(url)) throw new Error(`getSignaturesForAddress ${address}: listing at ${url} ends before the floor`)
      return { sigs: out, newest }
    }
    before = res[res.length - 1].signature
  }
  throw new Error(`getSignaturesForAddress ${address}: more than 50 pages`)
}

export interface ChainSalesCollection {
  address: string
  name: string
  sigs: number
  fetched: number
  fills: number
  offered: number
  error: string | null
}

export interface ChainSalesResult {
  ok: boolean
  queued: number
  checked: number
  not_reached: number
  sigs_read: number
  tx_fetched: number
  fills_seen: number
  fills_offered: number
  fills_known: number
  take_bids_seen: number
  unknown_ix: string[]
  failed: number
  // Collections left unread because every RPC refused them (429). Their cursors stay where they
  // are, so nothing is lost — the next run re-reads the same range — but it is counted and named.
  rate_limited: number
  collections: ChainSalesCollection[]
  error: string | null
}

export async function runCandyChainSales(
  db: Db,
  opts: { budgetMs: number; now?: () => number; fetchImpl?: FetchFn; urls?: string[]; concurrency?: number },
): Promise<ChainSalesResult> {
  const now = opts.now ?? Date.now
  const doFetch: FetchFn = opts.fetchImpl ?? ((u, i) => fetch(u, i))
  const urls = opts.urls ?? CHAIN_RPC_URLS
  const conc = Math.max(1, opts.concurrency ?? 4)
  const deadline = now() + opts.budgetMs
  const floorSec = Math.floor(Date.parse(CHAIN_FLOOR_ISO) / 1000)
  const out: ChainSalesResult = {
    ok: false, queued: 0, checked: 0, not_reached: 0, sigs_read: 0, tx_fetched: 0, fills_seen: 0, fills_offered: 0,
    fills_known: 0, take_bids_seen: 0, unknown_ix: [], failed: 0, rate_limited: 0, collections: [], error: null,
  }

  // Oldest-walked first; never-walked first of all.
  const { data: queue, error: qErr } = await db
    .from("candy_collections")
    .select("address,name,chain_sig_cursor,chain_checked_at")
    .neq("kind", "test")
    .order("chain_checked_at", { ascending: true, nullsFirst: true })
    .order("address", { ascending: true })
  if (qErr) { out.error = `candy_collections read: ${qErr.message}`; return out }
  const rows = (queue ?? []) as Array<{ address: string; name: string; chain_sig_cursor: string | null }>
  out.queued = rows.length

  for (const c of rows) {
    if (now() > deadline) { out.not_reached = rows.length - out.checked; break }
    out.checked++
    const rep: ChainSalesCollection = { address: c.address, name: c.name, sigs: 0, fetched: 0, fills: 0, offered: 0, error: null }
    out.collections.push(rep)
    try {
      const walk = await newSignatures(doFetch, c.address, c.chain_sig_cursor, floorSec, urls)
      const sigs = walk.sigs.filter((s) => !s.err)
      rep.sigs = sigs.length
      out.sigs_read += sigs.length
      // Signatures already in `sales` or the queue need no transaction read.
      const known = new Set<string>()
      const all = sigs.map((s) => s.signature)
      for (let i = 0; i < all.length; i += 200) {
        const chunk = all.slice(i, i + 200)
        const q = await db.from("candy_sales_unresolved").select("signature").in("signature", chunk)
        if (q.error) throw new Error(`queue read: ${q.error.message}`)
        for (const r of (q.data ?? []) as Array<{ signature: string }>) known.add(r.signature)
        const s = await db.from("sales").select("transaction_hash").eq("collection_id", "209ade70-32c5-4470-bc7c-4793d660f713").in("transaction_hash", chunk)
        if (s.error) throw new Error(`sales read: ${s.error.message}`)
        for (const r of (s.data ?? []) as Array<{ transaction_hash: string }>) known.add(r.transaction_hash)
      }
      const todo = all.filter((s) => !known.has(s))
      const fills: ChainFill[] = []
      let next = 0
      let budgetHit = false
      const worker = async () => {
        while (next < todo.length) {
          if (now() > deadline) { budgetHit = true; return }
          const sig = todo[next++]
          const tx = await rpc<ParsedTx | null>(doFetch, "getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }], urls)
          if (!tx) throw new Error(`getTransaction ${sig}: not found`)
          rep.fetched++
          const d = decodeChainFills(sig, tx)
          out.take_bids_seen += d.takeBids
          for (const u of d.unknownIx) if (!out.unknown_ix.includes(u)) out.unknown_ix.push(u)
          for (const f of d.fills) if (f.collection === c.address) fills.push(f)
        }
      }
      await Promise.all(Array.from({ length: Math.min(conc, todo.length) }, worker))
      out.tx_fetched += rep.fetched
      rep.fills = fills.length
      out.fills_seen += fills.length
      for (const f of fills) {
        const { data: landed, error } = await db.rpc("candy_park_chain_sale", {
          p_signature: f.signature,
          p_token_mint: f.asset,
          p_block_time: new Date(f.blockTime * 1000).toISOString(),
          p_price_sol: f.priceSol,
          p_buyer: f.buyer,
          p_seller: f.seller,
          p_skip_reason: CHAIN_QUEUE_REASON,
          p_marketplace: f.marketplace,
        })
        if (error) throw new Error(`offer ${f.signature}: ${error.message}`)
        if (landed === true) { rep.offered++; out.fills_offered++ } else out.fills_known++
      }
      if (budgetHit) { rep.error = "budget"; out.not_reached = rows.length - out.checked + 1; break }
      // Every new signature read, every needed transaction decoded, every offer landed: advance.
      const patch: Record<string, unknown> = { chain_checked_at: new Date(now()).toISOString() }
      if (walk.newest) patch.chain_sig_cursor = walk.newest
      const { error: uErr } = await db.from("candy_collections").update(patch).eq("address", c.address)
      if (uErr) throw new Error(`cursor write: ${uErr.message}`)
    } catch (e) {
      rep.error = e instanceof Error ? e.message : String(e)
      if (/ 429$/.test(rep.error)) out.rate_limited++
      else out.failed++
    }
  }
  // A refusal is not a failure of this lane (the range is re-read next run), but a run in which
  // EVERY collection it reached was refused read nothing, and is not ok.
  const allRefused = out.checked > 0 && out.rate_limited === out.checked
  out.ok = out.failed === 0 && !allRefused
  if (out.failed > 0) out.error = `${out.failed} collection(s) failed; first: ${out.collections.find((c) => c.error && c.error !== "budget" && !/ 429$/.test(c.error))?.error ?? "?"}`
  else if (allRefused) out.error = `rate_limited: all ${out.checked} collection(s) refused`
  return out
}
