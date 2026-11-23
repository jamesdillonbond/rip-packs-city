import { describe, it, expect, beforeEach } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import {
  fetchPaperListings,
  listingsEnabled,
  titleMentions,
  _resetTokenCache,
} from "@/lib/physical/ebay-listings-server"
import { PaperCardListingsView } from "@/components/physical/PaperCardListings"

// Unmounted prototype. Locks: OFF without every env var; silent on failure;
// stray titles dropped; asks labelled as asks; affiliate links disclosed and
// marked rel="sponsored".

const ON = { PHYSICAL_EBAY_LISTINGS: "1", EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "secret", EBAY_EPN_CAMPAIGN_ID: "555" }

function fakeFetch(search: unknown, opts: { tokenOk?: boolean; searchOk?: boolean } = {}) {
  const calls: string[] = []
  const impl = (async (url: string | URL) => {
    const u = String(url)
    calls.push(u)
    if (u.includes("/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), { status: opts.tokenOk === false ? 401 : 200 })
    }
    return new Response(JSON.stringify(search), { status: opts.searchOk === false ? 500 : 200 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const SEARCH = {
  itemSummaries: [
    { itemId: "1", title: "2025-26 Topps Chrome Cooper Flagg RC PSA 10", price: { value: "450.00", currency: "USD" }, itemWebUrl: "u1", itemAffiliateWebUrl: "a1", buyingOptions: ["FIXED_PRICE"] },
    { itemId: "2", title: "Mystery lot of 50 basketball cards", price: { value: "20", currency: "USD" }, itemWebUrl: "u2" },
  ],
}

describe("paper-card listings loader", () => {
  beforeEach(() => _resetTokenCache())

  it("is off unless every switch is set", async () => {
    expect(listingsEnabled({})).toBe(false)
    expect(listingsEnabled({ PHYSICAL_EBAY_LISTINGS: "1", EBAY_CLIENT_ID: "x" })).toBe(false)
    const { impl, calls } = fakeFetch(SEARCH)
    expect(await fetchPaperListings("Cooper Flagg", { env: {}, fetchImpl: impl })).toEqual({ status: "off" })
    expect(calls).toHaveLength(0)
  })

  it("returns only listings whose title names the player", async () => {
    const { impl } = fakeFetch(SEARCH)
    const r = await fetchPaperListings("Cooper Flagg", { env: ON, fetchImpl: impl, slug: "cooper-flagg" })
    expect(r.status).toBe("ok")
    if (r.status === "ok") {
      expect(r.listings.map((l) => l.itemId)).toEqual(["1"])
      expect(r.affiliate).toBe(true)
    }
  })

  it("fails silently", async () => {
    expect((await fetchPaperListings("Cooper Flagg", { env: ON, fetchImpl: fakeFetch(SEARCH, { tokenOk: false }).impl })).status).toBe("error")
    _resetTokenCache()
    expect((await fetchPaperListings("Cooper Flagg", { env: ON, fetchImpl: fakeFetch(SEARCH, { searchOk: false }).impl })).status).toBe("error")
  })

  it("matches surnames across accents and suffixes", () => {
    expect(titleMentions("2018 Prizm Luka Doncic RC", "Luka Dončić")).toBe(true)
    expect(titleMentions("Jaren Jackson rookie", "Jaren Jackson Jr.")).toBe(true)
    expect(titleMentions("Random lot", "Jaren Jackson Jr.")).toBe(false)
  })
})

describe("PaperCardListingsView", () => {
  it("renders nothing when off, failed or empty", () => {
    expect(renderToStaticMarkup(<PaperCardListingsView name="X" result={{ status: "off" }} />)).toBe("")
    expect(renderToStaticMarkup(<PaperCardListingsView name="X" result={{ status: "error" }} />)).toBe("")
    expect(renderToStaticMarkup(<PaperCardListingsView name="X" result={{ status: "ok", listings: [], affiliate: false }} />)).toBe("")
  })

  it("labels asks and discloses affiliate links", () => {
    const html = renderToStaticMarkup(
      <PaperCardListingsView
        name="Cooper Flagg"
        result={{
          status: "ok",
          affiliate: true,
          listings: [{ itemId: "1", title: "Flagg RC", priceUsd: 450, imageUrl: null, href: "a1", isAffiliate: true, buyingOptions: ["FIXED_PRICE"], endsAt: null, condition: null }],
        }}
      />,
    )
    expect(html).toContain("Asking $450")
    expect(html).toContain("not RPC values")
    expect(html).toContain("may earn a commission")
    expect(html).toContain('rel="sponsored noopener noreferrer"')
  })
})

describe("paper-card listings budget", () => {
  beforeEach(() => _resetTokenCache())

  it("makes no eBay call when the daily cap refuses", async () => {
    const { impl, calls } = fakeFetch(SEARCH)
    const r = await fetchPaperListings("Cooper Flagg", { env: ON, fetchImpl: impl, allowCall: async () => false })
    expect(r.status).toBe("error")
    expect(calls).toHaveLength(0)
  })

  it("bounds the cap at eBay's default limit", async () => {
    const { browseDailyCap } = await import("@/lib/physical/ebay-listings-server")
    expect(browseDailyCap({})).toBe(4000)
    expect(browseDailyCap({ EBAY_BROWSE_DAILY_CAP: "9000" })).toBe(4000)
    expect(browseDailyCap({ EBAY_BROWSE_DAILY_CAP: "1500" })).toBe(1500)
  })
})
