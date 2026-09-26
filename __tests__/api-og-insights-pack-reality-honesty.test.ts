import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { installOgCapture, resetOgCapture, ogText, type OgCapture } from "./helpers/og-capture"

// 2026-09-26 — the Pack Reality OG card (a public PNG, edge-cached 1h + 24h stale):
//   • its subtitle HARDCODED "Median pull value $0." — false (live $0.91, with 31.6%
//     of rips at $0), so every share of the board published it;
//   • its OVER $100 tile used `?? 0`, so a failed stats read printed "0.00%" —
//     "no rip was worth over $100" — beside two "—" tiles.

const capture: { c: OgCapture | null } = { c: null }

function mockStats(mode: "ok" | "fail") {
  globalThis.fetch = vi.fn(async () => {
    if (mode === "fail") return new Response("down", { status: 503 })
    return new Response(
      JSON.stringify({
        stats: { rips_60d: 69956, zero_value_pct: 31.6, mean_pull_value_usd: 8.45, median_pull_value_usd: "0.91", rips_over_100_pct: "1.47" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as unknown as typeof globalThis.fetch
}

async function render() {
  const mod = await import("@/app/api/og/insights/pack-reality/route")
  await mod.GET(new NextRequest("https://www.rippackscity.com/api/og/insights/pack-reality"))
  return ogText(capture.c!.element())
}

beforeEach(() => {
  resetOgCapture()
  capture.c = installOgCapture()
})
afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  resetOgCapture()
})

describe("Pack Reality OG card states only what the stats read supplied", () => {
  it("prints the LIVE median and over-$100 share, never the hardcoded $0", async () => {
    mockStats("ok")
    const text = await render()
    expect(text).toContain("Median pull value $0.91")
    expect(text).not.toMatch(/Median pull value \$0\.(?!9)/)
    expect(text).toContain("1.47%")
  })

  it("a FAILED stats read prints no median and no 0.00% — '—' instead", async () => {
    mockStats("fail")
    const text = await render()
    expect(text).not.toMatch(/Median pull value/)
    expect(text).not.toContain("0.00%")
    expect(text).toContain("—")
  })
})

// The page's STATIC metadata quoted live figures ("Over 145,000 rips", "~41%
// delivered nothing", "Under 1% deliver over $100") that each went false as the
// 60-day window moved (live 69,956 · 31.6% · 1.47%). Static copy cannot track a
// moving number, so it carries none — the page and the OG card print the live ones.
describe("Pack Reality static metadata carries no live figure", () => {
  it("no percentage, rip count or dollar threshold in any description", async () => {
    const { metadata } = await import("@/app/insights/pack-reality/layout")
    const m = metadata as { description?: string; openGraph?: { description?: string }; twitter?: { description?: string } }
    const descs = [m.description, m.openGraph?.description, m.twitter?.description].filter(Boolean) as string[]
    expect(descs.length).toBe(3)
    for (const d of descs) {
      expect(d).not.toMatch(/\d+\s*%/)
      expect(d).not.toMatch(/\d{1,3}(,\d{3})+/)
      expect(d).not.toMatch(/under \$\d/i)
    }
  })
})
