import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

// lib/candy/chain-sales.ts — Candy fills that settle OFF Magic Eden, read from the chain (11-22: a
// census found 16 fills on program 7Aru…, ~12.9 SOL, none in `sales`). Properties pinned, on REAL
// transactions: a 7Aru BuyCore decodes to the asset, the buyer's full payment (7.5 SOL), the buyer
// and the seller; a listing and a Magic Eden transaction decode to NOTHING; a fill is offered with
// its venue (solana_7aru); a signature already in `sales` or the queue is never fetched; the cursor
// advances only behind a complete walk and never on a failed read; a failure fails the run.

import { decodeChainFills, runCandyChainSales, CHAIN_MARKETPLACE, CHAIN_QUEUE_REASON, CHAIN_FLOOR_ISO } from "@/lib/candy/chain-sales"

const fx = (n: string) => JSON.parse(readFileSync(path.join(process.cwd(), "__tests__/fixtures/candy-chain-sales", `${n}.json`), "utf8"))
const BUY = fx("buycore-7-5-sol")
const LIST = fx("listcore")
const ME = fx("me-coresell")
const COLL = "2TdvL2H1VpT7GsWxgisusRV4MHocKfLF65eXzGb2EhpR"

describe("decodeChainFills (real transactions)", () => {
  it("decodes a 7Aru BuyCore: asset, the buyer's whole payment, buyer, seller", () => {
    const d = decodeChainFills(BUY.signature, BUY.tx)
    expect(d.fills).toHaveLength(1)
    const f = d.fills[0]
    expect(f.asset).toBe("FTshuAdRgMibdqqyyTeY38sWMivVTQaoeNVmY96rmheR")
    expect(f.collection).toBe(COLL)
    expect(f.priceSol).toBeCloseTo(7.5, 9)
    expect(f.buyer).toBe("C5YWNs7YYLe1jYYeyBmFhBFUuFRfmgQC52e3h5VrzRJm")
    expect(f.seller).toBe("Cj3JFK2BEYgKBVe1nMWRJSJQedwSnfXrbLAq85GxJBGR")
    expect(d.unknownIx).toEqual([])
  })
  it("the same fill on Tensor's own program decodes as marketplace tensor", () => {
    const T = "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp"
    const swap = (o: any) => JSON.parse(JSON.stringify(o).split("7Aru291A64wrTkUDaRv6HqxVBre6ivXWL94cUoCtQF9V").join(T))
    const d = decodeChainFills(BUY.signature, swap(BUY.tx))
    expect(d.fills.map((f) => [f.marketplace, f.priceSol])).toEqual([["tensor", 7.5]])
    expect(decodeChainFills(BUY.signature, BUY.tx).fills[0].marketplace).toBe(CHAIN_MARKETPLACE)
  })
  it("decodes a 7Aru TakeBidCore (bid filled): the bid price, the BIDDER as buyer, the signing seller", () => {
    const T = fx("takebidcore-9-sol")
    const d = decodeChainFills(T.signature, T.tx)
    expect(d.takeBids).toBe(1)
    expect(d.unknownIx).toEqual([])
    expect(d.fills).toHaveLength(1)
    const f = d.fills[0]
    // 8.009995 to the seller + 0.000005 tx fee + 0.09 venue fee + 0.45 + 0.45 royalties = the 9 SOL bid
    expect(f.priceSol).toBeCloseTo(9, 9)
    expect(f.buyer).not.toBe(f.seller)
    expect(f.seller).toBe(T.tx.transaction.message.accountKeys.find((k: any) => k.signer).pubkey)
    expect(f.marketplace).toBe(CHAIN_MARKETPLACE)
  })
  it("a bid fill whose seller also had a listing closed in the same tx is priced at the BID (0.002), not the seller's receipts", () => {
    const T = fx("takebidcore-seller-listing-closed")
    const d = decodeChainFills(T.signature, T.tx)
    expect(d.fills.map((f) => f.priceSol)).toEqual([0.002])
  })
  it("a listing is not a sale", () => {
    expect(decodeChainFills(LIST.signature, LIST.tx).fills).toEqual([])
  })
  it("a Magic Eden transaction is left to the Magic Eden lanes", () => {
    expect(decodeChainFills(ME.signature, ME.tx).fills).toEqual([])
  })
  it("a failed transaction decodes to nothing", () => {
    expect(decodeChainFills(BUY.signature, { ...BUY.tx, meta: { ...BUY.tx.meta, err: { InstructionError: [0, "x"] } } }).fills).toEqual([])
  })
  it("an unknown 7Aru instruction is REPORTED, not dropped silently", () => {
    const logs = BUY.tx.meta.logMessages.map((l: string) => (l === "Program log: Instruction: BuyCore" ? "Program log: Instruction: BuyCoreSpl" : l))
    const d = decodeChainFills(BUY.signature, { ...BUY.tx, meta: { ...BUY.tx.meta, logMessages: logs } })
    expect(d.fills).toEqual([])
    expect(d.unknownIx).toEqual(["solana_7aru:BuyCoreSpl"])
  })
})

const state: {
  collections: any[]
  hist: Record<string, any[]>
  truncatedAt: Record<string, number>
  txs: Record<string, any>
  queued: string[]
  sold: string[]
  parks: any[]
  updates: Array<{ address: string; patch: any }>
  txCalls: string[]
  sigCalls: any[]
  failSigsFor: string | null
  refuse?: string | null
} = { collections: [], hist: {}, truncatedAt: {}, txs: {}, queued: [], sold: [], parks: [], updates: [], txCalls: [], sigCalls: [], failSigsFor: null }

function db() {
  return {
    rpc: async (name: string, args: any) => {
      if (name !== "candy_park_chain_sale") throw new Error(name)
      const dup = state.parks.some((p) => p.p_signature === args.p_signature && p.p_token_mint === args.p_token_mint)
      if (!dup) state.parks.push(args)
      return { data: !dup, error: null }
    },
    from: (table: string) => {
      const b: any = {
        _patch: null,
        select: () => b, neq: () => b,
        order: () => (table === "candy_collections" && b._ordered ? Promise.resolve({ data: state.collections, error: null }) : ((b._ordered = true), b)),
        eq: (_c: string, v: any) => {
          if (b._patch) { state.updates.push({ address: v, patch: b._patch }); return Promise.resolve({ error: null }) }
          return b
        },
        in: (_c: string, vals: string[]) => {
          if (table === "candy_sales_unresolved") return Promise.resolve({ data: vals.filter((v) => state.queued.includes(v)).map((signature) => ({ signature })), error: null })
          if (table === "sales") return Promise.resolve({ data: vals.filter((v) => state.sold.includes(v)).map((transaction_hash) => ({ transaction_hash })), error: null })
          return b
        },
        update: (patch: any) => { b._patch = patch; return b },
      }
      return b
    },
  }
}

// getSignaturesForAddress honours until / before / limit over a newest-first history; an RPC in
// `state.truncatedAt` keeps only the newest N signatures of every account (a retention edge).
const fetchImpl = async (url: string, init: any) => {
  const body = JSON.parse(init.body)
  if (body.method === "getSignaturesForAddress") {
    const [addr, o] = body.params
    state.sigCalls.push({ url, addr, o })
    if (state.failSigsFor === addr) return new Response("boom", { status: 500 })
    let h: any[] = state.hist[addr] ?? []
    if (state.truncatedAt[url] != null) h = h.slice(0, state.truncatedAt[url])
    let i = 0
    if (o.before) { i = h.findIndex((x) => x.signature === o.before) + 1; if (i === 0) i = h.length }
    const out: any[] = []
    for (; i < h.length && out.length < o.limit; i++) { if (o.until && h[i].signature === o.until) break; out.push(h[i]) }
    return new Response(JSON.stringify({ result: out }), { status: 200 })
  }
  state.txCalls.push(body.params[0])
  lastTxOpts = body.params[1]
  return new Response(JSON.stringify({ result: state.txs[body.params[0]] ?? null }), { status: 200 })
}

let lastTxOpts: any = null
// Like fetchImpl, but every request about `state.refuse` gets a 429 (both RPCs).
const refusing = async (url: string, init: any) => {
  const body = JSON.parse(init.body)
  if (body.method === "getSignaturesForAddress" && body.params[0] === state.refuse) return new Response("slow down", { status: 429 })
  return fetchImpl(url, init)
}
const NOW = Date.parse("2026-11-22T15:00:00Z")
const PUB = "https://rpc.recent.test"
const ARCH = "https://api.mainnet-beta.solana.com"
const run = (urls = [PUB, ARCH]) => runCandyChainSales(db(), { budgetMs: 60_000, now: () => NOW, fetchImpl: fetchImpl as any, urls, concurrency: 2 })

beforeEach(() => {
  state.collections = [{ address: COLL, name: "ICONs", chain_sig_cursor: "OLD" }]
  // newest first: two new, one already sold, then the cursor and older history.
  state.hist = { [COLL]: [
    { signature: BUY.signature, blockTime: BUY.tx.blockTime }, { signature: LIST.signature, blockTime: LIST.tx.blockTime },
    { signature: "SOLD", blockTime: LIST.tx.blockTime - 10 }, { signature: "OLD", blockTime: LIST.tx.blockTime - 20 },
    { signature: "OLDER", blockTime: 1 },
  ] }
  state.truncatedAt = {}
  state.txs = { [BUY.signature]: BUY.tx, [LIST.signature]: LIST.tx }
  state.queued = []
  state.sold = ["SOLD"]
  state.parks = []
  state.updates = []
  state.txCalls = []
  state.sigCalls = []
  state.failSigsFor = null
  state.refuse = null
})

describe("runCandyChainSales", () => {
  it("offers a decoded fill with its venue and advances the cursor to the newest signature", async () => {
    const r = await run()
    expect(r.ok).toBe(true)
    expect(state.sigCalls[0]).toMatchObject({ url: PUB, o: { until: "OLD" } })
    expect(state.parks).toHaveLength(1)
    expect(state.parks[0]).toMatchObject({
      p_signature: BUY.signature,
      p_token_mint: "FTshuAdRgMibdqqyyTeY38sWMivVTQaoeNVmY96rmheR",
      p_marketplace: CHAIN_MARKETPLACE,
      p_skip_reason: CHAIN_QUEUE_REASON,
    })
    expect(state.parks[0].p_price_sol).toBeCloseTo(7.5, 9)
    expect(r.fills_offered).toBe(1)
    expect(state.updates).toEqual([{ address: COLL, patch: { chain_checked_at: new Date(NOW).toISOString(), chain_sig_cursor: BUY.signature } }])
  })
  it("asks for version-1 transactions (a v0 request is refused for them: 14 Candy txs 11-06 → 11-22, one a fill)", async () => {
    await run()
    expect(lastTxOpts).toMatchObject({ encoding: "jsonParsed", maxSupportedTransactionVersion: 1 })
  })
  it("never fetches a transaction already in `sales` or the queue", async () => {
    state.queued = [LIST.signature]
    await run()
    expect(state.txCalls).toEqual([BUY.signature])
  })
  it("a fill already queued is counted as known, not as written", async () => {
    await run()
    const r = await run()
    expect(r.fills_offered).toBe(0)
    expect(r.fills_known).toBe(1)
  })
  it("a listing that stops short of the cursor (an RPC's retention edge) is NOT taken as complete: the archive RPC is asked", async () => {
    state.truncatedAt = { [PUB]: 2 }
    const r = await run()
    expect(r.ok).toBe(true)
    expect(state.sigCalls.some((c) => c.url === ARCH)).toBe(true)
    expect(state.updates[0].patch.chain_sig_cursor).toBe(BUY.signature)
  })
  it("with no archive RPC to ask, a truncated listing fails the collection and the cursor does not move", async () => {
    state.truncatedAt = { [PUB]: 2 }
    const r = await run([PUB])
    expect(r.ok).toBe(false)
    expect(state.updates).toEqual([])
  })
  it("no cursor: a short listing proves nothing on a non-archive RPC; the archive's listing is used", async () => {
    state.collections = [{ address: COLL, name: "ICONs", chain_sig_cursor: null }]
    // a young collection: three signatures in all, every one after the floor
    const f = Date.parse(CHAIN_FLOOR_ISO) / 1000
    state.hist[COLL] = state.hist[COLL].slice(0, 3).map((x: any, i: number) => ({ ...x, blockTime: f + 300 - i }))
    const r = await run()
    expect(r.ok).toBe(true)
    expect(state.sigCalls.filter((c) => c.url === PUB)).toHaveLength(1)
    expect(state.sigCalls.filter((c) => c.url === ARCH)).toHaveLength(1)
    expect(state.parks).toHaveLength(1)
  })
  it("a collection every RPC refuses (429) is counted as rate_limited, keeps its cursor, and does not fail a run that read others", async () => {
    const OTHER = "OTHERCOLL"
    state.collections = [{ address: COLL, name: "ICONs", chain_sig_cursor: "OLD" }, { address: OTHER, name: "Idle", chain_sig_cursor: "X0" }]
    state.hist[OTHER] = [{ signature: "X0", blockTime: 1 }]
    state.refuse = OTHER
    const r = await runCandyChainSales(db(), { budgetMs: 60_000, now: () => NOW, fetchImpl: refusing as any, urls: [PUB, ARCH], concurrency: 2 })
    expect(r.ok).toBe(true)
    expect(r.rate_limited).toBe(1)
    expect(r.failed).toBe(0)
    expect(state.updates.map((u) => u.address)).toEqual([COLL])
  })
  it("a run in which every collection was refused is NOT ok", async () => {
    state.refuse = COLL
    const r = await runCandyChainSales(db(), { budgetMs: 60_000, now: () => NOW, fetchImpl: refusing as any, urls: [PUB, ARCH], concurrency: 2 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/rate_limited/)
    expect(state.updates).toEqual([])
  }, 20_000)
  it("a failed signature read fails the run and leaves the cursor where it is", async () => {
    state.failSigsFor = COLL
    const r = await run()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/1 collection\(s\) failed/)
    expect(state.updates).toEqual([])
    expect(state.parks).toEqual([])
  })
  it("a transaction no RPC returns fails the collection; the cursor does not move", async () => {
    delete state.txs[LIST.signature]
    const r = await run()
    expect(r.ok).toBe(false)
    expect(state.updates).toEqual([])
  })
})

// 2026-11-22: the first production run failed 5 collections with "Transaction version (1) is not
// supported … maxSupportedTransactionVersion: 1" — Solana carries version-1 transactions, and the lane
// asked for 0. A real v1 tx (5vsTBy…, a 7Aru ListCore, slot 472267152) has the v0 shape plus a
// `transactionConfig` in the message. The simulated RPC below refuses a v1 tx exactly as mainnet does.
describe("version-1 transactions", () => {
  const asV1 = (tx: any) => ({ ...tx, version: 1, transaction: { ...tx.transaction, message: { ...tx.transaction.message, transactionConfig: { computeUnitLimit: 400000, heapSize: null, loadedAccountsDataSizeLimit: 67108864, priorityFee: null } } } })

  it("a version-1 BuyCore decodes exactly like the v0 one", () => {
    const d = decodeChainFills(BUY.signature, asV1(BUY.tx))
    expect(d.fills.map((f) => [f.asset, f.priceSol, f.buyer, f.seller])).toEqual(
      decodeChainFills(BUY.signature, BUY.tx).fills.map((f) => [f.asset, f.priceSol, f.buyer, f.seller]))
  })

  it("the run asks for version 1 and records a v1 fill the RPC would otherwise refuse", async () => {
    const seen: any[] = []
    const v1Fetch = async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      if (body.method === "getSignaturesForAddress") return fetchImpl(_url, init)
      seen.push(body.params[1])
      if (!(Number(body.params[1]?.maxSupportedTransactionVersion) >= 1)) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32015, message: 'Transaction version (1) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 1' }, id: 1 }), { status: 200 })
      }
      const tx = body.params[0] === BUY.signature ? asV1(BUY.tx) : state.txs[body.params[0]] ?? null
      return new Response(JSON.stringify({ result: tx }), { status: 200 })
    }
    const r = await runCandyChainSales(db(), { budgetMs: 60_000, now: () => NOW, fetchImpl: v1Fetch as any, urls: [PUB, ARCH], concurrency: 2 })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((o) => o.maxSupportedTransactionVersion === 1)).toBe(true)
    expect(r.ok).toBe(true)
    expect(state.parks).toHaveLength(1)
  })
})

