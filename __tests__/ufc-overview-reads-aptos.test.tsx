// @vitest-environment jsdom
//
// UFC Strike reopened on Aptos 2026-11-26 (Trevor: "Do it all … chain-agnostic"). Its overview
// still said the market was over: a FLOW-only chain chip, an ARCHIVED pipeline pill beside live
// Aptos sales, "No deals ≥15% off" read from the CLOSED Flow venue beside a Sniper tab of ~465
// live Aptos asks, and Flow insider detectors watching a venue with no trades. Pinned here:
//   - the panel lists live Aptos asks from the sniper's own source, and a failed read is
//     "couldn't load", never an empty board;
//   - the pill names the per-sale cadence, never ARCHIVED;
//   - the chain chip names both chains.
import React from "react"
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, waitFor, cleanup } from "@testing-library/react"

vi.mock("@/components/InsiderSignalsPanel", () => ({
  default: () => <div data-testid="insider-signals" />,
}))
vi.mock("@/components/marketplace-status", () => ({ MarketplaceStatusBanner: () => null }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import OverviewPage from "@/app/(collections)/[collection]/overview/CollectionOverviewClient"
import { readUfcAptosOverviewAsks, isUfcSlug } from "@/lib/collection-stats/read"
import { getCollection } from "@/lib/collections"

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response)

const STATS = {
  edition_count: 625, fmv_pct: 100, volume_24h: 0, fmv_age_minutes: 180, top_sales: [],
  sniper_deals: [{ player_name: "Jon Jones", set_name: "Fight Night", tier: "CONTENDER", ask_price: 4.2, fmv: 4.2, discount: 0, buy_url: "https://rarible.com/x", serial_number: 12, flow_id: "ed1", chain: "aptos" }],
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe("UFC overview reads Aptos, not the closed Flow venue", () => {
  it("lists live Aptos asks, says PER SALE (never ARCHIVED), and runs no Flow insider detectors", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(STATS)) as unknown as typeof fetch)
    render(<OverviewPage collection="ufc" />)
    await waitFor(() => expect(screen.getByText("Jon Jones")).toBeTruthy())
    expect(screen.getByText(/Cheapest Aptos Asks/i)).toBeTruthy()
    expect(screen.queryByText(/Top Sniper Deals/i)).toBeNull()
    expect(screen.queryByText(/^ARCHIVED$/)).toBeNull()
    expect(screen.getByText("PER SALE")).toBeTruthy()
    expect(screen.queryByTestId("insider-signals")).toBeNull()
  })

  it("an empty (successful) Aptos book says so in Aptos terms — not 'No deals ≥15% off'", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse({ ...STATS, sniper_deals: [] })) as unknown as typeof fetch)
    render(<OverviewPage collection="ufc" />)
    await waitFor(() => expect(screen.getByText(/No live Aptos asks right now/i)).toBeTruthy())
    expect(screen.queryByText(/No deals/i)).toBeNull()
  })

  it("a FAILED Aptos read is 'couldn't load', never an empty board", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse({ ...STATS, sniper_deals: null, sniper_deals_failed: true })) as unknown as typeof fetch)
    render(<OverviewPage collection="ufc" />)
    await waitFor(() => expect(screen.getAllByText(/Couldn.t load this right now/i).length).toBeGreaterThanOrEqual(1))
    expect(screen.queryByText(/No live Aptos asks/i)).toBeNull()
  })

  it("other Flow collections keep the deals panel and their detectors", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse({ ...STATS, fmv_age_minutes: 12, sniper_deals: [] })) as unknown as typeof fetch)
    render(<OverviewPage collection="nba-top-shot" />)
    await waitFor(() => expect(screen.getByText(/No deals/i)).toBeTruthy())
    expect(screen.getByTestId("insider-signals")).toBeTruthy()
  })
})

describe("readUfcAptosOverviewAsks", () => {
  it("maps the five cheapest asks into the overview shape, tagged aptos", async () => {
    const deals = Array.from({ length: 7 }, (_, i) => ({
      playerName: "P" + i, setName: "S", tier: "FANDOM", askPrice: i + 1, adjustedFmv: i + 1, discount: 0,
      buyUrl: "https://rarible.com/c", thumbnailUrl: null, serial: i + 1, editionKey: "e" + i,
    }))
    const feed = vi.fn(async () => ({ deals })) as any
    const r = await readUfcAptosOverviewAsks(feed)
    expect(feed).toHaveBeenCalledWith({ sortBy: "price_asc" })
    expect(r.sniper_deals_failed).toBe(false)
    expect(r.sniper_deals).toHaveLength(5)
    expect(r.sniper_deals![0]).toMatchObject({ player_name: "P0", ask_price: 1, flow_id: "e0", chain: "aptos" })
  })

  it("a throwing feed nulls the list and flags it — never []", async () => {
    const r = await readUfcAptosOverviewAsks((async () => { throw new Error("cap") }) as any)
    expect(r).toEqual({ sniper_deals: null, sniper_deals_failed: true })
  })

  it("names UFC by either slug, and nothing else", () => {
    expect(isUfcSlug("ufc", null)).toBe(true)
    expect(isUfcSlug("ufc_strike", null)).toBe(true)
    expect(isUfcSlug("x", "ufc_strike")).toBe(true)
    expect(isUfcSlug("nba_top_shot", "nba_top_shot")).toBe(false)
  })
})

describe("chain chip", () => {
  it("UFC names both chains; others keep their single chain", () => {
    expect(getCollection("ufc")?.chainDisplay).toBe("Flow + Aptos")
    expect(getCollection("nba-top-shot")?.chainDisplay).toBeUndefined()
  })
})
