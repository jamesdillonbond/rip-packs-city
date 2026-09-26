// @vitest-environment jsdom
//
// Panini published 2026-09-25 on the shared /[collection]/overview. Its sales
// are NOT a tracked feed (the route nulls them with `sales_tracked: false`), and
// every Panini surface carries the listing-gated coverage disclosure. Pins:
//   • no "$0" volume and no "No sales in the last 24h" — those would be claims
//     about Panini's market manufactured from Flow feeds holding zero Panini rows;
//   • the disclosure renders, with figures when the read succeeded and without
//     them (but still present) when it failed;
//   • no Flow insider detectors for a collection with no chain;
//   • a no-change control: Top Shot still renders its volume.
import React from "react"
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, waitFor, cleanup } from "@testing-library/react"

vi.mock("@/components/InsiderSignalsPanel", () => ({ default: () => <div data-testid="insider-signals" /> }))
vi.mock("@/components/marketplace-status", () => ({ MarketplaceStatusBanner: () => null }))
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children?: React.ReactNode } & Record<string, unknown>) => <a {...rest}>{children}</a>,
}))

import OverviewPage from "@/app/(collections)/[collection]/overview/CollectionOverviewClient"
import PaniniCoverageNote from "@/components/collection/PaniniCoverageNote"

const COVERAGE = {
  total_editions: 5094, pct_trustworthy: 35.2, listing_gated_editions: 3300, listing_gated_families: 40,
  families: 62, edition_age_p50_h: 22.5, edition_age_p90_h: 38.9, pct_editions_stale_45d: 0,
}
const PANINI_STATS = {
  edition_count: 5094, fmv_pct: 100, fmv_high_medium_pct: 37.2, fmv_age_minutes: 1,
  volume_24h: null, volume_7d: null, sales_24h: null, top_sales: null, sniper_deals: null, listing_count: null,
  sales_tracked: false, coverage: COVERAGE, coverage_failed: false,
}
const okFetch = (body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as Response) as unknown as typeof fetch)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("Panini overview", () => {
  it("renders the coverage disclosure with figures, and no manufactured sales claim", async () => {
    okFetch(PANINI_STATS)
    render(<OverviewPage collection="panini-blockchain" />)
    await waitFor(() => expect(screen.getByTestId("panini-coverage-note")).toBeTruthy())
    const note = screen.getByTestId("panini-coverage-note").textContent ?? ""
    expect(note).toMatch(/a floor, not a census/i)
    expect(note).toContain("5,094")
    expect(screen.queryByText(/No sales in the last 24h/i)).toBeNull()
    expect(screen.getByText(/Sales aren.t a tracked feed/i)).toBeTruthy()
    expect(screen.queryByText("24h Sales Volume")).toBeNull()
    expect(screen.getByText("Typical Price Checked")).toBeTruthy()
    expect(screen.queryByText("$0")).toBeNull()
    expect(screen.queryByTestId("insider-signals")).toBeNull()
  })

  it("a failed stats read still renders the disclosure (principle, no figures)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: "x" }) }) as Response) as unknown as typeof fetch)
    render(<OverviewPage collection="panini-blockchain" />)
    await waitFor(() => expect(screen.getByText(/Coverage figures couldn.t be loaded/i)).toBeTruthy())
    expect(screen.getByTestId("panini-coverage-note").textContent).toMatch(/listed for sale/)
  })

  it("no-change control: Top Shot still renders its 24h volume and its insider detectors", async () => {
    okFetch({ edition_count: 100, fmv_pct: 50, volume_24h: 1234, fmv_age_minutes: 5, top_sales: [], sniper_deals: [] })
    render(<OverviewPage collection="nba-top-shot" />)
    await waitFor(() => expect(screen.getByText("$1,234")).toBeTruthy())
    expect(screen.getByTestId("insider-signals")).toBeTruthy()
    expect(screen.queryByTestId("panini-coverage-note")).toBeNull()
  })
})

describe("PaniniCoverageNote", () => {
  it("always states the principle, even with no figures and no failure", () => {
    render(<PaniniCoverageNote coverage={null} />)
    const t = screen.getByTestId("panini-coverage-note").textContent ?? ""
    expect(t).toMatch(/listed for sale/)
    expect(t).not.toMatch(/\d{2,}/) // no number invented from nothing
  })

  it("renders the rotation ages in days, never zero", () => {
    render(<PaniniCoverageNote coverage={{ ...COVERAGE, edition_age_p50_h: 2, edition_age_p90_h: 100 }} />)
    const t = screen.getByTestId("panini-coverage-note").textContent ?? ""
    expect(t).toContain("within a day")
    expect(t).toContain("4 days ago")
    expect(t).not.toContain("0 days")
  })
})
