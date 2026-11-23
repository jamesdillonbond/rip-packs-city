// @vitest-environment jsdom
// /insights/pinnacle-market (2026-11-23): The RPC Index for Disney Pinnacle (copied from the All Day test, 10-28), its own page (one collection, one URL —
// docs/reference/architecture-notes.md). Pinned: the page reads Disney Pinnacle's rows server-side and renders the client
// ON Disney Pinnacle; a failed read is a degraded board with no freshness stamp; the layout's canonical, OG and Twitter
// image are Disney Pinnacle's own; the OG card reads and names the collection it was asked for, and an unknown
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
    return Promise.resolve({ ok: true, json: async () => ({ rows: [{ d: "2026-10-01", tier: "LIMITED", median_px: 0.3, volume_usd: 5 }, { d: "2026-10-01", tier: "ALL", median_px: 0.2, volume_usd: 90 }] }) })
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

import PinnacleMarketPage from "@/app/insights/pinnacle-market/page"
import { metadata } from "@/app/insights/pinnacle-market/layout"
import { GET as ogPinnacleGET } from "@/app/api/og/insights/pinnacle-market/route"

beforeEach(() => {
  read.calls = []
  read.result = { rows: [], loadError: null }
  og.urls = []
  og.el = null
})

describe("/insights/pinnacle-market — server page + layout", () => {
  it("reads Disney Pinnacle's rows and renders the client on Disney Pinnacle", async () => {
    read.result = { rows: [{ d: "2026-10-01", tier: "LIMITED", sales: 9, volume_usd: 3, median_px: 0.3, avg_px: 0.3, max_px: 1 }], loadError: null }
    const el = (await PinnacleMarketPage()) as ReactElement<{ collection: string; initialFetchedAt: string | null }>
    expect(read.calls).toEqual(["disney-pinnacle"])
    expect(el.props.collection).toBe("disney-pinnacle")
    expect(el.props.initialFetchedAt).not.toBeNull()
  })

  it("a failed read is degraded with no freshness stamp", async () => {
    read.result = { rows: [], loadError: "boom" }
    const el = (await PinnacleMarketPage()) as ReactElement<{ initialFetchedAt: string | null; loadError: string | null }>
    expect(el.props.initialFetchedAt).toBeNull()
    expect(el.props.loadError).toBe("boom")
  })

  it("canonical, OG and Twitter images are Disney Pinnacle's own", () => {
    expect(String(metadata.alternates?.canonical)).toMatch(/\/insights\/pinnacle-market$/)
    const ogImages = JSON.stringify(metadata.openGraph?.images)
    expect(ogImages).toContain("/api/og/insights/pinnacle-market")
    expect(JSON.stringify(metadata.twitter)).toContain("/api/og/insights/pinnacle-market")
    expect(String(metadata.title)).toContain("Disney Pinnacle")
  })
})

describe("OG card /api/og/insights/pinnacle-market", () => {
  const html = () => renderToStaticMarkup(og.el as ReactElement)

  it("reads Disney Pinnacle's leg and names Disney Pinnacle", async () => {
    await ogPinnacleGET({ url: "https://t/api/og/insights/pinnacle-market" } as any)
    expect(og.urls).toHaveLength(1)
    expect(og.urls[0]).toContain("collection=disney-pinnacle")
    expect(html()).toContain("Disney Pinnacle")
    expect(html()).toContain("rippackscity.com/insights/pinnacle-market")
    expect(html()).toContain("LIMITED")
    expect(html()).not.toContain("FANDOM")
  })
})
