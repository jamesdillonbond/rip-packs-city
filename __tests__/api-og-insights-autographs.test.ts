import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { installOgCapture, resetOgCapture, ogText, type OgCapture } from "./helpers/og-capture"

// /api/og/insights/autographs — the bespoke card for the signed-edition board.
// The shared sweeps cover bytes (api-og-cards-render-sweep) and the empty-vs-
// unavailable pair (api-og-insights-empty-vs-unavailable). This file pins what is
// specific to THIS card: the header counts come from a sort that filters nothing
// (sort=scarcity) at the route's real clamp (500), a failed count is DROPPED
// rather than printed as zero, the hero rows are LISTED asks, and no FMV or
// confidence wording reaches the image.

const capture: { c: OgCapture | null } = { c: null }
let seen: string[] = []

const HERO = [
  { player_name: "Cooper Flagg", set_name: "Rookie Debut", parallel: "Hardcourt", circulation_count: 50, low_ask: 412 },
  { player_name: "Paige Bueckers", set_name: "WNBA Rookie Debut", parallel: "Hardcourt", circulation_count: 50, low_ask: 95.5 },
  { player_name: "Magic Johnson", set_name: "The Anthology: Magic Johnson", parallel: "Standard", circulation_count: 80, low_ask: 1200 },
]

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

function mockFetch(opts: { allDayCount: "ok" | "fail" }) {
  seen = []
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input)
    seen.push(url)
    if (url.includes("sort=scarcity")) {
      if (url.includes("nfl_all_day")) {
        return opts.allDayCount === "fail"
          ? new Response("down", { status: 503 })
          : json({ meta: { returned_rows: 226, truncated: false }, rows: [] })
      }
      return json({ meta: { returned_rows: 236, truncated: false }, rows: [] })
    }
    if (url.includes("sort=listed")) return json({ meta: { returned_rows: 3, truncated: true }, rows: HERO })
    return new Response("unexpected", { status: 404 })
  }) as unknown as typeof globalThis.fetch
}

async function render() {
  const mod = await import("@/app/api/og/insights/autographs/route")
  const res = await mod.GET(new NextRequest("https://www.rippackscity.com/api/og/insights/autographs"))
  return { res, text: ogText(capture.c!.element()) }
}

beforeEach(() => {
  resetOgCapture()
  capture.c = installOgCapture()
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  resetOgCapture()
})

describe("/api/og/insights/autographs", () => {
  it("renders both collections' signed counts and the three cheapest listed asks", async () => {
    mockFetch({ allDayCount: "ok" })
    const { text } = await render()
    expect(text).toContain("236 Top Shot · 226 All Day signed editions")
    expect(text).toContain("Cooper Flagg")
    expect(text).toContain("Rookie Debut · Hardcourt · /50")
    expect(text).toContain("$412")
    expect(text).toContain("$95.50")
    // A Standard printing does not repeat the word.
    expect(text).toContain("The Anthology: Magic Johnson · /80")
    expect(text).not.toContain("Standard")
  })

  it("counts every signed edition: sort=scarcity at the route's 500 clamp, never the 3-row hero page", async () => {
    mockFetch({ allDayCount: "ok" })
    await render()
    const counts = seen.filter((u) => u.includes("sort=scarcity"))
    expect(counts).toHaveLength(2)
    for (const u of counts) expect(u).toContain("limit=500")
    expect(seen.some((u) => u.includes("sort=listed") && u.includes("limit=3"))).toBe(true)
  })

  it("a FAILED count is left out of the header, never printed as 0", async () => {
    mockFetch({ allDayCount: "fail" })
    const { text } = await render()
    expect(text).toContain("236 Top Shot signed editions")
    expect(text).not.toMatch(/\b0 All Day/)
    expect(text).not.toContain("All Day signed")
  })

  it("carries no FMV or confidence wording", async () => {
    mockFetch({ allDayCount: "ok" })
    const { text } = await render()
    expect(text).not.toMatch(/\bFMV\b|confidence|\bHIGH\b|\bMEDIUM\b|\bLOW\b/)
  })
})
