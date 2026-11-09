import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { installOgCapture, resetOgCapture, ogText, type OgCapture } from "./helpers/og-capture"

// /api/og/insights/drops — the link preview for /insights/drops (pack drops this week).
// Pins: the card names the week's LIVE drops priciest first with each app's wording; an ended
// drop is not on it; an unread calendar is never "no drops"; no FMV/confidence/DUC wording.

const capture: { c: OgCapture | null } = { c: null }

const DROPS = [
  { collection: "nba_top_shot", dist_id: "8919", title: "Rookie Debut Collector Pack", kind: "rsvp", retail_usd: 39, start_time: "2026-11-05T20:00:00Z", end_time: "2026-11-11T22:00:00Z", status: "open" },
  { collection: "nba_top_shot", dist_id: "8916", title: "Rookie Debut Case", kind: "rsvp", retail_usd: 2500, start_time: "2026-11-05T20:00:00Z", end_time: "2026-11-11T20:00:00Z", status: "open" },
  { collection: "disney_pinnacle", dist_id: "8912", title: "Stitch in Costume Vol.1", kind: "rsvp", retail_usd: 49.95, start_time: "2026-10-30T18:00:00Z", end_time: "2026-11-06T17:20:00Z", status: "ended" },
  { collection: "panini_blockchain", dist_id: "1060", title: "Prizm The Rolling Stones Packs", kind: "sale", retail_usd: 25, start_time: "2026-11-06T16:00:00Z", end_time: null, status: "open" },
]

function mockFetch(res: Response | "throw") {
  globalThis.fetch = vi.fn(async () => {
    if (res === "throw") throw new Error("ECONNRESET")
    return res.clone()
  }) as unknown as typeof globalThis.fetch
}
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

async function render() {
  const mod = await import("@/app/api/og/insights/drops/route")
  const res = await mod.GET(new NextRequest("https://www.rippackscity.com/api/og/insights/drops"))
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

describe("GET /api/og/insights/drops", () => {
  it("names the live drops priciest first, in each app's words; an ended draw is left off", async () => {
    mockFetch(json({ meta: { complete: true }, drops: DROPS }))
    const { res, text } = await render()
    expect(res.status).toBe(200)
    expect(text.indexOf("ROOKIE DEBUT CASE")).toBeLessThan(text.indexOf("ROOKIE DEBUT COLLECTOR PACK"))
    expect(text).toContain("$2,500")
    expect(text).toContain("Pre-orders close Wed 12 PM PT")
    expect(text).toContain("On sale now")
    expect(text).not.toContain("STITCH")
    expect(text).not.toMatch(/RSVP|confidence|DUC/i)
  })

  it("names EVERY live drop, never '+N more' (Trevor 11-08: always name them all)", async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ collection: "nba_top_shot", dist_id: String(9000 + i), title: `Drop Number ${i + 1}`, kind: "sale", retail_usd: 100 - i, start_time: "2026-11-05T20:00:00Z", end_time: null, status: "open" }))
    for (const n of [9, 11, 20]) {
      resetOgCapture()
      capture.c = installOgCapture()
      vi.resetModules()
      const drops = n <= 11 ? many.slice(0, n) : [...many, ...many.slice(0, n - 11).map((d, i) => ({ ...d, dist_id: String(9100 + i), title: `Extra Drop ${i + 1}` }))]
      mockFetch(json({ meta: { complete: true }, drops }))
      const { text } = await render()
      for (const d of drops) expect(text).toContain(d.title.toUpperCase())
      expect(text).not.toMatch(/\bmore on the page\b|\+\s*\d+\s*more/i)
    }
  })

  it("an unreachable calendar renders the generic line, never 'no drops'", async () => {
    mockFetch("throw")
    const { res, text } = await render()
    expect(res.status).toBe(200)
    expect(text).not.toMatch(/No drop/i)
    expect(text).toContain("Every pack drop open now or starting this week")
  })

  it("a read calendar with nothing live says so plainly", async () => {
    mockFetch(json({ meta: { complete: true }, drops: [DROPS[2]] }))
    const { text } = await render()
    expect(text).toContain("No drop open or scheduled this week")
  })

  it("a half-read calendar with nothing live does NOT claim an empty week", async () => {
    mockFetch(json({ meta: { complete: false }, drops: [DROPS[2]] }))
    const { text } = await render()
    expect(text).not.toMatch(/No drop/i)
  })
})
