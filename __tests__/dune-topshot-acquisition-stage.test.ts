import { describe, it, expect } from "vitest"
import { mapStageRow, STAGE_QUERY_ID } from "@/lib/dune/topshot-acquisition-stage"

const good = {
  wallet: "0x75b51fecb785006f",
  nft_id: "17474038",
  acquired_at: "2021-03-01 12:34:56.000 UTC",
  tx_hash: "abc123",
  price: 42.5,
  market: "A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased",
  seller: "0x0123456789abcdef",
}

describe("mapStageRow (#190 stage)", () => {
  it("maps a Dune buy row and stamps the query and execution", () => {
    expect(mapStageRow(good, "EXEC1")).toEqual({
      wallet: "0x75b51fecb785006f",
      nft_id: "17474038",
      acquired_at: "2021-03-01T12:34:56.000Z",
      tx_hash: "abc123",
      price_usd: 42.5,
      market: good.market,
      seller: "0x0123456789abcdef",
      dune_query_id: STAGE_QUERY_ID,
      dune_execution_id: "EXEC1",
    })
  })

  it("does not fold a non-canonical wallet into a valid one — it skips it", () => {
    expect(mapStageRow({ ...good, wallet: "0x75B51FECB785006F" }, "E")).toBeNull()
    expect(mapStageRow({ ...good, wallet: "75b51fecb785006f" }, "E")).toBeNull()
  })

  it("never stages a row without a real price as a $0 cost", () => {
    expect(mapStageRow({ ...good, price: null }, "E")).toBeNull()
    expect(mapStageRow({ ...good, price: "12" }, "E")).toBeNull()
    expect(mapStageRow({ ...good, price: -1 }, "E")).toBeNull()
  })

  it("skips a non-numeric moment id and an unparseable time", () => {
    expect(mapStageRow({ ...good, nft_id: "2934cb96-057d-471a" }, "E")).toBeNull()
    expect(mapStageRow({ ...good, acquired_at: "yesterday" }, "E")).toBeNull()
  })

  it("keeps the row but drops a malformed seller to null", () => {
    expect(mapStageRow({ ...good, seller: "nope" }, "E")?.seller).toBeNull()
  })
})

describe("app/api/cron/stage-topshot-acquisitions-dune/route.ts", () => {
  it("refuses an unauthenticated caller before touching Dune or the DB", async () => {
    const { GET } = await import("@/app/api/cron/stage-topshot-acquisitions-dune/route")
    const { NextRequest } = await import("next/server")
    const res = await GET(new NextRequest("https://example.test/api/cron/stage-topshot-acquisitions-dune"))
    expect(res.status).toBe(401)
  })
})
