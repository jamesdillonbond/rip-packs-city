import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

// lib/candy/chain-sales.ts — Candy fills that settle OFF Magic Eden, read from the chain (11-22: a
// census found 16 fills on program 7Aru…, ~12.9 SOL, none in `sales`). Properties pinned, on REAL
// transactions: a 7Aru BuyCore decodes to the asset, the buyer's full payment (7.5 SOL), the buyer
// and the seller; a listing and a Magic Eden transaction decode to NOTHING; a fill is offered with
// its venue (solana_7aru); a signature already in `sales` or the queue is never fetched; the cursor
// advances only behind a complete walk and never on a failed read; a failure fails the run.

import { decodeChainFills, runCandyChainSales, CHAIN_MARKETPLACE, CHAIN_QUEUE_REASON } from "@/lib/candy/chain-sales"

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
  sigs: Record<string, any[]>
  txs: Record<string, any>
  queued: string[]
  sold: string[]
  parks: any[]
  updates: Array<{ address: string; patch: any }>
  txCalls: string[]
  sigCalls: any[]
  failSigsFor: string | null
} = { collections: [], sigs: {}, txs: {}, queued: [], sold: [], parks: [], updates: [], txCalls: [], sigCalls: [], failSigsFor: null }

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

const fetchImpl = async (_url: string, init: any) => {
  const body = JSON.parse(init.body)
  if (body.method === "getSignaturesForAddress") {
    state.sigCalls.push(body.params)
    if (state.failSigsFor === body.params[0]) return new Response("boom", { status: 500 })
    return new Response(JSON.stringify({ result: state.sigs[body.params[0]] ?? [] }), { status: 200 })
  }
  state.txCalls.push(body.params[0])
  lastTxOpts = body.params[1]
  return new Response(JSON.stringify({ result: state.txs[body.params[0]] ?? null }), { status: 200 })
}

let lastTxOpts: any = null
const NOW = Date.parse("2026-11-22T15:00:00Z")
const run = () => runCandyChainSales(db(), { budgetMs: 60_000, now: () => NOW, fetchImpl: fetchImpl as any, urls: ["https://rpc.test"], concurrency: 2 })

beforeEach(() => {
  state.collections = [{ address: COLL, name: "ICONs", chain_sig_cursor: "OLD" }]
  state.sigs = { [COLL]: [{ signature: BUY.signature, blockTime: BUY.tx.blockTime }, { signature: LIST.signature, blockTime: LIST.tx.blockTime }, { signature: "SOLD", blockTime: 1 }] }
  state.txs = { [BUY.signature]: BUY.tx, [LIST.signature]: LIST.tx }
  state.queued = []
  state.sold = ["SOLD"]
  state.parks = []
  state.updates = []
  state.txCalls = []
  state.sigCalls = []
  state.failSigsFor = null
})

describe("runCandyChainSales", () => {
  it("offers a decoded fill with its venue and advances the cursor to the newest signature", async () => {
    const r = await run()
    expect(r.ok).toBe(true)
    expect(state.sigCalls[0][1]).toMatchObject({ until: "OLD" })
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
