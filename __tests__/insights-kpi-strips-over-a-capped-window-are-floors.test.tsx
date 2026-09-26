// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, within } from "@testing-library/react"

vi.mock("next/image", () => ({ default: () => null }))

import TrophiesBoardClient from "@/app/insights/trophies/TrophiesBoardClient"
import OfferSpreadBoardClient from "@/app/insights/offer-spread/OfferSpreadBoardClient"

// known-issues #146 (2026-09-25): both boards read a 200-row window and counted
// their KPI strip over it — the Trophy Room read "Trophies 200" over a view of
// 1,456 (1,347 one-of-ones). At the cap every count is a FLOOR ("200+"); under
// the cap it is the census and prints plainly.

beforeEach(() => {
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: false, media: q, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia
  }
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const trophy = (i: number) => ({
  edition_id: `e${i}`, external_id: `1:${i}`, collection: "nba_top_shot", collection_id: null, name: `T${i}`,
  player_name: `P${i}`, set_name: "S", team_name: null, tier: "ULTIMATE", series: 4, circulation_count: 1,
  thumbnail_url: null, video_url: null, is_one_of_one: true, is_ultimate: true, fmv_usd: 100 + i,
  confidence: "HIGH", fmv_computed_at: null,
})

const spread = (i: number) => ({
  edition_id: `s${i}`, external_id: `1:${i}`, player_name: `P${i}`, set_name: "S", tier: "RARE",
  circulation_count: 100, low_ask: 10, top_bid: 9, spread_usd: 1, par_distance: 5, bid_meets_ask: false,
  ask_updated_at: null, bid_updated_at: null, thumbnail_url: null,
})

const kpi = (label: RegExp) => {
  const strip = document.querySelector('[aria-label="Summary"]') as HTMLElement
  const cell = within(strip).getByText(label).parentElement as HTMLElement
  return cell.textContent ?? ""
}

describe("KPI strips over a capped window print floors", () => {
  it("Trophy Room: at the 200-row cap the counts read 200+, not 200", () => {
    render(<TrophiesBoardClient initialRows={Array.from({ length: 200 }, (_, i) => trophy(i)) as never} initialFetchedAt={null} />)
    expect(kpi(/^Trophies$/)).toContain("200+")
    expect(kpi(/^1-of-1s$/)).toContain("200+")
  })

  it("Trophy Room: under the cap the count is the census and prints plainly", () => {
    render(<TrophiesBoardClient initialRows={Array.from({ length: 12 }, (_, i) => trophy(i)) as never} initialFetchedAt={null} />)
    expect(kpi(/^Trophies$/)).toMatch(/12$/)
    expect(kpi(/^Trophies$/)).not.toContain("+")
  })

  it("Offer spread: at the cap the counts are floors and the median names its population", () => {
    render(<OfferSpreadBoardClient initialRows={Array.from({ length: 200 }, (_, i) => spread(i)) as never} initialFetchedAt={null} />)
    expect(kpi(/^Within 10% of floor$/)).toContain("200+")
    expect(document.body.textContent).toContain("Median spread (rows shown)")
  })
})
