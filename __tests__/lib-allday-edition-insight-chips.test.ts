import { describe, it, expect, vi } from "vitest"

/**
 * All Day edition insight chips (All Day ↔ Top Shot parity, 2026-10-26). A chip appears only when its fact is true
 * of THIS edition; a failed read drops the chip, never renders a guessed figure.
 */

vi.mock("@/lib/api/bounded-read", () => ({ boundedRead: (p: Promise<unknown>) => p }))
import { allDayInsightChips, fetchAllDayScarcityRow } from "@/lib/allday/edition-insight-chips"

const row = (pct: number | null, family = 26) => ({ mint_count: 7, family_avg_mint: 10, family_size: family, scarcity_vs_family_pct: pct })

describe("allDayInsightChips", () => {
  it("scarcity chip only when scarcer than a family of 3+", () => {
    expect(allDayInsightChips({ scarcity: row(29.2), bid: null, floor: null, playerName: null }).map((c) => c.label)).toEqual(["29% scarcer than its set + tier →"])
    expect(allDayInsightChips({ scarcity: row(-1.2), bid: null, floor: null, playerName: null })).toEqual([])
    expect(allDayInsightChips({ scarcity: row(40, 2), bid: null, floor: null, playerName: null })).toEqual([])
    expect(allDayInsightChips({ scarcity: null, bid: null, floor: null, playerName: null })).toEqual([])
  })
  it("bid chip needs both a bid and a floor, and links the All Day board for the player", () => {
    const [c] = allDayInsightChips({ scarcity: null, bid: 300, floor: 260, playerName: "Saquon Barkley" })
    expect(c.label).toBe("Top bid 115% of floor →")
    expect(c.href).toBe("/insights/offer-spread?collection=nfl-all-day&player=Saquon+Barkley")
    expect(allDayInsightChips({ scarcity: null, bid: 0, floor: 260, playerName: null })).toEqual([])
    expect(allDayInsightChips({ scarcity: null, bid: 5, floor: null, playerName: null })).toEqual([])
  })
})

describe("fetchAllDayScarcityRow", () => {
  const db = (res: unknown) => ({ from: () => ({ select: () => ({ eq: () => ({ limit: () => Promise.resolve(res) }) }) }) })
  it("ok + row, ok + no row, and a failure that is not a row", async () => {
    expect((await fetchAllDayScarcityRow("4194", db({ data: [{ scarcity_vs_family_pct: "29.2", family_size: 26 }], error: null }))).row?.scarcity_vs_family_pct).toBe(29.2)
    expect(await fetchAllDayScarcityRow("x", db({ data: [], error: null }))).toEqual({ row: null, ok: true })
    expect(await fetchAllDayScarcityRow("x", db({ data: null, error: { message: "t" } }))).toEqual({ row: null, ok: false })
  })
})
