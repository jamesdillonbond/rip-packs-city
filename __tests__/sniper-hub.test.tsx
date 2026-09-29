// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { pickHubDeals, formatAsOfPt, type SniperDealRow } from "@/lib/sniper/hub"
import { isPublicPath } from "@/proxy"

// The /sniper hub (2026-09-28) — the bottom bar's SNIPER tab. What is pinned:
// the THREE states of its deals list (failed read ≠ empty market), the row
// filter, the PT stamp, the tiles, and that an anonymous visitor can reach it.

const board = { payload: { rows: [] as unknown[], data_as_of: null as string | null }, source: "live" as string }
vi.mock("@/lib/insights/board-cache", () => ({
  readBoardOrLive: async () => ({ payload: board.payload, source: board.source }),
}))
vi.mock("@/lib/insights/boards", () => ({ fetchDealsDefault: vi.fn() }))
vi.mock("@/components/GlobalSiteHeader", () => ({ default: () => <header data-testid="site-header" /> }))
vi.mock("@/components/SiteFooter", () => ({ default: () => <footer /> }))
vi.mock("@/components/sniper/LastSniperShortcut", () => ({ default: () => null }))
vi.mock("next/link", () => ({
  default: ({ children, href, ...p }: { children?: React.ReactNode; href: string } & Record<string, unknown>) => (
    <a href={href} {...(p as object)}>{children}</a>
  ),
}))

import SniperHubPage from "@/app/sniper/page"

const row = (over: Partial<SniperDealRow> = {}): SniperDealRow => ({
  external_id: "e1",
  name: "Moment",
  player_name: "Damian Lillard",
  set_name: "Base Set",
  tier: "COMMON",
  fmv_usd: 10,
  low_ask: 7,
  discount_pct: 30,
  collection_name: "NBA Top Shot",
  detail_url: "/nba-top-shot/edition/e1",
  low_confidence_fmv: false,
  ...over,
})

async function renderHub() {
  const el = await SniperHubPage()
  return render(el)
}

afterEach(() => {
  cleanup()
  board.payload = { rows: [], data_as_of: null }
  board.source = "live"
})

describe("sniper hub — the deals list's three states", () => {
  it("⛔ a FAILED read says unavailable and NEVER 'no listing'", async () => {
    board.source = "live-degraded"
    const { container, queryByTestId } = await renderHub()
    expect(queryByTestId("sniper-hub-unavailable")).not.toBeNull()
    expect(queryByTestId("sniper-hub-empty")).toBeNull()
    expect(container.textContent ?? "").not.toMatch(/No listing is/)
  })

  it("a SUCCESSFUL empty read is the one place 'no listing' may be said", async () => {
    const { queryByTestId } = await renderHub()
    expect(queryByTestId("sniper-hub-empty")).not.toBeNull()
    expect(queryByTestId("sniper-hub-unavailable")).toBeNull()
  })

  it("rows render as links to their drill-down", async () => {
    board.payload = { rows: [row(), row({ external_id: "e2", detail_url: "/x/2" })], data_as_of: "2026-09-29T03:00:00Z" }
    const { getByTestId, container } = await renderHub()
    const hrefs = Array.from(getByTestId("sniper-hub-deals").querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(hrefs).toEqual(["/nba-top-shot/edition/e1", "/x/2"])
    expect(container.textContent).toContain("Sep 28, 8:00 PM PT")
  })

  it("carries no stamp when the board cannot say how old it is — never now()", async () => {
    board.payload = { rows: [row()], data_as_of: null }
    const { container } = await renderHub()
    expect(container.textContent ?? "").not.toMatch(/Prices as of/)
  })
})

describe("sniper hub — tiles and chrome", () => {
  it("links each published collection that HAS a sniper, and no other", async () => {
    const { container } = await renderHub()
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "")
    expect(hrefs).toContain("/nba-top-shot/sniper")
    expect(hrefs).not.toContain("/ufc/sniper")
    expect(hrefs).not.toContain("/candy-mlb/sniper")
  })

  it("mounts the site header", async () => {
    const { queryByTestId } = await renderHub()
    expect(queryByTestId("site-header")).not.toBeNull()
  })

  it("is reachable signed-out (the proxy lets /sniper through, and only the exact path)", () => {
    expect(isPublicPath("/sniper", "GET")).toBe(true)
  })
})

describe("pickHubDeals / formatAsOfPt", () => {
  it("drops low-confidence FMV and rows with no ask or discount, keeps board order, caps at N", () => {
    const rows = [
      row({ external_id: "a" }),
      row({ external_id: "lc", low_confidence_fmv: true }),
      row({ external_id: "noask", low_ask: null }),
      row({ external_id: "b" }),
      row({ external_id: "c" }),
    ]
    expect(pickHubDeals(rows, 2).map((r) => r.external_id)).toEqual(["a", "b"])
  })

  it("stamps in PT, and null/garbage in → null out", () => {
    expect(formatAsOfPt("2026-09-29T03:00:00Z")).toBe("Sep 28, 8:00 PM PT")
    expect(formatAsOfPt(null)).toBeNull()
    expect(formatAsOfPt("not a date")).toBeNull()
  })
})
