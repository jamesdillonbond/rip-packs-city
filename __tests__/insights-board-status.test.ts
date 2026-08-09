import { describe, it, expect } from "vitest"
import { summarizeDegraded, boardStatus } from "@/lib/insights/board-status"

// Pins the honesty contract for the public /insights boards (added 2026-08-09).
// The defect this closes: a backing-view statement timeout was caught, turned into [],
// and rendered as an EMPTY section at HTTP 200 — indistinguishable from "nothing matched".

describe("summarizeDegraded", () => {
  it("returns null when every board loaded, so a healthy page renders no notice", () => {
    expect(
      summarizeDegraded([boardStatus("Market", true), boardStatus("Deals", true)])
    ).toBeNull()
  })

  it("returns null for an empty input (nothing was attempted)", () => {
    expect(summarizeDegraded([])).toBeNull()
  })

  // THE central distinction. A board that succeeded and returned zero rows is a real
  // answer; calling it degraded would be its own dishonesty. Only `ok: false` counts.
  it("does NOT treat a successful zero-row board as degraded", () => {
    // Callers pass ok=true regardless of row count; this pins that a caller doing so
    // gets no notice, i.e. emptiness alone never triggers the banner.
    expect(summarizeDegraded([boardStatus("Scarcity", true)])).toBeNull()
  })

  it("lists failed sections with the attempted total as the denominator", () => {
    const s = summarizeDegraded([
      boardStatus("Market", true),
      boardStatus("Scarcity", false),
      boardStatus("Players", false),
      boardStatus("Deals", true),
    ])
    expect(s).not.toBeNull()
    expect(s!.failed).toEqual(["Scarcity", "Players"])
    expect(s!.truncated).toEqual([])
    expect(s!.total).toBe(4)
    expect(s!.headline).toContain("2 of 4 sections could not be loaded")
    expect(s!.headline).toContain("Scarcity, Players")
  })

  // The load-bearing half of the copy: without it, a blank section still reads as data.
  it("always states the blank is a load failure, not an empty result", () => {
    const s = summarizeDegraded([boardStatus("Market", false)])
    expect(s!.headline).toContain("not an empty result")
    expect(s!.headline).toContain("unknown rather than zero")
  })

  it("reports a partial (truncated) board separately from an absent one", () => {
    const s = summarizeDegraded([
      { label: "Squeeze board", ok: false, partial: true },
      { label: "Deals", ok: false, partial: false },
    ])
    expect(s!.truncated).toEqual(["Squeeze board"])
    expect(s!.failed).toEqual(["Deals"])
    expect(s!.headline).toContain("1 of 2 sections could not be loaded (Deals)")
    expect(s!.headline).toContain("1 section is showing an incomplete slice (Squeeze board)")
  })

  it("pluralizes the truncated clause correctly", () => {
    const one = summarizeDegraded([{ label: "A", ok: false, partial: true }])
    expect(one!.headline).toContain("1 section is showing")

    const two = summarizeDegraded([
      { label: "A", ok: false, partial: true },
      { label: "B", ok: false, partial: true },
    ])
    expect(two!.headline).toContain("2 sections are showing")
  })

  // The candy-mlb case measured in production: six simultaneous timeouts on one render.
  it("handles the observed six-simultaneous-timeout candy-mlb render", () => {
    const s = summarizeDegraded([
      boardStatus("Market", true),
      boardStatus("Pack EV", false),
      boardStatus("Pack market", false),
      boardStatus("Deals", true),
      boardStatus("Offer spread", true),
      boardStatus("Serials", false),
      boardStatus("Scarcity", false),
      boardStatus("Holders", true),
      boardStatus("Players", false),
      boardStatus("Parallels", false),
    ])
    expect(s!.failed).toHaveLength(6)
    expect(s!.total).toBe(10)
    expect(s!.headline).toContain("6 of 10 sections could not be loaded")
  })

  it("boardStatus builds a non-paginated status with no partial flag", () => {
    expect(boardStatus("X", false)).toEqual({ label: "X", ok: false })
  })
})
