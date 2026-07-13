import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  extractEditionKeyFromNft,
  flowtyNftToSniperDeals,
  fetchFlowtyPinnacleListings,
  fetchAllFlowtyPinnacleNfts,
  type FlowtyPinnacleNft,
} from "@/lib/pinnacle/pinnacleFlowty"

// lib/pinnacle/pinnacleFlowty.ts — pure parsers/mappers only (the fetch fns are
// skipped). extractEditionKeyFromNft reads the nftView traits into the composite
// "ROYALTY:VARIANT:PRINTING" edition key. flowtyNftToSniperDeals is deterministic
// when a real blockTimestamp is supplied (its only Date.now path is the missing-
// timestamp fallback, which we never exercise here).

function nft(
  traits: Record<string, string>,
  over: Partial<FlowtyPinnacleNft> = {},
): FlowtyPinnacleNft {
  return {
    id: "nft-1",
    owner: "0xowner",
    card: { title: "T", max: null, images: [{ url: "https://img/1.png" }] },
    nftView: {
      traits: {
        traits: Object.entries(traits).map(([name, value]) => ({ name, value })),
      },
    },
    orders: [],
    offers: [],
    ...over,
  }
}

describe("extractEditionKeyFromNft", () => {
  it("builds the edition key from RoyaltyCodes/Variant/Printing traits", () => {
    const out = extractEditionKeyFromNft(
      nft({
        RoyaltyCodes: "[WDAS-OEV1-LION]",
        Variant: "Golden",
        Printing: "2",
      }),
    )
    expect(out).toEqual({
      editionKey: "WDAS-OEV1-LION:Golden:2",
      royaltyCode: "WDAS-OEV1-LION",
      variant: "Golden",
      printing: 2,
    })
  })

  it("defaults Variant='Standard', printing=1, royaltyCode='' when traits missing", () => {
    const out = extractEditionKeyFromNft(nft({}))
    expect(out).toEqual({
      editionKey: ":Standard:1",
      royaltyCode: "",
      variant: "Standard",
      printing: 1,
    })
  })

  it("takes the first royalty code from a multi-value stringified array", () => {
    const out = extractEditionKeyFromNft(
      nft({ RoyaltyCodes: "[CODE-A, CODE-B]", Variant: "Standard" }),
    )
    expect(out.royaltyCode).toBe("CODE-A")
    expect(out.editionKey).toBe("CODE-A:Standard:1")
  })
})

describe("flowtyNftToSniperDeals", () => {
  const fmv = new Map([["OE-CODE:Standard:1", { fmv: 100, confidence: "HIGH" }]])

  function openEditionNft(salePrice: number, state = "LISTED"): FlowtyPinnacleNft {
    return nft(
      { RoyaltyCodes: "[OE-CODE]", Variant: "Standard", EditionType: "Open Edition" },
      {
        orders: [
          {
            salePrice,
            listingResourceID: "lr-1",
            storefrontAddress: "0xstore",
            state,
            listingKind: "sale",
            blockTimestamp: 1_700_000_000_000, // ms
            nftID: "nft-1",
            paymentTokenName: "DUC",
          },
        ],
      },
    )
  }

  it("returns [] when the royalty code is missing", () => {
    expect(flowtyNftToSniperDeals(nft({ Variant: "Standard" }), fmv)).toEqual([])
  })

  it("returns [] when the edition has no FMV entry", () => {
    expect(flowtyNftToSniperDeals(openEditionNft(50), new Map())).toEqual([])
  })

  it("returns [] when there are no LISTED orders", () => {
    expect(flowtyNftToSniperDeals(openEditionNft(50, "CANCELLED"), fmv)).toEqual([])
  })

  it("returns [] when the discount is below the 5% threshold", () => {
    // ask 98 vs fmv 100 -> 2% discount, filtered out
    expect(flowtyNftToSniperDeals(openEditionNft(98), fmv)).toEqual([])
  })

  it("maps a discounted LISTED order to one deal with deterministic fields", () => {
    const deals = flowtyNftToSniperDeals(openEditionNft(50), fmv)
    expect(deals).toHaveLength(1)
    const d = deals[0]
    expect(d.editionKey).toBe("OE-CODE:Standard:1")
    expect(d.askPrice).toBe(50)
    expect(d.baseFmv).toBe(100)
    expect(d.adjustedFmv).toBe(100) // OE -> serialMult 1.0
    expect(d.serialMult).toBe(1)
    expect(d.discount).toBe(50) // (100-50)/100 = 50%
    expect(d.confidence).toBe("HIGH")
    expect(d.source).toBe("pinnacle")
    expect(d.flowId).toBe("nft-1")
    expect(d.serial).toBeNull()
    expect(d.isSpecialSerial).toBe(false)
    expect(d.updatedAt).toBe(new Date(1_700_000_000_000).toISOString())
  })

  it("treats a seconds-grain blockTimestamp as seconds (x1000)", () => {
    const n = openEditionNft(50)
    n.orders[0].blockTimestamp = 1_700_000_000 // seconds
    const deals = flowtyNftToSniperDeals(n, fmv)
    expect(deals[0].updatedAt).toBe(new Date(1_700_000_000_000).toISOString())
  })

  // ── Added branch coverage ──────────────────────────────────────────────────

  it("skips orders with a non-positive salePrice but keeps a valid sibling order", () => {
    const n = openEditionNft(50)
    n.orders = [
      { ...n.orders[0], salePrice: 0, listingResourceID: "lr-zero" },
      { ...n.orders[0], salePrice: 50, listingResourceID: "lr-good" },
    ]
    const deals = flowtyNftToSniperDeals(n, fmv)
    expect(deals).toHaveLength(1)
    expect(deals[0].listingResourceID).toBe("lr-good")
  })

  it("emits one deal per LISTED discounted order", () => {
    const n = openEditionNft(50)
    n.orders = [
      { ...n.orders[0], salePrice: 50, listingResourceID: "lr-a" },
      { ...n.orders[0], salePrice: 40, listingResourceID: "lr-b" },
    ]
    const deals = flowtyNftToSniperDeals(n, fmv)
    expect(deals.map(d => d.listingResourceID)).toEqual(["lr-a", "lr-b"])
    expect(deals.map(d => d.discount)).toEqual([50, 60])
  })

  it("falls back to Date.now() when blockTimestamp is missing/zero", () => {
    const before = Date.now()
    const n = openEditionNft(50)
    n.orders[0].blockTimestamp = 0
    const deals = flowtyNftToSniperDeals(n, fmv)
    const ts = new Date(deals[0].updatedAt).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(Date.now())
  })

  it("defaults character/franchise/studio to 'Unknown', null thumbnail, and reads seriesYear", () => {
    // Limited Edition with a max mint count and no image; serial stays null so
    // serialMult remains 1.0 (LE without a serial number is not multiplied).
    const n = nft(
      {
        RoyaltyCodes: "[OE-CODE]",
        Variant: "Standard",
        EditionType: "Limited Edition",
        SeriesName: "2025",
      },
      {
        card: { title: "T", max: "99", images: [] },
        orders: [
          {
            salePrice: 50,
            listingResourceID: "lr-1",
            storefrontAddress: "0xstore",
            state: "LISTED",
            listingKind: "sale",
            blockTimestamp: 1_700_000_000_000,
            nftID: "nft-1",
            paymentTokenName: "DUC",
          },
        ],
      },
    )
    const deals = flowtyNftToSniperDeals(n, fmv)
    expect(deals).toHaveLength(1)
    const d = deals[0]
    expect(d.characterName).toBe("Unknown")
    expect(d.franchise).toBe("Unknown")
    expect(d.studio).toBe("Unknown")
    expect(d.thumbnailUrl).toBeNull()
    expect(d.seriesYear).toBe(2025)
    expect(d.editionType).toBe("Limited Edition")
    expect(d.mintCount).toBe(99)
    expect(d.serialMult).toBe(1)
  })

  it("nulls listingResourceID/storefrontAddress when the order omits them", () => {
    const n = openEditionNft(50)
    // strip the optional fields
    n.orders[0] = {
      salePrice: 50,
      state: "LISTED",
      listingKind: "sale",
      blockTimestamp: 1_700_000_000_000,
      nftID: "nft-1",
      paymentTokenName: "DUC",
    } as unknown as FlowtyPinnacleNft["orders"][number]
    const deals = flowtyNftToSniperDeals(n, fmv)
    expect(deals[0].listingResourceID).toBeNull()
    expect(deals[0].storefrontAddress).toBeNull()
  })

  it("returns [] when the NFT has no orders array at all", () => {
    const n = nft({ RoyaltyCodes: "[OE-CODE]", Variant: "Standard" })
    // @ts-expect-error deliberately drop orders to hit the `?? []` guard
    n.orders = undefined
    expect(flowtyNftToSniperDeals(n, fmv)).toEqual([])
  })
})

// ── Fetch layer (network seam mocked) ─────────────────────────────────────────

describe("fetchFlowtyPinnacleListings", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns nfts[] on a 200 response and sends the listedOnly=sale filter", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ address: "", nfts: [{ id: "n1" }], facets: [], total: 1 }),
    })
    const out = await fetchFlowtyPinnacleListings({ limit: 5, offset: 10 })
    expect(out).toEqual([{ id: "n1" }])
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body).toEqual({ filters: { listingKind: "sale" }, offset: 10, limit: 5 })
  })

  it("omits the listingKind filter when listedOnly=false", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ nfts: [] }),
    })
    await fetchFlowtyPinnacleListings({ listedOnly: false })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.filters).toEqual({})
  })

  it("returns [] and warns on a non-ok HTTP response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, statusText: "Service Unavailable", json: async () => ({}) })
    expect(await fetchFlowtyPinnacleListings()).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("returns [] when the body has no nfts field", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK", json: async () => ({}) })
    expect(await fetchFlowtyPinnacleListings()).toEqual([])
  })

  it("returns [] and warns on an AbortError (timeout)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" })
    fetchMock.mockRejectedValueOnce(abort)
    expect(await fetchFlowtyPinnacleListings()).toEqual([])
    expect(warn).toHaveBeenCalledWith("[pinnacle-flowty] Fetch timed out after", 8000, "ms")
    warn.mockRestore()
  })

  it("returns [] and logs on a generic fetch error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    fetchMock.mockRejectedValueOnce(new Error("network down"))
    expect(await fetchFlowtyPinnacleListings()).toEqual([])
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})

describe("fetchAllFlowtyPinnacleNfts", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function page(nfts: unknown[]) {
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ nfts }) }
  }

  it("stops paginating when a partial (short) page is returned", async () => {
    fetchMock
      .mockResolvedValueOnce(page([{ id: "a" }, { id: "b" }])) // full batch (2 of 2)
      .mockResolvedValueOnce(page([{ id: "c" }])) // short page → last
    const out = await fetchAllFlowtyPinnacleNfts({ batchSize: 2 })
    expect(out.map((n: FlowtyPinnacleNft) => n.id)).toEqual(["a", "b", "c"])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("stops paginating when an empty page is returned", async () => {
    fetchMock
      .mockResolvedValueOnce(page([{ id: "a" }, { id: "b" }]))
      .mockResolvedValueOnce(page([]))
    const out = await fetchAllFlowtyPinnacleNfts({ batchSize: 2 })
    expect(out).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("honors maxTotal, never advancing past the cap", async () => {
    fetchMock.mockResolvedValue(page([{ id: "x" }, { id: "y" }]))
    const out = await fetchAllFlowtyPinnacleNfts({ batchSize: 2, maxTotal: 4 })
    // offset walks 0,2 then 4 >= maxTotal stops → exactly 2 fetches
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(out).toHaveLength(4)
  })
})
