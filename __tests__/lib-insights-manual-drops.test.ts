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
  // 2026-11-15: the WNBA Finals drop was announced on Top Shot's blog days before the pack book listed it.
  it("an announced pre-order reads 'pre-orders open' until it opens, then its close; the feed's own row replaces it", () => {
    const P: ManualDrop = { ...E, id: "m-case", title: "2026 WNBA Finals Case", kind: "rsvp", retail_usd: 1250, start_time: "2026-11-16T20:00:00Z", end_time: "2026-11-18T20:00:00Z", feed_match: "Finals Case" }
    const [up] = buildManualDrops(new Date("2026-11-15T18:00:00Z"), [P])
    expect(dropStatusLine(up)).toBe("Pre-orders open Mon 12 PM PT")
    const [open] = buildManualDrops(new Date("2026-11-17T18:00:00Z"), [P])
    expect(dropStatusLine(open)).toBe("Pre-orders close Wed 12 PM PT")
    const feedRow = { ...open, dist_id: "8940", title: "2026 WNBA Finals Case" }
    expect(buildManualDrops(new Date("2026-11-17T18:00:00Z"), [P], [feedRow])).toEqual([])
    // another collection's row with the same words does not hide it
    expect(buildManualDrops(new Date("2026-11-17T18:00:00Z"), [P], [{ ...feedRow, collection: "nfl_all_day" }])).toHaveLength(1)
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
  // 2026-11-25: Walt Disney Mugs Vol.2 reached the calendar only as its Open Edition mints — no price, no close, and a
  // start at the custody pre-mint (11-15 2:24 PM PT) rather than the sale's 11/16 9 AM PT open.
  it("an Open Edition sold as capsules takes the official price, open and close", () => {
    const d = [base({ dist_id: "OEV2-WDMG", title: "Walt Disney Mugs Vol.2 (Open Edition)", kind: "open_edition", retail_usd: null, start_time: "2026-11-15T22:24:13Z", end_time: null, status: "open" })]
    applyDropCorrections(d, new Date("2026-11-25T15:00:00Z"))
    expect(d[0]).toMatchObject({ title: "Walt Disney Mugs Vol.2", kind: "capsule", retail_usd: 4.99, start_time: "2026-11-16T17:00:00.000Z", end_time: "2026-11-30T17:00:00.000Z", status: "open" })
    expect(dropStatusLine(d[0])).not.toMatch(/draw/i)
    applyDropCorrections(d, new Date("2026-11-30T18:00:00Z"))
    expect(d[0].status).toBe("ended")
  })
  it("a correction's price never overwrites a price the feed already carries", () => {
    const d = [base({ dist_id: "OEV2-WDMG", retail_usd: 9.99 })]
    applyDropCorrections(d, new Date("2026-11-25T15:00:00Z"))
    expect(d[0].retail_usd).toBe(9.99)
  })
  it("every shipped correction names its source and date", () => {
    for (const c of DROP_CORRECTIONS) {
      expect(c.source.length, c.dist_id).toBeGreaterThan(0)
      expect(c.verified_at, c.dist_id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})

// 2026-11-15: "On sale until Thu 8:59 PM PT" for a 12/31 close read as this Thursday.
import { whenPT } from "@/lib/insights/drops-board"
describe("whenPT names a far date, not just a weekday", () => {
  const now = Date.parse("2026-11-15T18:00:00Z")
  it("this week: weekday and time", () => expect(whenPT("2026-11-18T20:00:00Z", now)).toBe("Wed 12 PM PT"))
  it("next week: weekday, date and time", () => expect(whenPT("2026-11-23T17:00:00Z", now)).toBe("Mon 11/23 9 AM PT"))
  it("weeks out: the date only", () => expect(whenPT("2027-01-01T04:59:00Z", now)).toBe("Thu 12/31"))
})
