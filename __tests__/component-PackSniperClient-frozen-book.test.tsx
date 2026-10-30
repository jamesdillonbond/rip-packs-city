// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import React from "react"
import type { Deal } from "@/app/insights/pack-sniper/PackSniperClient"
import PackSniperClient from "@/app/insights/pack-sniper/PackSniperClient"

// #218 (2026-10-30) — Dapper's pack index froze for a day. Every read succeeded
// and returned the frozen book, so the board kept saying "Live asks" over packs
// that had already sold (428 Top Shot secondary pack sales on chain since).
// The server proves the freeze (lib/packs/pack-deals.ts readBookFreshness);
// these pin that the board withdraws its "live" claim when it does — and does
// NOT when the book is current or the freshness check could not answer.

const deal = (o: Partial<Deal> = {}): Deal => ({
  distId: "d1", title: "Base Series Pack", tier: "common", imageUrl: "", slots: 5,
  lowestAsk: 20, grossEV: 40, liveValueRatio: 2, discountPct: 50, fmvCoveragePct: 90,
  evSnapshottedAt: "2026-08-01T00:00:00Z", editionCount: 100, depletionPct: 40,
  highVariance: false, highVarianceReasons: [], buyUrl: "https://buy", dapperUrl: "https://dapper",
  detailHref: "/x", simulatorHref: "/y", askChangedAt: null, askFirstSeenAt: null, prevAsk: null,
  isNew: false, isPriceDrop: false, askDropPct: null, lowAsk24h: null, lowAsk7d: null, atLow24h: false, ...o,
})

const frozen = { lastChangedAt: "2026-10-29T15:08:20Z", chainSalesSince: 428, frozen: true }
let book: unknown = null

beforeEach(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ meta: { fetched_at: "2026-10-30T15:00:00Z", collection: "nba-top-shot", book }, deals: [deal()] }),
  })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  book = null
})

describe("PackSniperClient — frozen ask book", () => {
  it("withdraws 'Live asks' and states the on-chain sales when the book is proven frozen", async () => {
    book = frozen
    const { container } = render(
      <PackSniperClient initialDeals={[deal()]} initialBook={frozen} initialFetchedAt="2026-10-30T15:00:00Z" />,
    )
    await waitFor(() => expect(container.textContent).toContain("Base Series Pack"))
    expect(container.textContent).not.toContain("Live asks")
    expect(container.textContent).toContain("These asks may be out of date")
    expect(container.textContent).toContain("428 packs have sold on chain")
  })

  it("keeps the live claim when the book is current", async () => {
    book = { lastChangedAt: "2026-10-30T14:58:00Z", chainSalesSince: null, frozen: false }
    const { container } = render(
      <PackSniperClient initialDeals={[deal()]} initialBook={book as never} initialFetchedAt="2026-10-30T15:00:00Z" />,
    )
    await waitFor(() => expect(container.textContent).toContain("Base Series Pack"))
    expect(container.textContent).toContain("Live asks")
    expect(container.textContent).not.toContain("out of date")
  })

  it("a refetch that proves the book current clears a frozen seed", async () => {
    book = { lastChangedAt: "2026-10-30T14:58:00Z", chainSalesSince: null, frozen: false }
    const { container } = render(
      <PackSniperClient initialDeals={[deal()]} initialBook={frozen} initialFetchedAt="2026-10-30T15:00:00Z" />,
    )
    await waitFor(() => expect(container.textContent).not.toContain("out of date"))
    expect(container.textContent).toContain("Live asks")
  })
})
