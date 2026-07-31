// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

// Populated-row tests for the biggest smoke-only /insights boards. The
// board-clients smoke sweep renders these with NO rows (empty branch only);
// these render ONE populated row so the per-row cell mapping + money/discount/
// premium formatters — the largest previously-uncovered chunk of each file —
// actually execute. Player name is the stable anchor.

import SerialPremiumsBoardClient from "@/app/insights/serial-premiums/SerialPremiumsBoardClient"
import UnderpricedSerialsBoardClient from "@/app/insights/underpriced-serials/UnderpricedSerialsBoardClient"
import SqueezeBoardClient from "@/app/insights/squeeze/SqueezeBoardClient"
import RookieBoardClient from "@/app/insights/rookie-board/RookieBoardClient"

const FETCHED = "2026-07-31T00:00:00Z"
const PLAYER = "Victor Wembanyama"

const serialRow = {
  edition_id: "e1",
  external_id: "141:5156",
  player_name: PLAYER,
  set_name: "Base Set",
  tier: "LEGENDARY",
  circulation_count: 2999,
  thumbnail_url: "https://example.com/a.png",
  moment_id: "m1",
  nft_id: "n1",
  edition_median_usd: 100,
  premium_multiple: 12.5,
  edition_sales_180d: 40,
  is_conflated: false,
  headline_serial: 1,
  headline_last_sale_usd: 1250,
  headline_sold_at: "2026-07-30T00:00:00Z",
}

const underpricedRow = {
  edition_id: "e1",
  external_id: "141:5156",
  edition_key: "141:5156",
  player_name: PLAYER,
  set_name: "Base Set",
  tier: "LEGENDARY",
  circulation_count: 2999,
  thumbnail_url: "https://example.com/a.png",
  nft_id: "n1",
  serial_number: 1,
  kind: "first" as const,
  ask_usd: 500,
  serial_fmv_usd: 900,
  edition_fmv_usd: 200,
  confidence: "HIGH",
  discount_pct: 44,
  discount_usd: 400,
  estimate_quality: "tight" as const,
  listing_url: "https://flowty.io/x",
  listed_at: FETCHED,
  last_seen_at: FETCHED,
}

const squeezeRow = {
  edition_id: "e1",
  external_id: "141:5156",
  player_name: PLAYER,
  set_name: "Base Set",
  tier: "LEGENDARY",
  circulation: 2999,
  locked: 1500,
  burned: 200,
  lock_pct: 50,
  burn_pct: 6.7,
  squeeze_pct: 56.7,
  effectively_buyable: 1299,
  low_ask: 150,
  fmv_usd: 200,
  confidence: "HIGH",
  game_date: "2026-01-01",
  thumbnail_url: "https://example.com/a.png",
}

const rookieRow = {
  player_name: PLAYER,
  set_name: "Base Set",
  series_number: 4,
  tier: "LEGENDARY",
  parallel_id: null,
  parallel_name: null,
  external_id: "141:5156",
  circulation_count: 2999,
  fmv_usd: 200,
  fmv_confidence: "HIGH",
  low_ask: 150,
  highest_offer: 120,
  avg_sale_price: 180,
  burned: 200,
  locked: 1500,
  effective_supply: 1299,
  burn_rate_pct: 6.7,
  lock_rate_pct: 50,
  has_full_economics: true,
  thumbnail_url: "https://example.com/a.png",
  video_url: null,
}

beforeEach(() => {
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: false, media: q, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
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

describe("insights boards — populated row render", () => {
  it("SerialPremiumsBoardClient renders a #1-premium row", () => {
    const { getAllByText } = render(
      <SerialPremiumsBoardClient initialRows={[serialRow]} initialFetchedAt={FETCHED} />,
    )
    expect(getAllByText(new RegExp(PLAYER)).length).toBeGreaterThan(0)
  })

  it("UnderpricedSerialsBoardClient renders a discounted serial row", () => {
    const { getAllByText } = render(
      <UnderpricedSerialsBoardClient initialRows={[underpricedRow]} initialFetchedAt={FETCHED} />,
    )
    expect(getAllByText(new RegExp(PLAYER)).length).toBeGreaterThan(0)
  })

  it("SqueezeBoardClient renders a locked/burned squeeze row", () => {
    const { getAllByText } = render(
      <SqueezeBoardClient initialRows={[squeezeRow]} initialFetchedAt={FETCHED} />,
    )
    expect(getAllByText(new RegExp(PLAYER)).length).toBeGreaterThan(0)
  })

  it("RookieBoardClient renders a rookie-edition economics row", () => {
    const { getAllByText } = render(
      <RookieBoardClient initialRows={[rookieRow]} initialFetchedAt={FETCHED} />,
    )
    expect(getAllByText(new RegExp(PLAYER)).length).toBeGreaterThan(0)
  })
})
