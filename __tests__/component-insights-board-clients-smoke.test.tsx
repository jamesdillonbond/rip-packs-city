// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

// Empty-render smoke sweep for the public /insights board clients. Rendering each
// with no rows drives its whole component body — useState inits, the useMemo/
// build helpers over an empty window, the filter/sort controls, and the
// empty-state branch — which is the bulk of each file's statements. It does NOT
// cover per-row cell rendering (the detailed component-*Client tests do that for
// the top boards: TopSales, Deals, Market, OfferSpread, Candy, Panini). The value
// here is that these public financial surfaces are now MEASURED (they lived under
// app/ where neither coverage gate reached) so they can't silently rot, and a
// render-time crash (a bad build helper, a null deref in a control) fails CI
// instead of the live page.

import AllDayScarcityBoardClient from "@/app/insights/allday-scarcity/AllDayScarcityBoardClient"
import PinnacleScarcityBoardClient from "@/app/insights/pinnacle-scarcity/PinnacleScarcityBoardClient"
import RookieBoardClient from "@/app/insights/rookie-board/RookieBoardClient"
import SerialPremiumsBoardClient from "@/app/insights/serial-premiums/SerialPremiumsBoardClient"
import SetSqueezeBoardClient from "@/app/insights/set-squeeze/SetSqueezeBoardClient"
import SqueezeBoardClient from "@/app/insights/squeeze/SqueezeBoardClient"
import TrophiesBoardClient from "@/app/insights/trophies/TrophiesBoardClient"
import UnderpricedSerialsBoardClient from "@/app/insights/underpriced-serials/UnderpricedSerialsBoardClient"
import ParallelPremiumsBoardClient from "@/app/insights/parallel-premiums/ParallelPremiumsBoardClient"
import PackDropsBoardClient from "@/app/insights/pack-drops/PackDropsBoardClient"
import PackSniperClient from "@/app/insights/pack-sniper/PackSniperClient"
import MarketPulseClient from "@/app/insights/market-pulse/MarketPulseClient"
import NewCollectorsBoardClient from "@/app/insights/new-collectors/NewCollectorsBoardClient"
import SetCompletersBoardClient from "@/app/insights/set-completers/SetCompletersBoardClient"
import CrossCollectionBoardClient from "@/app/insights/cross-collection/CrossCollectionBoardClient"
import FirstMintBoardClient from "@/app/insights/first-mint/FirstMintBoardClient"
import RookiesBoardClient from "@/app/insights/rookies/RookiesBoardClient"
import { EMPTY_BOARD as NEW_COLLECTORS_EMPTY } from "@/lib/new-collectors-board"
import { EMPTY_BOARD as SET_COMPLETERS_EMPTY } from "@/lib/set-completers-board"

const FETCHED = "2026-07-31T00:00:00Z"

beforeEach(() => {
  // jsdom has no matchMedia; PackSniperClient reads it for a narrow-viewport flag.
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia
  }
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (String(url).includes("/api/profile/me")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ rows: [], meta: { fetched_at: null, total_rows: 0, elapsed_ms: 1 } }),
      } as Response)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// Each entry renders a board client with its minimal empty props. A rendered
// tree with non-empty text = the component reached its empty/header state.
const CASES: Array<[string, () => React.ReactElement]> = [
  ["AllDayScarcityBoardClient", () => <AllDayScarcityBoardClient initialRows={[]} initialFetchedAt={null} />],
  ["PinnacleScarcityBoardClient", () => <PinnacleScarcityBoardClient initialRows={[]} initialFetchedAt={null} />],
  ["RookieBoardClient", () => <RookieBoardClient initialRows={[]} initialFetchedAt={null} />],
  ["SerialPremiumsBoardClient", () => <SerialPremiumsBoardClient initialRows={[]} initialFetchedAt={null} />],
  ["SetSqueezeBoardClient", () => <SetSqueezeBoardClient initialRows={[]} initialFetchedAt={null} />],
  ["SqueezeBoardClient", () => <SqueezeBoardClient initialRows={[]} initialFetchedAt={null} />],
  ["TrophiesBoardClient", () => <TrophiesBoardClient initialRows={[]} initialFetchedAt={null} />],
  ["UnderpricedSerialsBoardClient", () => <UnderpricedSerialsBoardClient initialRows={[]} initialFetchedAt={null} />],
  ["ParallelPremiumsBoardClient", () => <ParallelPremiumsBoardClient initialRows={[]} initialFetchedAt={FETCHED} />],
  ["PackDropsBoardClient", () => <PackDropsBoardClient initialDrops={[]} initialFetchedAt={null} />],
  ["PackSniperClient", () => <PackSniperClient initialDeals={[]} initialFetchedAt={null} />],
  ["MarketPulseClient", () => <MarketPulseClient initialRows={[]} fetchedAt={FETCHED} />],
  ["NewCollectorsBoardClient", () => <NewCollectorsBoardClient initialBoard={NEW_COLLECTORS_EMPTY} initialFetchedAt={null} />],
  ["SetCompletersBoardClient", () => <SetCompletersBoardClient initialBoard={SET_COMPLETERS_EMPTY} initialFetchedAt={FETCHED} />],
  [
    "CrossCollectionBoardClient",
    () => (
      <CrossCollectionBoardClient
        initial={{ meta: { fetched_at: FETCHED }, stats: null, wallets: [], ts_set_overlap: [] }}
      />
    ),
  ],
  [
    "FirstMintBoardClient",
    () => <FirstMintBoardClient initial={{ meta: { fetched_at: FETCHED }, stats: null, trophies: [] }} />,
  ],
  [
    "RookiesBoardClient",
    () => <RookiesBoardClient initial={{ meta: { fetched_at: FETCHED }, cohort_stats: null, rows: [] }} />,
  ],
]

describe("insights board clients — empty render smoke", () => {
  it.each(CASES)("%s renders its empty state without crashing", (_name, el) => {
    const { container } = render(el())
    expect(container.textContent && container.textContent.length).toBeGreaterThan(0)
  })
})
