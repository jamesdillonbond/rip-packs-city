// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"

// The same "a failed read is rendered as a finding" class, swept beyond
// components/analytics. Three more live instances, each on a surface where the
// fabricated sentence is about the reader's own money:
//
//   EditionRecentSales        "No recent sales"                     (a market fact
//                                                                    a collector
//                                                                    prices against)
//   TopMoversCard             "FMV history building — check back in a few days."
//   CollectionBreakdownCard   "No collection data yet."  +  "0 moments"
//
// TopMoversCard is the sharpest of the three: its copy does not merely say
// nothing moved, it EXPLAINS the blank as pipeline progress and sends the reader
// away for several days. That is the same shape as the pack-market boards'
// "Still gathering sales. The complete sealed-pack sale history is
// backfilling…", which the /insights sweep gated on `ok` for exactly this reason.
//
// CollectionBreakdownCard printed a HOLDINGS COUNT too — a collector who owns
// thousands of moments saw "0 moments" in the card header.
//
// Every case has a mirror: a successful empty read must still produce the
// original copy, or the fix has just replaced one wrong answer with another.

import EditionRecentSales from "@/components/collection/EditionRecentSales"
import TopMoversCard from "@/components/profile/TopMoversCard"
import CollectionBreakdownCard from "@/components/profile/CollectionBreakdownCard"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubFail() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as never)
  )
}
function stubEmpty(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as never))
}

const text = () => document.body.textContent ?? ""

describe("EditionRecentSales", () => {
  it("does not report an absence of sales when the read fails", async () => {
    stubFail()
    render(<EditionRecentSales editionKey="73:2785" mintCount={1000} />)
    expect(await screen.findByText(/Couldn't load recent sales/)).toBeTruthy()
    expect(text()).not.toContain("No recent sales")
  })

  it("still reports a genuinely unsold edition", async () => {
    stubEmpty({ sales: [] })
    render(<EditionRecentSales editionKey="73:2785" mintCount={1000} />)
    expect(await screen.findByText("No recent sales")).toBeTruthy()
  })

  it("renders sales when they load", async () => {
    stubEmpty({ sales: [{ serialNumber: 5, price: 42, soldAt: new Date().toISOString() }] })
    render(<EditionRecentSales editionKey="73:2785" mintCount={1000} />)
    expect(await screen.findByText(/\$42\.00/)).toBeTruthy()
  })
})

describe("TopMoversCard", () => {
  it("does not explain a failed read as pipeline progress", async () => {
    stubFail()
    render(<TopMoversCard ownerKey="0xabc" />)
    expect(await screen.findByText(/Couldn't load top movers/)).toBeTruthy()
    // Telling a user to "check back in a few days" for a 500 is advice to wait
    // out an outage that will be over in minutes.
    expect(text()).not.toMatch(/FMV history building/)
    expect(text()).not.toMatch(/check back in a few days/)
  })

  it("still says FMV history is building on a successful empty read", async () => {
    // Here the copy is TRUE and useful — a new wallet really has no FMV history.
    stubEmpty({ gainers: [], losers: [] })
    render(<TopMoversCard ownerKey="0xabc" />)
    expect(await screen.findByText(/FMV history building/)).toBeTruthy()
  })
})

describe("CollectionBreakdownCard", () => {
  it("does not report the viewer as holding nothing when the read fails", async () => {
    stubFail()
    render(<CollectionBreakdownCard ownerKey="0xabc" />)
    expect(await screen.findByText(/Couldn't load your collection breakdown/)).toBeTruthy()
    const t = text()
    expect(t).not.toContain("No collection data yet.")
    // The header count is the second, quieter claim — it read "0 moments" for a
    // collector who owns thousands.
    expect(t).not.toContain("0 moments")
    expect(t).toContain("—")
  })

  it("still reports a genuinely empty portfolio", async () => {
    stubEmpty({ collections: [] })
    render(<CollectionBreakdownCard ownerKey="0xabc" />)
    expect(await screen.findByText(/No collection data yet\./)).toBeTruthy()
    expect(text()).toContain("0 moments")
  })

  it("renders the breakdown and its real count when rows load", async () => {
    stubEmpty({
      collections: [
        { collection_id: "c1", collection_name: "NBA Top Shot", moment_count: 812, total_fmv: 9100, color: "#fff" },
      ],
    })
    render(<CollectionBreakdownCard ownerKey="0xabc" />)
    expect(await screen.findByText(/NBA Top Shot/)).toBeTruthy()
    expect(text()).toContain("812 moments")
  })
})
