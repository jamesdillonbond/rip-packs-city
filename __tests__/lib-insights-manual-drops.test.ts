import { describe, it, expect } from "vitest"
import { buildManualDrops, MANUAL_DROPS, type ManualDrop } from "@/lib/insights/manual-drops"
import { dropStatusLine } from "@/lib/insights/drops-board"

// Hand-entered drops (Top Shot This trade-ins) — no feed carries them, so the calendar reads
// lib/insights/manual-drops.ts. Pins: in the week's window they are listed with the right status
// and the app's own wording ("Trade-ins close …"); a long-closed entry falls off; every entry has
// a close time and a source (an entry without an end would read "open" forever).

const E: ManualDrop = {
  id: "manual-test",
  collection: "nba_top_shot",
  title: "Top Shot This: Test Player",
  kind: "trade_in",
  detail: "trade in $10 of Test Player Moments per pack",
  retail_usd: null,
  start_time: "2026-11-08T08:00:00Z",
  end_time: "2026-11-09T20:00:00Z",
  detail_href: "/insights/trade-in",
  source: "test",
  verified_at: "2026-11-08",
}

describe("buildManualDrops", () => {
  it("lists an open trade-in with its close time in PT", () => {
    const [d] = buildManualDrops(new Date("2026-11-09T03:00:00Z"), [E])
    expect(d.status).toBe("open")
    expect(d.kind).toBe("trade_in")
    expect(dropStatusLine(d)).toBe("Trade-ins close Mon 12 PM PT")
  })
  it("a closed one reads closed, and drops off a week later", () => {
    expect(dropStatusLine(buildManualDrops(new Date("2026-11-10T03:00:00Z"), [E])[0])).toBe("Trade-ins closed")
    expect(buildManualDrops(new Date("2026-11-20T03:00:00Z"), [E])).toEqual([])
  })
  it("every shipped entry has a parseable close, a source and a verified date", () => {
    for (const m of MANUAL_DROPS) {
      expect(Number.isFinite(Date.parse(m.end_time)), m.id).toBe(true)
      expect(m.source.length, m.id).toBeGreaterThan(0)
      expect(m.verified_at, m.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})
