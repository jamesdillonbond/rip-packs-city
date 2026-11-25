import { describe, it, expect } from "vitest"
import {
  atlasMintedCounts,
  mintedCountRaises,
  atlasEditionToCatalogRow,
  atlasErrorMessage,
  atlasLowAskCents,
  atlasMetaJsonList,
  atlasMetaList,
  atlasNftRender,
  atlasOpenListing,
  dbAtlasDisneyCall,
  isRetryableAtlasFailure,
  sweepAtlasEditions,
  sweepAtlasOpenListings,
  type AtlasCallResult,
} from "@/lib/pinnacle/atlas-disney"

// Pins the Atlas parsing behind the Disney Pinnacle lanes (2026-11-18, #218 — Studio
// GraphQL dead since 11-17). Fixtures are trimmed copies of live Atlas responses
// captured 11-18 (assets dropped); the expected rows are what pinnacle_catalog
// already held for the same pins (2,970 of 2,970 reproduced live).

// EditionService/SearchEditions → editions[0], live 11-18 (OEV2-WDMG-OWL-S5).
const OWL = {
  id: "2979",
  seriesId: "4",
  setId: "195",
  editionTemplateId: "1053",
  tier: "",
  maxMintSize: "43",
  numMinted: "43",
  metadata: { Color: "FULL COLOR", Effects: "LED GLITCH", Materials: "GOLD", Size: "MEDIUM", Thickness: "MEDIUM THIN" },
  series: { id: "4", name: "2026", active: true, metadata: {} },
  set: { id: "195", name: "Walt Disney Animation Studios • Walt Disney Mugs Vol.2", metadata: {}, renderId: "OEV2-WDMG" },
  editionTemplate: {
    id: "1053",
    metadata: {
      Categories: "Disney",
      Characters: "Owl",
      Franchises: "Winnie the Pooh",
      RoyaltyCodes: "WDAS-OEV2-WDMG",
      Studios: "Walt Disney Animation Studios",
    },
    editionType: "Open Edition",
    renderId: "OEV2-WDMG-OWL",
    name: "Owl",
  },
  parallel: "Digital Display",
  lowAskCents: "4400",
  renderId: "OEV2-WDMG-OWL-S5",
  chaser: true,
  printing: "1",
  numListed: "3",
}

describe("atlasEditionToCatalogRow — the pin key is the EDITION renderId", () => {
  const limited = new Map<string, boolean | null>([["Open Edition", false], ["Legendary Edition", true]])

  it("maps a live edition onto the catalog columns", () => {
    const row = atlasEditionToCatalogRow(OWL, "2026-11-18T00:00:00.000Z", limited)!
    expect(row).toMatchObject({
      render_id: "OEV2-WDMG-OWL-S5",
      edition_id: "2979",
      shape_render_id: "OEV2-WDMG-OWL",
      character_name: "Owl",
      set_name: "Walt Disney Animation Studios • Walt Disney Mugs Vol.2",
      set_render_id: "OEV2-WDMG",
      variant: "Digital Display",
      printing: 1,
      total_minted: 43,
      edition_type: "Open Edition",
      limited_edition: false,
      series_name: "2026",
      royalty_code: "WDAS-OEV2-WDMG",
      royalty_codes: ["WDAS-OEV2-WDMG"],
      franchises: ["Winnie the Pooh"],
      characters: ["Owl"],
      color: "FULL COLOR",
      effects: '["LED GLITCH"]',
      materials: '["GOLD"]',
      size: "MEDIUM",
      thickness: "MEDIUM THIN",
      is_chaser: true,
      legacy_edition_key: "WDAS-OEV2-WDMG:Digital Display:1",
      source: "atlas-edition-search",
    })
  })

  it("⚠ never keys a row on set.renderId (set-level) — no edition renderId, no row", () => {
    expect(atlasEditionToCatalogRow({ ...OWL, renderId: undefined }, "t", limited)).toBeNull()
    expect(atlasEditionToCatalogRow({ ...OWL, renderId: "" }, "t", limited)).toBeNull()
    expect(atlasEditionToCatalogRow({ ...OWL, id: undefined }, "t", limited)).toBeNull()
  })

  it("an edition type the catalog has no single answer for writes limited_edition null", () => {
    const row = atlasEditionToCatalogRow({ ...OWL, editionTemplate: { ...OWL.editionTemplate, editionType: "Brand New Edition" } }, "t", limited)!
    expect(row.limited_edition).toBeNull()
  })

  it("an absent chaser flag is unknown (null), not false", () => {
    const noChaser: Record<string, unknown> = { ...OWL }
    delete noChaser.chaser
    expect(atlasEditionToCatalogRow(noChaser, "t", limited)!.is_chaser).toBeNull()
  })
})

describe("Atlas list metadata — both serialisations", () => {
  it("splits the comma-joined form (live: Legendary Edition, 'Mother Gothel,Stabbington Brothers')", () => {
    expect(atlasMetaList("Mother Gothel,Stabbington Brothers")).toEqual(["Mother Gothel", "Stabbington Brothers"])
    expect(atlasMetaJsonList("INTERACTIVE MOVEMENT,INTERACTIVE ANIMATION")).toBe('["INTERACTIVE MOVEMENT","INTERACTIVE ANIMATION"]')
  })

  it("parses the JSON form and keeps elements VERBATIM ('Lady ' stays 'Lady ' — the character pages key on it)", () => {
    expect(atlasMetaList('["Lady "]')).toEqual(["Lady "])
    expect(atlasMetaList('["PAS-LEEV1-PXMS"]')).toEqual(["PAS-LEEV1-PXMS"])
    // a JSON-array effects value is kept exactly as Dapper sent it
    expect(atlasMetaJsonList('["ANIMATED BACKGROUND"]')).toBe('["ANIMATED BACKGROUND"]')
  })

  it("'null', '' and absent are absent — never a one-element list", () => {
    for (const v of ["null", "", null, undefined]) {
      expect(atlasMetaList(v)).toBeNull()
      expect(atlasMetaJsonList(v)).toBeNull()
    }
  })
})

describe("floors and listings", () => {
  it("lowAskCents '0' is NOT a $0 floor — it means nothing is listed", () => {
    expect(atlasLowAskCents({ lowAskCents: "0" })).toBeNull()
    expect(atlasLowAskCents({})).toBeNull()
    expect(atlasLowAskCents({ lowAskCents: "4400" })).toBe(4400)
  })

  // MarketplaceService/SearchMarketplaceTransactions → transactions[0], live 11-18.
  const TX = {
    uuid: "cfd39dce-4d36-50e4-8670-732c664054eb",
    priceCents: "100",
    sellerAddress: "08f1168f7d66a6df",
    nftId: "236395002787793",
    editionId: "2960",
    nftType: "A.edf9df96c92f4595.Pinnacle.NFT",
    serialNumber: "0",
    completed: false,
    purchased: false,
    listedAt: "2026-11-19T02:06:52.393858Z",
  }

  it("an open listing keeps nft, edition and cents; serial 0 (open edition) is no serial", () => {
    expect(atlasOpenListing(TX)).toEqual({ uuid: TX.uuid, nft_id: "236395002787793", edition_id: "2960", price_cents: 100, serial_number: null })
    expect(atlasOpenListing({ ...TX, serialNumber: "12" })!.serial_number).toBe(12)
  })

  it("a completed or purchased transaction is a SALE, never an open listing", () => {
    expect(atlasOpenListing({ ...TX, completed: true })).toBeNull()
    expect(atlasOpenListing({ ...TX, purchased: true })).toBeNull()
    expect(atlasOpenListing({ ...TX, priceCents: "0" })).toBeNull()
  })
})

describe("NFTService/GetNFTs → render id (the wmc render-id fallback)", () => {
  it("reads the NFT's renderId (live: 279275956193913 → OEEV1-D231-LUKE-E2) and drops serial 0", () => {
    expect(
      atlasNftRender({ id: "279275956193913", editionId: "2462", serialNumber: "0", renderId: "OEEV1-D231-LUKE-E2", edition: { renderId: "OEEV1-D231-LUKE-E2" } }),
    ).toEqual({ id: "279275956193913", serial: null, render_id: "OEEV1-D231-LUKE-E2" })
  })
  it("falls back to the edition's renderId, and an id-less entry is no NFT", () => {
    expect(atlasNftRender({ id: "5", serialNumber: "3", edition: { renderId: "R" } })).toEqual({ id: "5", serial: 3, render_id: "R" })
    expect(atlasNftRender({ serialNumber: "3" })).toBeNull()
  })
})

describe("dbAtlasDisneyCall — the pg_net transport", () => {
  function fakeDb(replies: unknown[]) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
    let n = 0
    let i = 0
    return {
      calls,
      db: {
        rpc: async (fn: string, args: Record<string, unknown>) => {
          calls.push({ fn, args })
          if (fn === "atlas_disney_begin") return { data: ++n, error: null }
          return { data: replies[Math.min(i++, replies.length - 1)], error: null }
        },
      },
    }
  }
  const noSleep = async () => {}

  it("begins then awaits, and returns the body", async () => {
    const { db, calls } = fakeDb([{ ok: true, body: { editions: [] } }])
    const r = await dbAtlasDisneyCall(db, { sleep: noSleep })("EditionService/SearchEditions", { product: "disney", limit: 100, offset: 0 })
    expect(r).toEqual({ ok: true, body: { editions: [] } })
    expect(calls.map((c) => c.fn)).toEqual(["atlas_disney_begin", "atlas_await_response"])
    expect(calls[0].args).toEqual({ p_method: "EditionService/SearchEditions", p_body: { product: "disney", limit: 100, offset: 0 } })
    expect(calls[1].args).toMatchObject({ p_request_id: 1 })
  })

  it("retries a Cloudflare challenge (HTML 403), then succeeds", async () => {
    const { db, calls } = fakeDb([
      { ok: false, status: 403, error: "<!DOCTYPE html><html><head><title>Just a moment...</title>" },
      { ok: true, body: { nfts: [] } },
    ])
    const r = await dbAtlasDisneyCall(db, { sleep: noSleep })("NFTService/GetNFTs", { nftIds: ["1"] })
    expect(r.ok).toBe(true)
    expect(calls.filter((c) => c.fn === "atlas_disney_begin")).toHaveLength(2)
  })

  it("⚠ a persistent challenge comes back as a FAILURE carrying its status — never an empty body", async () => {
    const { db } = fakeDb([{ ok: false, status: 403, error: "<!DOCTYPE html>Just a moment..." }])
    const r = (await dbAtlasDisneyCall(db, { sleep: noSleep, attempts: 3 })("NFTService/GetNFTs", { nftIds: ["1"] })) as Extract<AtlasCallResult, { ok: false }>
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
    expect(atlasErrorMessage("NFTService/GetNFTs", r)).toBe("atlas GetNFTs HTTP 403 (Cloudflare challenge)")
  })

  it("a 4xx that is not a challenge is not retried", async () => {
    const { db, calls } = fakeDb([{ ok: false, status: 400, error: '{"code":"invalid_argument","message":"series_id is required"}' }])
    const r = await dbAtlasDisneyCall(db, { sleep: noSleep })("MarketplaceService/SearchMarketplaceTransactions", {})
    expect(r.ok).toBe(false)
    expect(calls.filter((c) => c.fn === "atlas_disney_begin")).toHaveLength(1)
    expect(isRetryableAtlasFailure({ status: 400, error: "" })).toBe(false)
    expect(isRetryableAtlasFailure({ status: 530, error: "" })).toBe(true)
  })

  it("a failed begin RPC (migration not applied) is a failure naming the function", async () => {
    const db = { rpc: async () => ({ data: null, error: { message: "function public.atlas_disney_begin does not exist" } }) }
    const r = (await dbAtlasDisneyCall(db, { sleep: noSleep })("EditionService/SearchEditions", {})) as Extract<AtlasCallResult, { ok: false }>
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/^atlas_disney_begin: function public.atlas_disney_begin does not exist/)
  })
})

describe("sweepAtlasEditions", () => {
  const page = (editions: unknown[], total: number, offset: number, limit = 100): AtlasCallResult => ({
    ok: true,
    body: { editions, pagination: { totalCount: String(total), limit: String(limit), offset: String(offset), hasMore: offset + limit < total } },
  })

  it("plans the pages from the first page's totalCount and reads them all", async () => {
    const asked: number[] = []
    const all = Array.from({ length: 250 }, (_, i) => ({ id: String(i), renderId: `r${i}` }))
    const s = await sweepAtlasEditions(async (_m, b) => {
      const o = Number(b.offset)
      asked.push(o)
      return page(all.slice(o, o + 100), 250, o)
    })
    expect(asked.sort((a, b) => a - b)).toEqual([0, 100, 200])
    expect(s).toMatchObject({ complete: true, pages: 3, totalCount: 250, errors: [] })
    expect(s.editions).toHaveLength(250)
  })

  it("⚠ fewer distinct editions than totalCount (a page repeated another) is NOT complete", async () => {
    const all = Array.from({ length: 200 }, (_, i) => ({ id: String(i), renderId: `r${i}` }))
    // Offset paging over a moving set: page 2 hands back page 1's rows again.
    const s = await sweepAtlasEditions(async (_m, b) => page(all.slice(0, 100), 200, Number(b.offset)))
    expect(s.complete).toBe(false)
    expect(s.errors[0]).toMatch(/editions sweep incomplete: 100 distinct of 200/)
  })

  it("a failed first page is a failure with its status, and no editions", async () => {
    const s = await sweepAtlasEditions(async () => ({ ok: false, status: 530, error: "error code: 1033" }))
    expect(s).toMatchObject({ complete: false, editions: [] })
    expect(s.errors[0]).toBe("atlas SearchEditions HTTP 530 (error code: 1033)")
  })
})

describe("sweepAtlasOpenListings (2026-11-24)", () => {
  const tx = (i: number) => ({ uuid: `u${i}`, nftId: String(1000 + i), editionId: `e${i % 7}`, priceCents: 500 + i, serialNumber: i + 1 })
  const ok = (body: unknown): AtlasCallResult => ({ ok: true, body })
  it("a full walk to an explicit empty page is complete", async () => {
    const s = await sweepAtlasOpenListings(async (_m, b) =>
      Number(b.offset) === 0 ? ok({ transactions: [tx(1), tx(2)], pagination: { hasMore: false } }) : ok({ transactions: [] }),
    { concurrency: 1 })
    expect(s.complete).toBe(true)
    expect(s.listings).toHaveLength(2)
  })
  it("a 200 with NO transactions array is an error, never the end of a complete sweep", async () => {
    // A complete sweep lets the backfill replace pinnacle_live_listings — a partial one would delete the rest.
    const full = Array.from({ length: 200 }, (_, i) => tx(i))
    const s = await sweepAtlasOpenListings(async (_m, b) => (Number(b.offset) === 0 ? ok({ transactions: full }) : ok({ error: "upstream hiccup" })), { concurrency: 1 })
    expect(s.complete).toBe(false)
    expect(s.errors.join(" ")).toMatch(/no transactions array/)
  })
})

// 2026-11-25: the 6-hourly floors_only run raises pinnacle_catalog.total_minted to Atlas's live numMinted.
describe("live mint counts — raise-only", () => {
  it("reads render → numMinted and leaves out an edition with no render id or no count (never 0)", () => {
    const m = atlasMintedCounts([
      { renderId: "OEV2-WDMG-WINN-S2", numMinted: "640" },
      { renderId: "OEV2-WDMG-OWL-S2", numMinted: 603 },
      { renderId: "NO-COUNT", numMinted: null },
      { numMinted: 12 },
      "junk",
    ])
    expect([...m.entries()]).toEqual([["OEV2-WDMG-WINN-S2", 640], ["OEV2-WDMG-OWL-S2", 603]])
  })
  it("raises a trailing count, fills a NULL one, and never lowers or touches an unknown render", () => {
    const live = new Map([["A", 640], ["B", 500], ["C", 10], ["D", 7]])
    const raises = mintedCountRaises(live, [
      { render_id: "A", total_minted: 606 },
      { render_id: "B", total_minted: 500 },
      { render_id: "C", total_minted: 12 },
      { render_id: "D", total_minted: null },
      { render_id: "E", total_minted: 3 },
    ])
    expect(raises).toEqual([{ render_id: "A", total_minted: 640 }, { render_id: "D", total_minted: 7 }])
  })
})
