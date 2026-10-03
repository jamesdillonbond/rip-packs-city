// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import MarketCapBoardClient from "@/app/insights/market-cap/MarketCapBoardClient"
import type { MarketCapBoard, MarketCapRow } from "@/lib/insights/market-cap-board"

afterEach(cleanup)

const row = (over: Partial<MarketCapRow>): MarketCapRow => ({
  collection_slug: "nba_top_shot", group_key: "nba_top_shot", group_label: "nba_top_shot",
  set_name: null, tier: null, series_num: null, series_name: null, edition_external_id: null,
  editions: 10, editions_supply_known: 10, editions_priced: 10,
  minted: 1000, burned: 200, issuer_held: 100, collector_held: 700,
  mcap_usd: 51_757_657.83, mcap_high_conf_usd: 26_465_891.88, mcap_minted_usd: 62_480_320.91,
  mcap_usd_7d_ago: null,
  ...over,
})

const collections: MarketCapBoard = {
  group: "collection",
  collection: null,
  rows: [
    row({}),
    row({
      collection_slug: "laliga_golazos", group_key: "laliga_golazos", group_label: "laliga_golazos",
      editions_supply_known: 0, burned: null, issuer_held: null, collector_held: null,
      mcap_usd: null, mcap_high_conf_usd: null, mcap_minted_usd: 8_914_393.23,
    }),
  ],
}
const emptyDrill: MarketCapBoard = { group: "player", collection: "nba_top_shot", rows: [] }

describe("MarketCapBoardClient", () => {
  it("renders an UNKNOWN cap as Unknown with its upper bound — never as $0 or as the bound itself", () => {
    const { container } = render(
      <MarketCapBoardClient initialCollections={collections} initialDrill={emptyDrill} initialFetchedAt="2026-10-03T20:00:00Z" />,
    )
    const golazos = Array.from(container.querySelectorAll("tr")).find((tr) => tr.textContent?.includes("LaLiga Golazos"))
    expect(golazos).toBeTruthy()
    const capCell = golazos!.querySelectorAll("td")[1].textContent ?? ""
    expect(capCell).toMatch(/^Unknown/)
    expect(capCell).toContain("≤ $8.91M on minted supply")
    expect(golazos!.textContent).not.toMatch(/\$0\b/)
  })

  it("renders a known cap and its high-confidence share", () => {
    const { container } = render(
      <MarketCapBoardClient initialCollections={collections} initialDrill={emptyDrill} initialFetchedAt="2026-10-03T20:00:00Z" />,
    )
    const ts = Array.from(container.querySelectorAll("tr")).find((tr) => tr.textContent?.includes("NBA Top Shot"))!
    expect(ts.textContent).toContain("$51.76M")
    expect(ts.textContent).toContain("51%")
  })

  it("the headline total sums KNOWN caps only and names the unknown count", () => {
    const { container } = render(
      <MarketCapBoardClient initialCollections={collections} initialDrill={emptyDrill} initialFetchedAt="2026-10-03T20:00:00Z" />,
    )
    expect(container.textContent).toContain("$51.76M across 1 collection with a known supply split · 1 unknown")
    expect(container.textContent).not.toContain("$60.67M")
  })

  it("a FAILED server read does not conclude the board is empty", () => {
    const { container } = render(
      <MarketCapBoardClient
        initialCollections={{ group: "collection", collection: null, rows: [] }}
        initialCollectionsFailed
        initialDrill={emptyDrill}
        initialDrillFailed
        initialFetchedAt={null}
      />,
    )
    expect(container.textContent).not.toContain("No priced collections yet.")
    expect(container.textContent).not.toMatch(/No players carry this field/)
    expect(container.textContent).toMatch(/couldn.{1,8}t be loaded/i)
  })

  it("NO-CHANGE CONTROL: a genuinely empty drill-down still says so", () => {
    const { container } = render(
      <MarketCapBoardClient initialCollections={collections} initialDrill={emptyDrill} initialFetchedAt="2026-10-03T20:00:00Z" />,
    )
    expect(container.textContent).toMatch(/No players carry this field in NBA Top Shot\./)
  })
})
