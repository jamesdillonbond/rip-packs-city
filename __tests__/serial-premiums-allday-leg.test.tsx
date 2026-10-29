// @vitest-environment jsdom
// NFL All Day Serial Premiums (2026-10-28) — /insights/allday-serial-premiums. Pinned:
//   - the lib reads All Day's own views for each mode (the one place a collection picks a table);
//   - the API: ?collection=nfl-all-day passes through, an unknown collection is a 400 with no fetch, and the tier
//     whitelist is the collection's own (UNCOMMON on All Day, FANDOM on Top Shot);
//   - the client on All Day: All Day tiers, edition-thumbnail images (Top Shot's CDN does not serve All Day),
//     /nfl-all-day drill-down links, refetches carry ?collection=nfl-all-day, shares its own page;
//   - the server page reads All Day and renders the client on All Day; the layout is All Day's own;
//   - the OG card reads and names the collection it was asked for; an unknown collection reads nothing.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ReactElement } from "react"

const lib = vi.hoisted(() => ({ calls: [] as any[], rows: [] as any[], err: null as unknown }))
vi.mock("@/lib/serial-premiums-board", async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    fetchSerialPremiums: async (_db: unknown, opts: any) => {
      lib.calls.push(opts)
      if (lib.err) throw lib.err
      return lib.rows
    },
  }
})
const og = vi.hoisted(() => ({ urls: [] as string[], el: null as unknown }))
vi.mock("@/lib/og/og-fetch", () => ({
  ogFetch: (url: string) => {
    og.urls.push(url)
    return Promise.resolve({ ok: true, json: async () => ({ rows: [{ player_name: "Richard Sherman", set_name: "Base", tier: "COMMON", edition_median_usd: 0.28, headline_last_sale_usd: 550, premium_multiple: 1964.3 }] }) })
  },
}))
vi.mock("@/lib/og/board-count", () => ({
  fetchBoardCount: (_o: string, path: string) => {
    og.urls.push(path)
    return Promise.resolve(null)
  },
  boardCountLabel: () => "",
}))
vi.mock("@/lib/og/brand-fonts", () => ({ brandFonts: async () => null, brandFamilies: () => ({ display: "x", mono: "y" }), ogCacheHeaders: () => ({}) }))
vi.mock("next/og", () => ({ ImageResponse: class { constructor(el: unknown) { og.el = el } } }))
vi.mock("@/lib/insights/board-page-fetch", async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    fetchBoardForPage: async (_label: string, fallback: unknown, fn: (db: unknown) => Promise<unknown>) => {
      try {
        return { data: await fn({}), fetchedAt: "2026-10-28T20:00:00Z", ok: true }
      } catch {
        return { data: fallback, fetchedAt: null, ok: false }
      }
    },
  }
})

import { boardTable } from "@/lib/serial-premiums-board"
import { GET } from "@/app/api/public/insights/serial-premiums/route"
import SerialPremiumsBoardClient from "@/app/insights/serial-premiums/SerialPremiumsBoardClient"
import AllDaySerialPremiumsPage from "@/app/insights/allday-serial-premiums/page"
import { metadata } from "@/app/insights/allday-serial-premiums/layout"
import { GET as ogGET } from "@/app/api/og/insights/serial-premiums/route"
import { GET as ogAllDayGET } from "@/app/api/og/insights/allday-serial-premiums/route"

const req = (url: string) => ({ url, nextUrl: new URL(url) }) as any
const BASE = "https://t/api/public/insights/serial-premiums"

const adRow = {
  edition_id: "e-ad", external_id: "4582", player_name: "Richard Sherman", set_name: "Base", tier: "UNCOMMON",
  circulation_count: 10000, thumbnail_url: "https://media.nflallday.com/x.jpg", moment_id: "564428", nft_id: "564428",
  edition_median_usd: 0.28, premium_multiple: 1964.3, edition_sales_180d: 40, is_conflated: false,
  headline_serial: 1, headline_last_sale_usd: 550, headline_sold_at: "2026-08-10T15:21:43Z",
}

beforeEach(() => {
  lib.calls = []
  lib.rows = []
  lib.err = null
  og.urls = []
  og.el = null
  window.history.replaceState({}, "", "/insights/allday-serial-premiums")
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("lib — the table per collection", () => {
  it("All Day reads its own two views; Top Shot (and absent) its originals", () => {
    expect(boardTable("no1", "nfl-all-day")).toBe("allday_serial_premiums_board")
    expect(boardTable("perfect", "nfl-all-day")).toBe("allday_perfect_mint_premiums_board")
    expect(boardTable("no1")).toBe("topshot_serial_premiums_board")
    expect(boardTable("perfect", "nba-top-shot")).toBe("topshot_perfect_mint_premiums_board")
  })
})

describe("API — ?collection", () => {
  it("nfl-all-day passes through and reports All Day's source", async () => {
    lib.rows = [adRow]
    const body = await (await GET(req(`${BASE}?collection=nfl-all-day&headline=perfect`))).json()
    expect(lib.calls[0]).toMatchObject({ collection: "nfl-all-day", mode: "perfect" })
    expect(body.meta.source).toBe("allday_perfect_mint_premiums_board")
    expect(body.meta.collection).toBe("nfl-all-day")
  })
  it("an unknown collection is a 400 with no fetch — never Top Shot's premiums", async () => {
    lib.rows = [adRow]
    const res = await GET(req(`${BASE}?collection=laliga-golazos`))
    expect(res.status).toBe(400)
    expect(lib.calls).toEqual([])
    expect((await res.json()).rows).toBeUndefined()
  })
  it("the tier whitelist is the collection's own", async () => {
    expect((await GET(req(`${BASE}?collection=nfl-all-day&tier=UNCOMMON`))).status).toBe(200)
    expect((await GET(req(`${BASE}?collection=nfl-all-day&tier=FANDOM`))).status).toBe(400)
    expect((await GET(req(`${BASE}?tier=UNCOMMON`))).status).toBe(400)
    expect((await GET(req(`${BASE}?tier=FANDOM`))).status).toBe(200)
  })
})

describe("client on NFL All Day", () => {
  function stubFetch() {
    const fn = vi.fn((url: string) =>
      Promise.resolve({ ok: true, json: async () => (String(url).includes("/api/public/insights/serial-premiums") ? { rows: [adRow], meta: { fetched_at: "x", total_rows: 1, elapsed_ms: 1 } } : {}) }),
    )
    vi.stubGlobal("fetch", fn)
    return fn
  }

  it("shows All Day's tiers, thumbnails and /nfl-all-day links, and shares its own page", () => {
    stubFetch()
    const { container, getByText } = render(<SerialPremiumsBoardClient initialRows={[adRow]} initialFetchedAt="2026-10-28T20:00:00Z" collection="nfl-all-day" />)
    const tiers = [...container.querySelectorAll('[aria-label="Tier"] button')].map((b) => b.textContent)
    expect(tiers).toContain("Uncommon")
    expect(tiers).not.toContain("Fandom")
    const imgs = [...container.querySelectorAll("img")].map((i) => i.getAttribute("src"))
    expect(imgs.every((s) => s === adRow.thumbnail_url)).toBe(true)
    expect(imgs.some((s) => (s ?? "").includes("nbatopshot"))).toBe(false)
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "")
    expect(hrefs).toContain("/nfl-all-day/moment/564428")
    expect(hrefs.some((h) => h.startsWith("/moment/"))).toBe(false)
    expect(getByText("Serial Premiums · NFL All Day")).toBeTruthy()
    expect(decodeURIComponent(container.querySelector(".rpc-sp-share-btn")?.getAttribute("href") ?? "")).toContain("/insights/allday-serial-premiums")
    expect(container.querySelector('[data-testid="sp-other-board"]')?.getAttribute("href")).toBe("/insights/serial-premiums")
  })

  it("a refetch carries ?collection=nfl-all-day", async () => {
    const fn = stubFetch()
    const { getByText } = render(<SerialPremiumsBoardClient initialRows={[adRow]} initialFetchedAt="2026-10-28T20:00:00Z" collection="nfl-all-day" />)
    fireEvent.click(getByText("Perfect Mint"))
    await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]).includes("/api/public/insights/serial-premiums"))).toBe(true))
    const url = String(fn.mock.calls.find((c) => String(c[0]).includes("/api/public/insights/serial-premiums"))![0])
    expect(url).toContain("collection=nfl-all-day")
    expect(url).toContain("headline=perfect")
  })

  it("Top Shot (the default) keeps its CDN image, /moment link, Fandom tier and no collection param", async () => {
    const fn = stubFetch()
    const ts = { ...adRow, tier: "FANDOM", external_id: "141:2" }
    const { container, getByText } = render(<SerialPremiumsBoardClient initialRows={[ts]} initialFetchedAt="2026-10-28T20:00:00Z" />)
    expect([...container.querySelectorAll("img")].some((i) => (i.getAttribute("src") ?? "").includes("assets.nbatopshot.com"))).toBe(true)
    expect([...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toContain("/moment/564428")
    fireEvent.click(getByText("Perfect Mint"))
    await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]).includes("/api/public/insights/serial-premiums"))).toBe(true))
    expect(String(fn.mock.calls.find((c) => String(c[0]).includes("/api/public/insights/serial-premiums"))![0])).not.toContain("collection=")
  })
})

describe("server page + layout", () => {
  it("reads All Day and renders the client on All Day; a failed read has no stamp", async () => {
    lib.rows = [adRow]
    const el = (await AllDaySerialPremiumsPage()) as ReactElement<{ children: ReactElement<{ collection: string; initialFetchedAt: string | null; initialFailed: boolean }>[] }>
    const client = (el.props.children as any[])[1]
    expect(lib.calls[0]).toMatchObject({ collection: "nfl-all-day", mode: "no1" })
    expect(client.props.collection).toBe("nfl-all-day")
    expect(client.props.initialFetchedAt).not.toBeNull()
    lib.err = new Error("boom")
    const failed = (await AllDaySerialPremiumsPage()) as any
    expect(failed.props.children[1].props.initialFetchedAt).toBeNull()
    expect(failed.props.children[1].props.initialFailed).toBe(true)
  })
  it("canonical and OG image are All Day's own", () => {
    expect(String(metadata.alternates?.canonical)).toMatch(/\/insights\/allday-serial-premiums$/)
    expect(JSON.stringify(metadata.openGraph?.images)).toContain("/api/og/insights/allday-serial-premiums")
    expect(JSON.stringify(metadata.twitter)).toContain("/api/og/insights/allday-serial-premiums")
  })
})

describe("OG card", () => {
  const html = () => renderToStaticMarkup(og.el as ReactElement)
  it("the All Day path reads All Day's leg and names All Day", async () => {
    await ogAllDayGET({ url: "https://t/api/og/insights/allday-serial-premiums" } as any)
    expect(og.urls.length).toBe(2)
    expect(og.urls.every((u) => u.includes("collection=nfl-all-day"))).toBe(true)
    expect(html()).toContain("NFL All Day")
    expect(html()).toContain("rippackscity.com/insights/allday-serial-premiums")
  })
  it("no collection is Top Shot's card", async () => {
    await ogGET({ url: "https://t/api/og/insights/serial-premiums" } as any)
    expect(og.urls.some((u) => u.includes("collection="))).toBe(false)
    expect(html()).toContain("NBA Top Shot")
  })
  it("an unknown collection reads nothing", async () => {
    await ogGET({ url: "https://t/api/og/insights/serial-premiums?collection=laliga-golazos" } as any)
    expect(og.urls).toEqual([])
    expect(html()).not.toContain("Richard Sherman")
  })
})
