import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of /api/pinnacle-ingest (the sibling test only pins auth). GET wraps
// pinnacle_health_check; POST fetches a Flowty NFT batch, upserts editions
// (deduped, skipping rows with no editionKey/royaltyCode), builds sales rows from
// non-LISTED priced orders (with the seconds-vs-ms blockTimestamp normalization),
// bulk-inserts them, and reports batch/nextOffset/done. Legs pinned: health ok/500,
// POST auth, the edition dedup + skip + upsert-error tally, the order filters +
// timestamp math, the bulk-insert error branch, the recalc no-op flag, done/
// nextOffset, and the fatal catch → 500.

vi.hoisted(() => { process.env.INGEST_SECRET_TOKEN = "tok" })

const st = vi.hoisted(() => ({ batch: [] as any[], batchThrows: false }))
const rpc = vi.hoisted(() => vi.fn(async (_name: string, _params?: any): Promise<any> => ({ data: null, error: null })))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: (...a: any[]) => rpc(...(a as [string, any?])),
    from: () => ({ upsert: async () => ({ error: null }) }),
  },
}))
vi.mock("@/lib/pinnacle/pinnacleFlowty", () => ({
  fetchFlowtyPinnacleListings: async () => { if (st.batchThrows) throw new Error("flowty 500"); return st.batch },
  extractEditionKeyFromNft: (nft: any) => ({ editionKey: nft.editionKey ?? null }),
}))
vi.mock("@/lib/pinnacle/pinnacleTypes", () => ({
  // The route passes the trait array; our fixtures put the intended editionData as traits[0].
  flowtyTraitsToPinnacleEdition: (traits: any[]) => traits?.[0] ?? {},
}))

import { GET, POST } from "@/app/api/pinnacle-ingest/route"

const post = (qs = "?token=tok") => new NextReqLike(`https://t/api/pinnacle-ingest${qs}`)
class NextReqLike {
  url: string
  headers = new Headers()
  constructor(u: string) { this.url = u }
}

// An NFT fixture: editionData goes in nftView.traits.traits[0]; orders drive sales.
const nft = (over: any = {}) => ({
  id: "n1",
  owner: "0xowner",
  editionKey: "ek1", // for extractEditionKeyFromNft (sales pass)
  nftView: { traits: { traits: [{ editionKey: "ek1", royaltyCode: "rc1", characterName: "Mickey" }] } },
  card: { max: "100", images: [{ url: "img" }] },
  orders: [],
  ...over,
})

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "tok"
  st.batch = []
  st.batchThrows = false
  rpc.mockReset()
  rpc.mockResolvedValue({ data: null, error: null })
})

describe("GET /api/pinnacle-ingest — health", () => {
  it("ok → { ok:true, health }", async () => {
    rpc.mockResolvedValue({ data: { editions: 5 }, error: null })
    const body = await (await GET()).json()
    expect(body.ok).toBe(true)
    expect(body.health).toEqual({ editions: 5 })
  })
  it("rpc error → 500", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "health down" } })
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("health down")
  })
})

describe("POST /api/pinnacle-ingest — ingest", () => {
  it("401 with a wrong token", async () => {
    expect((await POST(post("?token=nope") as any)).status).toBe(401)
  })

  it("dedups editions, skips no-key rows, tallies upsert errors", async () => {
    st.batch = [
      nft({ id: "a", nftView: { traits: { traits: [{ editionKey: "ek1", royaltyCode: "rc" }] } } }),
      nft({ id: "b", nftView: { traits: { traits: [{ editionKey: "ek1", royaltyCode: "rc" }] } } }), // dup → deduped
      nft({ id: "c", nftView: { traits: { traits: [{ editionKey: "ek2", royaltyCode: "rc" }] } } }),
      nft({ id: "d", nftView: { traits: { traits: [{ editionKey: null, royaltyCode: "rc" }] } } }), // no key → skipped
    ]
    rpc.mockImplementation(async (name: string, params?: any) => {
      if (name === "upsert_pinnacle_edition") {
        return params.p_edition_key === "ek2" ? { error: { message: "boom" } } : { error: null }
      }
      return { data: null, error: null }
    })

    const body = await (await POST(post() as any)).json()
    expect(body.ok).toBe(true)
    expect(body.editionsUpserted).toBe(1) // ek1 ok (once, deduped), ek2 errored
    expect(body.editionErrors).toBe(1)
    expect(body.batchSize).toBe(4)
  })

  it("builds sales from non-LISTED priced orders and bulk-inserts them", async () => {
    st.batch = [nft({
      orders: [
        { state: "LISTED", salePrice: 10 }, // skipped (listed)
        { state: "SOLD", salePrice: 0 }, // skipped (no price)
        { state: "SOLD", salePrice: 25, transactionId: "tx1", blockTimestamp: 1_700_000_000, storefrontAddress: "0xstore" }, // seconds → *1000
        { state: "SOLD", salePrice: 40, blockTimestamp: 1_700_000_000_000 }, // already ms
      ],
    })]
    let bulkArg: any = null
    rpc.mockImplementation(async (name: string, params?: any) => {
      if (name === "bulk_insert_pinnacle_sales") { bulkArg = JSON.parse(params.sales_json); return { data: 2, error: null } }
      return { data: null, error: null }
    })

    const body = await (await POST(post() as any)).json()
    expect(body.salesInserted).toBe(2)
    expect(bulkArg).toHaveLength(2) // 2 valid sales
    expect(bulkArg[0].sale_price).toBe(25)
    // seconds timestamp normalized to a 2023 ISO date
    expect(bulkArg[0].sold_at.startsWith("2023-")).toBe(true)
  })

  it("bulk-insert error is logged but does not fail the run", async () => {
    st.batch = [nft({ orders: [{ state: "SOLD", salePrice: 5, blockTimestamp: 1_700_000_000_000 }] })]
    rpc.mockImplementation(async (name: string) => {
      if (name === "bulk_insert_pinnacle_sales") return { data: null, error: { message: "sales down" } }
      return { data: null, error: null }
    })
    const body = await (await POST(post() as any)).json()
    expect(body.ok).toBe(true)
    expect(body.salesInserted).toBe(0)
    expect(body.log.some((l: string) => l.includes("Sales insert error"))).toBe(true)
  })

  it("done/nextOffset: a short batch marks done and nextOffset null; recalc flag is a no-op", async () => {
    st.batch = [nft()] // 1 < limit(100) → done
    const body = await (await POST(post("?token=tok&recalc=true") as any)).json()
    expect(body.done).toBe(true)
    expect(body.nextOffset).toBeNull()
    expect(body.recalcRan).toBe(true)
    expect(body.log.some((l: string) => l.includes("FMV recalc flag ignored"))).toBe(true)
  })

  it("a full batch (== limit) yields a numeric nextOffset (not done)", async () => {
    st.batch = Array.from({ length: 2 }, (_, i) => nft({ id: `n${i}`, nftView: { traits: { traits: [{ editionKey: `k${i}`, royaltyCode: "r" }] } } }))
    const body = await (await POST(post("?token=tok&limit=2&offset=10") as any)).json()
    expect(body.done).toBe(false)
    expect(body.nextOffset).toBe(12) // offset 10 + batch 2
  })

  it("a fetch throw → fatal 500 with the error in the log", async () => {
    st.batchThrows = true
    const res = await POST(post() as any)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.log.some((l: string) => l.includes("Fatal error"))).toBe(true)
  })
})
