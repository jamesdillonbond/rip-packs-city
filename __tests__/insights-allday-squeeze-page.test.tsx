// @vitest-environment jsdom
// /insights/allday-squeeze (2026-10-27): NFL All Day's squeeze board gets its own page. Before it, All Day's leg
// lived only behind /insights/squeeze?collection=nfl-all-day, whose metadata and OG card are Top Shot's — an All
// Day share previewed Top Shot's title and top three (10-27 review), and no crawler saw an All Day row.
// Pinned here: the page reads All Day server-side and seeds the client ON All Day (no Top Shot seed, no refetch);
// a dedicated page ignores ?collection= and its toggle navigates to the other board's page; every share link is
// the collection's own page; the OG card reads and names the collection it was asked for.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ReactElement } from "react"

const board = vi.hoisted(() => ({ calls: [] as any[], result: { data: [] as unknown[] | null, error: null as null | { message: string } } }))
vi.mock("@/lib/insights/squeeze-board", () => ({
  fetchSqueezeBoard: (opts: unknown) => {
    board.calls.push(opts)
    return Promise.resolve({ ...board.result, playerResolved: null })
  },
}))

const og = vi.hoisted(() => ({ urls: [] as string[], el: null as unknown }))
const setBoard = vi.hoisted(() => ({ calls: [] as any[], result: { data: [] as unknown[] | null, error: null as null | { message: string } } }))
vi.mock("@/lib/insights/set-squeeze-board", () => ({
  fetchSetSqueezeBoard: (opts: unknown) => {
    setBoard.calls.push(opts)
    return Promise.resolve(setBoard.result)
  },
}))

vi.mock("@/lib/og/og-fetch", () => ({
  ogFetch: (url: string) => {
    og.urls.push(url)
    return Promise.resolve({ ok: true, json: async () => ({ rows: [{ player_name: "Travis Kelce", set_name: "Base", tier: "UNCOMMON", circulation: 50, effectively_buyable: 2, squeeze_pct: 96 }] }) })
  },
}))
vi.mock("@/lib/og/board-count", () => ({
  fetchBoardCount: (_origin: string, path: string) => {
    og.urls.push(path)
    return Promise.resolve(null)
  },
  boardCountLabel: () => "",
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

import AllDaySqueezePage from "@/app/insights/allday-squeeze/page"
import SqueezeBoardClient from "@/app/insights/squeeze/SqueezeBoardClient"
import { GET as ogGET } from "@/app/api/og/insights/squeeze/route"
import AllDaySetSqueezePage from "@/app/insights/allday-set-squeeze/page"
import SetSqueezeBoardClient from "@/app/insights/set-squeeze/SetSqueezeBoardClient"
import { GET as ogSetGET } from "@/app/api/og/insights/set-squeeze/route"
import { GET as ogAllDayGET } from "@/app/api/og/insights/allday-squeeze/route"
import { GET as ogAllDaySetGET } from "@/app/api/og/insights/allday-set-squeeze/route"

function row(over: Record<string, unknown>) {
  return {
    edition_id: "e", external_id: "141:1", player_name: "P", set_name: "Base Set",
    tier: "COMMON", circulation: 1000, locked: 100, burned: 10, lock_pct: 10, burn_pct: 1,
    squeeze_pct: 60, effectively_buyable: 500, low_ask: 20, fmv_usd: 30, confidence: null,
    game_date: null, thumbnail_url: null, top5_share_pct: null, holders: null, ...over,
  }
}
const adRows = [row({ edition_id: "ad", external_id: "4582", player_name: "Travis Kelce", tier: "RARE", circulation: 50, squeeze_pct: 96, effectively_buyable: 2 })]
const tsSeed = [row({ edition_id: "ts", external_id: "141:2", player_name: "Victor Wembanyama", squeeze_pct: 81 })]

function stubFetch() {
  const fn = vi.fn((url: string) =>
    Promise.resolve({ ok: true, json: async () => (String(url).includes("/api/public/insights/squeeze") ? { rows: adRows, meta: { fetched_at: "x", total_rows: 1 } } : {}) }),
  )
  vi.stubGlobal("fetch", fn)
  return fn
}
const squeezeCalls = (fn: ReturnType<typeof stubFetch>) => fn.mock.calls.filter((c) => String(c[0]).includes("/api/public/insights/squeeze"))
const tweetHref = (c: HTMLElement) => [...c.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "").find((h) => h.startsWith("https://twitter.com/intent/tweet")) ?? ""

const realLocation = window.location
beforeEach(() => {
  board.calls = []; board.result = { data: [], error: null }; og.urls = []; og.el = null
  setBoard.calls = []; setBoard.result = { data: [], error: null }
  window.history.replaceState({}, "", "/insights/allday-squeeze")
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: false, media: q, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia
  }
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Object.defineProperty(window, "location", { configurable: true, value: realLocation })
})

describe("/insights/allday-squeeze — server page", () => {
  it("reads NFL All Day's board and seeds the client ON All Day", async () => {
    board.result = { data: adRows, error: null }
    const el = (await AllDaySqueezePage()) as ReactElement<any>
    expect(board.calls).toEqual([expect.objectContaining({ collection: "nfl-all-day", minSqueeze: 50 })])
    expect(el.props.initialCollection).toBe("nfl-all-day")
    expect(el.props.initialRows).toEqual(adRows)
    expect(el.props.initialFetchedAt).not.toBeNull()
    expect(el.props.initialDegraded).toBeNull()
  })

  it("a failed read is degraded with no freshness stamp — never an empty board at 'now'", async () => {
    board.result = { data: null, error: { message: "57014" } }
    const el = (await AllDaySqueezePage()) as ReactElement<any>
    expect(el.props.initialRows).toEqual([])
    expect(el.props.initialFetchedAt).toBeNull()
    expect(el.props.initialDegraded).not.toBeNull()
  })
})

describe("SqueezeBoardClient on a dedicated page (initialCollection)", () => {
  it("shows the All Day seed with no refetch, ignores ?collection=, and shares its own page", async () => {
    window.history.replaceState({}, "", "/insights/allday-squeeze?collection=nba-top-shot")
    const fn = stubFetch()
    const { container } = render(<SqueezeBoardClient initialRows={adRows as any} initialCollection="nfl-all-day" initialFetchedAt="2026-10-27T22:00:00Z" />)
    await waitFor(() => expect(container.textContent).toContain("Travis Kelce"))
    expect(squeezeCalls(fn)).toHaveLength(0)
    expect([...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toContain("/nfl-all-day/edition/4582")
    expect(decodeURIComponent(tweetHref(container))).toContain("/insights/allday-squeeze")
    expect(decodeURIComponent(tweetHref(container))).not.toContain("?collection=")
  })

  it("its Top Shot toggle navigates to /insights/squeeze rather than showing Top Shot under this URL", () => {
    const assign = vi.fn()
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { href: "http://localhost/insights/allday-squeeze", search: "", pathname: "/insights/allday-squeeze", assign },
    })
    const fn = stubFetch()
    const { getByTestId } = render(<SqueezeBoardClient initialRows={adRows as any} initialCollection="nfl-all-day" initialFetchedAt="x" />)
    fireEvent.click(getByTestId("sq-collection-nba-top-shot"))
    expect(assign).toHaveBeenCalledWith("/insights/squeeze")
    expect(squeezeCalls(fn)).toHaveLength(0)
  })

  it("on /insights/squeeze the toggle still switches in place, and All Day's share link is its own page", async () => {
    window.history.replaceState({}, "", "/insights/squeeze")
    stubFetch()
    const { getByTestId, container } = render(<SqueezeBoardClient initialRows={tsSeed as any} initialFetchedAt="x" />)
    expect(decodeURIComponent(tweetHref(container))).toMatch(/\/insights\/squeeze$/)
    fireEvent.click(getByTestId("sq-collection-nfl-all-day"))
    await waitFor(() => expect(container.textContent).toContain("Travis Kelce"))
    expect(decodeURIComponent(tweetHref(container))).toContain("/insights/allday-squeeze")
  })
})

describe("OG card /api/og/insights/squeeze", () => {
  const html = () => renderToStaticMarkup(og.el as ReactElement)

  it("?collection=nfl-all-day reads All Day's leg and names All Day", async () => {
    await ogGET({ url: "https://t/api/og/insights/squeeze?collection=nfl-all-day" } as any)
    expect(og.urls.length).toBeGreaterThanOrEqual(2)
    expect(og.urls.every((u) => u.includes("collection=nfl-all-day"))).toBe(true)
    expect(html()).toContain("NFL All Day displays circulation")
    expect(html()).toContain("rippackscity.com/insights/allday-squeeze")
    expect(html()).not.toContain("Top Shot displays circulation")
  })

  it("no (or an unknown) collection is Top Shot's card, labelled Top Shot", async () => {
    for (const q of ["", "?collection=candy_mlb"]) {
      og.urls = []
      await ogGET({ url: `https://t/api/og/insights/squeeze${q}` } as any)
      expect(og.urls.some((u) => u.includes("collection="))).toBe(false)
      expect(html()).toContain("Top Shot displays circulation")
    }
  })
})

const setRow = (o: Record<string, unknown>) => ({
  set_id: "s", set_name: "Base Set", series: 9, set_tier: "COMMON", editions_covered: 10, avg_squeeze_pct: 70,
  median_squeeze_pct: 70, max_squeeze_pct: 90, min_squeeze_pct: 50, total_circ: 1000, total_locked: 600, total_burned: 100,
  total_buyable: 300, avg_fmv_usd: 5, fmv_covered_editions: 10, ...o,
})
const adSets = [setRow({ set_id: "ad", set_name: "NFL Draft" })]

describe("/insights/allday-set-squeeze", () => {
  it("the page reads All Day's set board and seeds the client ON All Day; a failed read is degraded with no stamp", async () => {
    setBoard.result = { data: adSets, error: null }
    let el = (await AllDaySetSqueezePage()) as ReactElement<any>
    expect(setBoard.calls).toEqual([expect.objectContaining({ collection: "nfl-all-day" })])
    expect(el.props.initialCollection).toBe("nfl-all-day")
    expect(el.props.initialRows).toEqual(adSets)
    setBoard.result = { data: null, error: { message: "57014" } }
    el = (await AllDaySetSqueezePage()) as ReactElement<any>
    expect(el.props.initialFetchedAt).toBeNull()
    expect(el.props.initialDegraded).not.toBeNull()
  })

  it("the client shows the All Day seed with no refetch, ignores ?collection=, shares its own page, and its Top Shot toggle navigates", async () => {
    window.history.replaceState({}, "", "/insights/allday-set-squeeze?collection=nba-top-shot")
    const fn = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ rows: [], meta: {} }) }))
    vi.stubGlobal("fetch", fn)
    const { container, getByTestId } = render(<SetSqueezeBoardClient initialRows={adSets as any} initialCollection="nfl-all-day" initialFetchedAt="x" />)
    await waitFor(() => expect(container.textContent).toContain("NFL Draft"))
    expect(fn.mock.calls.filter((c: any[]) => String(c[0]).includes("/api/public/insights/set-squeeze"))).toHaveLength(0)
    expect(decodeURIComponent(tweetHref(container))).toContain("/insights/allday-set-squeeze")
    const assign = vi.fn()
    Object.defineProperty(window, "location", { configurable: true, value: { href: "http://localhost/insights/allday-set-squeeze", search: "", assign } })
    fireEvent.click(getByTestId("ss-collection-nba-top-shot"))
    expect(assign).toHaveBeenCalledWith("/insights/set-squeeze")
  })

  it("the OG card reads and names All Day for ?collection=nfl-all-day, Top Shot otherwise", async () => {
    await ogSetGET({ url: "https://t/api/og/insights/set-squeeze?collection=nfl-all-day" } as any)
    expect(og.urls.every((u) => u.includes("collection=nfl-all-day"))).toBe(true)
    expect(renderToStaticMarkup(og.el as ReactElement)).toContain("NFL All Day sets ranked")
    expect(renderToStaticMarkup(og.el as ReactElement)).toContain("rippackscity.com/insights/allday-set-squeeze")
    og.urls = []
    await ogSetGET({ url: "https://t/api/og/insights/set-squeeze" } as any)
    expect(og.urls.some((u) => u.includes("collection="))).toBe(false)
    expect(renderToStaticMarkup(og.el as ReactElement)).toContain("Top Shot sets ranked")
  })
})

describe("the boards' own OG paths render the All Day card", () => {
  it("/api/og/insights/allday-squeeze and /allday-set-squeeze read and name NFL All Day", async () => {
    await ogAllDayGET(new (await import("next/server")).NextRequest("https://t/api/og/insights/allday-squeeze"))
    expect(og.urls.every((u) => u.includes("collection=nfl-all-day"))).toBe(true)
    expect(renderToStaticMarkup(og.el as ReactElement)).toContain("NFL All Day displays circulation")
    og.urls = []
    await ogAllDaySetGET(new (await import("next/server")).NextRequest("https://t/api/og/insights/allday-set-squeeze"))
    expect(og.urls.length).toBeGreaterThan(0)
    expect(og.urls.every((u) => u.includes("collection=nfl-all-day"))).toBe(true)
    expect(renderToStaticMarkup(og.el as ReactElement)).toContain("NFL All Day sets ranked")
  })
})
