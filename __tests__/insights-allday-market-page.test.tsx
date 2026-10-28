// @vitest-environment jsdom
// /insights/allday-market (2026-10-28): The RPC Index for NFL All Day, its own page (one collection, one URL —
// docs/reference/architecture-notes.md). Pinned: the page reads All Day's rows server-side and renders the client
// ON All Day; a failed read is a degraded board with no freshness stamp; the layout's canonical, OG and Twitter
// image are All Day's own; the OG card reads and names the collection it was asked for, and an unknown
// ?collection= reads nothing.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { ReactElement } from "react"

const read = vi.hoisted(() => ({ calls: [] as string[], result: { rows: [] as unknown[], loadError: null as string | null } }))
vi.mock("@/lib/insights/market-index-board", () => ({
  fetchMarketIndexPageRows: (collection: string) => {
    read.calls.push(collection)
    return Promise.resolve(read.result)
  },
}))
const og = vi.hoisted(() => ({ urls: [] as string[], el: null as unknown }))
vi.mock("@/lib/og/og-fetch", () => ({
  ogFetch: (url: string) => {
    og.urls.push(url)
    return Promise.resolve({ ok: true, json: async () => ({ rows: [{ d: "2026-10-01", tier: "UNCOMMON", median_px: 0.3, volume_usd: 5 }, { d: "2026-10-01", tier: "ALL", median_px: 0.2, volume_usd: 90 }] }) })
  },
}))
vi.mock("@/lib/og/brand-fonts", () => ({
  brandFonts: async () => null,
  brandFamilies: () => ({ display: "x", mono: "y" }),
  ogCacheHeaders: () => ({}),
}))
vi.mock("next/og", () => ({
  ImageResponse: class {
    constructor(el: unknown) {
      og.el = el
    }
  },
}))

import AllDayMarketPage from "@/app/insights/allday-market/page"
import { metadata } from "@/app/insights/allday-market/layout"
import { GET as ogGET } from "@/app/api/og/insights/market/route"
import { GET as ogAllDayGET } from "@/app/api/og/insights/allday-market/route"

beforeEach(() => {
  read.calls = []
  read.result = { rows: [], loadError: null }
  og.urls = []
  og.el = null
})

describe("/insights/allday-market — server page + layout", () => {
  it("reads NFL All Day's rows and renders the client on All Day", async () => {
    read.result = { rows: [{ d: "2026-10-01", tier: "UNCOMMON", sales: 9, volume_usd: 3, median_px: 0.3, avg_px: 0.3, max_px: 1 }], loadError: null }
    const el = (await AllDayMarketPage()) as ReactElement<{ collection: string; initialFetchedAt: string | null }>
    expect(read.calls).toEqual(["nfl-all-day"])
    expect(el.props.collection).toBe("nfl-all-day")
    expect(el.props.initialFetchedAt).not.toBeNull()
  })

  it("a failed read is degraded with no freshness stamp", async () => {
    read.result = { rows: [], loadError: "boom" }
    const el = (await AllDayMarketPage()) as ReactElement<{ initialFetchedAt: string | null; loadError: string | null }>
    expect(el.props.initialFetchedAt).toBeNull()
    expect(el.props.loadError).toBe("boom")
  })

  it("canonical, OG and Twitter images are All Day's own", () => {
    expect(String(metadata.alternates?.canonical)).toMatch(/\/insights\/allday-market$/)
    const ogImages = JSON.stringify(metadata.openGraph?.images)
    expect(ogImages).toContain("/api/og/insights/allday-market")
    expect(JSON.stringify(metadata.twitter)).toContain("/api/og/insights/allday-market")
    expect(String(metadata.title)).toContain("NFL All Day")
  })
})

describe("OG card /api/og/insights/market", () => {
  const html = () => renderToStaticMarkup(og.el as ReactElement)

  it("the All Day path reads All Day's leg and names All Day", async () => {
    await ogAllDayGET({ url: "https://t/api/og/insights/allday-market" } as any)
    expect(og.urls).toHaveLength(1)
    expect(og.urls[0]).toContain("collection=nfl-all-day")
    expect(html()).toContain("NFL All Day")
    expect(html()).toContain("rippackscity.com/insights/allday-market")
    expect(html()).toContain("UNCOMMON")
    expect(html()).not.toContain("FANDOM")
  })

  it("no collection is Top Shot's card", async () => {
    await ogGET({ url: "https://t/api/og/insights/market" } as any)
    expect(og.urls[0]).not.toContain("collection=")
    expect(html()).toContain("Top Shot")
    expect(html()).toContain("rippackscity.com/insights/market<")
  })

  it("an unknown collection reads nothing — never Top Shot's numbers under another name", async () => {
    await ogGET({ url: "https://t/api/og/insights/market?collection=laliga-golazos" } as any)
    expect(og.urls).toEqual([])
    expect(html()).not.toContain("UNCOMMON")
  })
})
