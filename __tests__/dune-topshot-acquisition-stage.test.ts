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

describe("mapProvenanceStageRow (#190 provenance lane)", () => {
  const raw = {
    id: "309780",
    w: "0x26ae10d4d65856f", // Dune strips the leading zero
    dt: "2021-02-01",
    h: 12345,
    tx: "a".repeat(64),
    k: "P",
    p: null,
    f: "0xe1f2a091f7bb5245",
  }
  it("restores the stripped leading zero and stamps the execution", async () => {
    const { mapProvenanceStageRow } = await import("@/lib/dune/topshot-acquisition-stage")
    const row = mapProvenanceStageRow(raw, "EXEC9")
    expect(row?.wallet).toBe("0x026ae10d4d65856f")
    expect(row?.kind).toBe("P")
    expect(row?.price).toBeNull()
    expect(row?.dune_execution_id).toBe("EXEC9")
  })
  it("rejects an unknown kind rather than guessing one", async () => {
    const { mapProvenanceStageRow } = await import("@/lib/dune/topshot-acquisition-stage")
    expect(mapProvenanceStageRow({ ...raw, k: "Q" }, "E")).toBeNull()
  })
})

describe("stage route lanes", () => {
  it("refuses an unknown lane", async () => {
    process.env.CRON_SECRET = process.env.CRON_SECRET || "test-cron-secret"
    const { GET } = await import("@/app/api/cron/stage-topshot-acquisitions-dune/route")
    const { NextRequest } = await import("next/server")
    const res = await GET(
      new NextRequest("https://example.test/api/cron/stage-topshot-acquisitions-dune?lane=bogus", {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe("mapHopRow (#190 transfer hop)", () => {
  const raw = {
    id: "16791499",
    w: "0x97168ff5c33d01f",
    f: "0xb7c1ef3c66096640",
    tdt: "2022-03-04",
    htx: "B".repeat(64),
    hdt: "2022-03-04",
    hk: "MP",
    hp: "12.5",
    hf: "0x1234",
  }
  it("pads both addresses and parses the sender's price", async () => {
    const { mapHopRow } = await import("@/lib/dune/topshot-acquisition-stage")
    const r = mapHopRow(raw, "E1")
    expect(r?.wallet).toBe("0x097168ff5c33d01f")
    expect(r?.sender).toBe("0xb7c1ef3c66096640")
    expect(r?.hop_tx).toBe("b".repeat(64))
    expect(r?.hop_price).toBe(12.5)
    expect(r?.hop_from).toBe("0x0000000000001234")
  })
  it("rejects a row with no sender rather than inventing one", async () => {
    const { mapHopRow } = await import("@/lib/dune/topshot-acquisition-stage")
    expect(mapHopRow({ ...raw, f: null }, "E1")).toBeNull()
  })
})
