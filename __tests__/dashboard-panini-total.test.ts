import { describe, expect, it } from "vitest"
import { paniniCaption, sumPaniniIdentities } from "@/lib/dashboard/panini-total"
import { paniniValueByDay, sumNewestPaniniDays } from "@/lib/panini/linked-value"

// Trevor, 2026-11-25: Panini "should be" in Portfolio FMV.
describe("sumPaniniIdentities (dashboard)", () => {
  it("sums each username's recorded day; a username with no day adds its profile count and $0", () => {
    expect(sumPaniniIdentities([
      { summary: { profile: { cards_held: 150, value: { cards: 148, fmv_usd: 812.4 } } } },
      { summary: { profile: { cards_held: 20, value: null } } },
      { summary: { profile: { cards_held: 5, value: { cards: 5, fmv_usd: null } } } },
      { summary: null },
    ])).toEqual({ cards: 173, fmvUsd: 812.4, usernames: 4 })
  })
  it("not read yet and failed both add nothing; only a failure is said", () => {
    expect(sumPaniniIdentities(undefined)).toEqual({ cards: 0, fmvUsd: 0, usernames: 0 })
    expect(sumPaniniIdentities(null)).toEqual({ cards: 0, fmvUsd: 0, usernames: 0 })
    expect(paniniCaption(null)).toMatch(/couldn't load/)
    expect(paniniCaption(undefined)).toBeNull()
    expect(paniniCaption([])).toBeNull()
  })
})

describe("linked Panini value (server)", () => {
  const rows = [
    { username: "a", day: "2026-11-24", cards: 10, fmv_usd: "100" },
    { username: "a", day: "2026-11-25", cards: 11, fmv_usd: "120.50" },
    { username: "b", day: "2026-11-25", cards: 3, fmv_usd: null },
  ]
  it("newest day per username; an unrecorded username is counted apart, never $0 of value claimed", () => {
    expect(sumNewestPaniniDays(["a", "b", "c"], rows)).toEqual({ usernames: 3, unrecorded: 1, cards: 14, fmvUsd: 120.5, failed: false })
  })
  it("per-day sums for the value chart", () => {
    expect(Object.fromEntries(paniniValueByDay(rows))).toEqual({ "2026-11-24": 100, "2026-11-25": 120.5 })
  })
})
