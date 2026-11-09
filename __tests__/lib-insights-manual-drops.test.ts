import { describe, it, expect } from "vitest"
import { applyDropCorrections, buildManualDrops, DROP_CORRECTIONS, MANUAL_DROPS, type ManualDrop } from "@/lib/insights/manual-drops"
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

describe("applyDropCorrections — the official page overrides the pack book", () => {
  const base = (over: Partial<import("@/lib/insights/pack-calendar").PackCalendarDrop>) => ({
    collection: "disney_pinnacle" as const, dist_id: "9001", title: "Book Title - LE", tier: null, pack_type: null, kind: "rsvp" as const,
    slots: 1, retail_usd: 9.99, start_time: "2026-11-09T17:00:00Z", end_time: "2026-11-23T17:00:00Z", status: "upcoming" as const, detail_href: "/x", ...over,
  })
  const corr = [
    { dist_id: "9001", title: "Walt Disney Mugs Vol.1", kind: "capsule" as const, detail: "98 LE pins hidden inside", source: "t", verified_at: "2026-11-08" },
    { dist_id: "9002", end_time: "2026-11-13T17:00:00Z", source: "t", verified_at: "2026-11-08" },
  ]
  it("a capsule sale the book calls a draw reads as capsules, never 'draw requests'", () => {
    const d = [base({})]
    applyDropCorrections(d, new Date("2026-11-09T04:00:00Z"), corr)
    expect(d[0].title).toBe("Walt Disney Mugs Vol.1")
    expect(dropStatusLine(d[0])).toBe("Capsules on sale Mon 9 AM PT")
    expect(dropStatusLine(d[0])).not.toMatch(/draw/i)
    applyDropCorrections(d, new Date("2026-11-10T04:00:00Z"), corr)
    expect(dropStatusLine(d[0])).toBe("Capsules on sale now")
  })
  it("a draw's close comes from the official page, not the book's waiting-room end", () => {
    const d = [base({ dist_id: "9002", start_time: "2026-11-12T17:00:00Z", end_time: "2026-11-20T17:00:00Z" })]
    applyDropCorrections(d, new Date("2026-11-12T20:00:00Z"), corr)
    expect(dropStatusLine(d[0])).toBe("Draw requests close Fri 9 AM PT")
    applyDropCorrections(d, new Date("2026-11-14T00:00:00Z"), corr)
    expect(d[0].status).toBe("ended")
  })
  it("every shipped correction names its source and date", () => {
    for (const c of DROP_CORRECTIONS) {
      expect(c.source.length, c.dist_id).toBeGreaterThan(0)
      expect(c.verified_at, c.dist_id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})
