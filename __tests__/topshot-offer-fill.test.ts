import { describe, it, expect, beforeEach, vi } from "vitest"

// Pure decode helpers for DapperOffers OfferCompleted → sale-row fills. Offer-fill
// attribution has been a real bug surface (buyer/seller swap, parallel mis-keying,
// the offer_fill guard), and these parsers are where a fill is classified before
// it becomes a sales row. The buildOfferFillSales / stampOfferFillTxHashes /
// insertOfferFillSales DB seam is driven through a mutable `state` + thenable
// Supabase stub that routes each read/write by table + selected columns.

const H = vi.hoisted(() => {
  const state: any = {
    editionsByExt: [] as any[], // select "external_id, id"
    moments: [] as any[],
    offers: [] as any[],
    wmc: [] as any[],
    editionsById: [] as any[], // select "id, external_id, circulation_count"
    baseEditions: [] as any[], // select "id, external_id"
    salesInsertError: null as any,
    salesInsertThrows: false,
    stampError: null as any,
    stampCount: 1,
  }

  function resolve(ctx: any) {
    if (ctx.table === "sales" && ctx.op === "insert") {
      if (state.salesInsertThrows) throw new Error("insert blew up")
      return { data: null, error: state.salesInsertError }
    }
    if (ctx.table === "offers" && ctx.op === "update") {
      return { data: null, error: state.stampError, count: state.stampError ? null : state.stampCount }
    }
    if (ctx.table === "editions") {
      if ((ctx.select ?? "").includes("circulation_count")) return { data: state.editionsById, error: null }
      if (ctx.select === "id, external_id") return { data: state.baseEditions, error: null }
      return { data: state.editionsByExt, error: null } // "external_id, id"
    }
    if (ctx.table === "moments") return { data: state.moments, error: null }
    if (ctx.table === "offers") return { data: state.offers, error: null }
    if (ctx.table === "wallet_moments_cache") return { data: state.wmc, error: null }
    return { data: [], error: null }
  }

  function makeClient() {
    return {
      from(table: string) {
        const ctx: any = { table, op: "select", select: undefined, inField: undefined }
        const b: any = {}
        const chain = (m: string) => (...args: any[]) => {
          if (m === "select") ctx.select = args[0]
          if (m === "insert") ctx.op = "insert"
          if (m === "update") ctx.op = "update"
          if (m === "in") ctx.inField = args[0]
          return b
        }
        for (const m of ["select", "eq", "neq", "in", "is", "gt", "order", "limit", "insert", "update"]) {
          b[m] = chain(m)
        }
        b.then = (res: any, rej: any) => {
          try {
            return res(resolve(ctx))
          } catch (e) {
            if (rej) return rej(e)
            throw e
          }
        }
        return b
      },
    }
  }

  return { state, client: makeClient() }
})

vi.mock("@/lib/supabase", () => ({ supabase: H.client, supabaseAdmin: H.client }))

import {
  extractNftTypeId,
  isTopShotNftType,
  normAddr,
  parseOfferCompletedFill,
  buildOfferFillSales,
  stampOfferFillTxHashes,
  insertOfferFillSales,
  TS_COLLECTION_ID,
  type OfferFillEvent,
} from "@/lib/chains/flow/topshot-offer-fill"

describe("extractNftTypeId", () => {
  it("passes a plain string type id through", () => {
    expect(extractNftTypeId("A.0b2a3299cc857e29.TopShot.NFT")).toBe("A.0b2a3299cc857e29.TopShot.NFT")
  })
  it("reads staticType as a string", () => {
    expect(extractNftTypeId({ staticType: "A.x.TopShot.NFT" })).toBe("A.x.TopShot.NFT")
  })
  it("reads a nested staticType.typeID", () => {
    expect(extractNftTypeId({ staticType: { typeID: "A.x.TopShot.NFT" } })).toBe("A.x.TopShot.NFT")
  })
  it("returns undefined for unrecognized shapes", () => {
    expect(extractNftTypeId(null)).toBeUndefined()
    expect(extractNftTypeId(42)).toBeUndefined()
    expect(extractNftTypeId({})).toBeUndefined()
  })
})

describe("isTopShotNftType", () => {
  it("is true only for a *.TopShot.NFT type id", () => {
    expect(isTopShotNftType("A.0b2a3299cc857e29.TopShot.NFT")).toBe(true)
    expect(isTopShotNftType({ staticType: { typeID: "A.x.TopShot.NFT" } })).toBe(true)
  })
  it("is false for AllDay / unknown / missing types", () => {
    expect(isTopShotNftType("A.e4cf4bdc1751c65d.AllDay.NFT")).toBe(false)
    expect(isTopShotNftType(null)).toBe(false)
  })
})

describe("normAddr", () => {
  it("lowercases and normalizes the 0x prefix", () => {
    expect(normAddr("0xBD94CADE097E50AC")).toBe("0xbd94cade097e50ac")
    expect(normAddr("bd94cade097e50ac")).toBe("0xbd94cade097e50ac")
    expect(normAddr("  0xAbC  ")).toBe("0xabc")
  })
  it("returns null for null/empty", () => {
    expect(normAddr(null)).toBeNull()
    expect(normAddr(undefined)).toBeNull()
    expect(normAddr("0x")).toBeNull()
  })
})

describe("parseOfferCompletedFill", () => {
  const base = {
    purchased: true,
    nftType: "A.0b2a3299cc857e29.TopShot.NFT",
    offerId: "555",
    offerAmount: "120.0",
    nftId: "987",
    offerAddress: "0xBUYER00000000",
    acceptingAddress: "0xSELLER0000000",
    offerParamsString: { _type: "TopShotEdition", setId: "84", playId: "2892" },
  }

  it("parses an edition offer fill: buyer/seller normalized, externalId setId:playId", () => {
    const f = parseOfferCompletedFill(base, "0xfilltx", "2026-07-01T00:00:00Z", 100)!
    expect(f).not.toBeNull()
    expect(f.offerId).toBe("555")
    expect(f.offerType).toBe("edition")
    expect(f.externalId).toBe("84:2892")
    expect(f.buyer).toBe("0xbuyer00000000")
    expect(f.seller).toBe("0xseller0000000")
    expect(f.amount).toBe(120)
    expect(f.nftId).toBe("987")
  })

  it("classifies a subedition offer", () => {
    const f = parseOfferCompletedFill(
      { ...base, offerParamsString: { _type: "TopShotSubedition", setId: "84", playId: "2892" } },
      "0xtx", "t", null,
    )!
    expect(f.offerType).toBe("subedition")
    expect(f.externalId).toBe("84:2892")
  })

  it("classifies a serial (NFT) offer with no externalId", () => {
    const f = parseOfferCompletedFill({ ...base, offerParamsString: { _type: "NFT" } }, "0xtx", "t", null)!
    expect(f.offerType).toBe("serial")
    expect(f.externalId).toBeNull()
  })

  it("classifies an unknown offer type", () => {
    const f = parseOfferCompletedFill({ ...base, offerParamsString: {} }, "0xtx", "t", null)!
    expect(f.offerType).toBe("unknown")
  })

  it("returns null for a cancelled offer (purchased !== true)", () => {
    expect(parseOfferCompletedFill({ ...base, purchased: false }, "0xtx", "t", null)).toBeNull()
  })

  it("returns null for a non-TopShot nft type", () => {
    expect(parseOfferCompletedFill({ ...base, nftType: "A.x.AllDay.NFT" }, "0xtx", "t", null)).toBeNull()
  })

  it("returns null when offerId or fillTx is missing", () => {
    expect(parseOfferCompletedFill({ ...base, offerId: null }, "0xtx", "t", null)).toBeNull()
    expect(parseOfferCompletedFill(base, "", "t", null)).toBeNull()
  })

  it("tolerates a non-positive amount (leaves it NaN for the offers-row fallback)", () => {
    const f = parseOfferCompletedFill({ ...base, offerAmount: "0" }, "0xtx", "t", null)!
    expect(Number.isNaN(f.amount)).toBe(true)
  })
})

// ── DB seam: build / stamp / insert ───────────────────────────────────────────
function fill(over: Partial<OfferFillEvent> = {}): OfferFillEvent {
  return {
    offerId: "1",
    fillTx: "0xtx1",
    blockTs: "2024-01-01T00:00:00Z",
    blockHeight: 100,
    buyer: "0xbbbbbbbbbbbbbbbb",
    seller: "0xssssssssssssssss",
    amount: 50,
    nftId: null,
    offerType: "edition",
    externalId: null,
    ...over,
  }
}

beforeEach(() => {
  H.state.editionsByExt = []
  H.state.moments = []
  H.state.offers = []
  H.state.wmc = []
  H.state.editionsById = []
  H.state.baseEditions = []
  H.state.salesInsertError = null
  H.state.salesInsertThrows = false
  H.state.stampError = null
  H.state.stampCount = 1
})

describe("buildOfferFillSales", () => {
  it("returns empty result for no fills", async () => {
    const out = await buildOfferFillSales([])
    expect(out).toEqual({ rows: [], unresolved: 0, serialsResolved: 0, parallelRedirects: 0 })
  })

  it("resolves edition + serial via moments (path 1) and builds a sale row", async () => {
    H.state.moments = [{ nft_id: "999", edition_id: "ed-1", serial_number: 7 }]
    H.state.editionsById = [{ id: "ed-1", external_id: "5:10", circulation_count: 100 }]
    const out = await buildOfferFillSales([fill({ nftId: "999", externalId: "5:10" })])
    expect(out.rows).toHaveLength(1)
    expect(out.serialsResolved).toBe(1)
    const r = out.rows[0]
    expect(r.edition_id).toBe("ed-1")
    expect(r.serial_number).toBe(7)
    expect(r.price_usd).toBe(50)
    expect(r.collection_id).toBe(TS_COLLECTION_ID)
    expect(r.source).toBe("offer_fill")
    expect(r.transaction_hash).toBe("0xtx1")
    expect(r.buyer_address).toBe("0xbbbbbbbbbbbbbbbb")
    expect(r.seller_address).toBe("0xssssssssssssssss")
  })

  it("falls back to editions-by-external_id when the moment is absent (path 2)", async () => {
    H.state.editionsByExt = [{ external_id: "5:10", id: "ed-ext" }]
    const out = await buildOfferFillSales([fill({ nftId: null, externalId: "5:10" })])
    expect(out.rows[0].edition_id).toBe("ed-ext")
    expect(out.rows[0].serial_number).toBeNull()
  })

  it("falls back to the offers row for edition + serial + buyer + price (path 3)", async () => {
    H.state.offers = [{ offer_id: "1", edition_id: "ed-off", serial_number: 3, buyer_address: "0xCCCCCCCCCCCCCCCC", offer_amount_usd: 12 }]
    const out = await buildOfferFillSales([fill({ nftId: null, externalId: null, buyer: null, amount: NaN })])
    const r = out.rows[0]
    expect(r.edition_id).toBe("ed-off")
    expect(r.serial_number).toBe(3)
    expect(r.buyer_address).toBe("0xcccccccccccccccc")
    expect(r.price_usd).toBe(12)
  })

  it("fills a serial-0 gap from wallet_moments_cache (step 2b)", async () => {
    H.state.moments = [{ nft_id: "999", edition_id: "ed-1", serial_number: null }]
    H.state.editionsById = [{ id: "ed-1", external_id: "5:10", circulation_count: 100 }]
    H.state.wmc = [{ moment_id: "999", serial_number: 42 }]
    const out = await buildOfferFillSales([fill({ nftId: "999" })])
    expect(out.rows[0].serial_number).toBe(42)
    expect(out.serialsResolved).toBe(1)
  })

  it("counts an unresolved fill when no edition resolves", async () => {
    const out = await buildOfferFillSales([fill({ nftId: "404", externalId: null, offerId: "nope" })])
    expect(out.rows).toHaveLength(0)
    expect(out.unresolved).toBe(1)
  })

  it("F1 guard: redirects an impossible-serial parallel onto its base edition", async () => {
    H.state.moments = [{ nft_id: "999", edition_id: "ed-par", serial_number: 910 }]
    H.state.editionsById = [{ id: "ed-par", external_id: "5:10::18", circulation_count: 50 }]
    H.state.baseEditions = [{ id: "ed-base", external_id: "5:10" }]
    const out = await buildOfferFillSales([fill({ nftId: "999" })])
    expect(out.parallelRedirects).toBe(1)
    expect(out.rows[0].edition_id).toBe("ed-base")
  })

  it("collapses fills sharing a fill tx to one row", async () => {
    H.state.editionsByExt = [{ external_id: "5:10", id: "ed-ext" }]
    const out = await buildOfferFillSales([
      fill({ offerId: "1", fillTx: "0xsame", externalId: "5:10" }),
      fill({ offerId: "2", fillTx: "0xsame", externalId: "5:10" }),
    ])
    expect(out.rows).toHaveLength(1)
  })
})

describe("stampOfferFillTxHashes", () => {
  it("stamps each distinct offer's fill tx and sums the update counts", async () => {
    H.state.stampCount = 1
    const out = await stampOfferFillTxHashes([
      fill({ offerId: "a", fillTx: "0xta" }),
      fill({ offerId: "b", fillTx: "0xtb" }),
      fill({ offerId: "a", fillTx: "0xta-dup" }), // first fill tx wins per offer
    ])
    expect(out.stamped).toBe(2)
  })

  it("skips an offer on an update error and keeps going", async () => {
    H.state.stampError = { message: "update boom" }
    const out = await stampOfferFillTxHashes([fill({ offerId: "a", fillTx: "0xta" })])
    expect(out.stamped).toBe(0)
  })
})

describe("insertOfferFillSales", () => {
  const rows = [{ transaction_hash: "0x1" }, { transaction_hash: "0x2" }]

  it("inserts a clean batch", async () => {
    const out = await insertOfferFillSales(rows)
    expect(out).toEqual({ inserted: 2, duped: 0 })
  })

  it("retries per-row on a 23505 batch error and counts dupes", async () => {
    H.state.salesInsertError = { code: "23505", message: "duplicate key" }
    const out = await insertOfferFillSales(rows)
    expect(out.duped).toBe(2)
    expect(out.inserted).toBe(0)
  })

  it("treats a non-23505 batch error as all-duped without a per-row retry", async () => {
    H.state.salesInsertError = { code: "XX999", message: "boom" }
    const out = await insertOfferFillSales(rows)
    expect(out.duped).toBe(2)
    expect(out.inserted).toBe(0)
  })

  it("falls into the catch path when the insert throws", async () => {
    H.state.salesInsertThrows = true
    const out = await insertOfferFillSales(rows)
    expect(out.duped).toBe(2)
    expect(out.inserted).toBe(0)
  })
})
