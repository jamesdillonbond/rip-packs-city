import { describe, it, expect } from "vitest"
import { fmvDayDelta, sortNotableSerials } from "@/lib/edition-detail-format"

// Pins the two pure derivations lifted out of the edition detail page
// (app/(collections)/[collection]/edition/[slug]/page.tsx).

describe("fmvDayDelta", () => {
  it("returns null with fewer than two points", () => {
    expect(fmvDayDelta([])).toBeNull()
    expect(fmvDayDelta([{ fmv_usd: 10 }])).toBeNull()
  })
  it("computes percent change of the last point vs the prior", () => {
    expect(fmvDayDelta([{ fmv_usd: 100 }, { fmv_usd: 110 }])).toBeCloseTo(10)
    expect(fmvDayDelta([{ fmv_usd: 100 }, { fmv_usd: 80 }])).toBeCloseTo(-20)
  })
  it("uses only the last two points when more exist", () => {
    expect(fmvDayDelta([{ fmv_usd: 5 }, { fmv_usd: 100 }, { fmv_usd: 150 }])).toBeCloseTo(50)
  })
  it("returns null when the prior is zero (no divide-by-zero)", () => {
    expect(fmvDayDelta([{ fmv_usd: 0 }, { fmv_usd: 10 }])).toBeNull()
  })
  it("returns null when either endpoint is null", () => {
    expect(fmvDayDelta([{ fmv_usd: null }, { fmv_usd: 10 }])).toBeNull()
    expect(fmvDayDelta([{ fmv_usd: 10 }, { fmv_usd: null }])).toBeNull()
  })
  it("handles a negative move to a smaller positive base", () => {
    expect(fmvDayDelta([{ fmv_usd: 50 }, { fmv_usd: 25 }])).toBeCloseTo(-50)
  })
})

describe("sortNotableSerials", () => {
  const row = (tag: string, serial: number) => ({ tag, serial })
  it("orders by tag rank #1 → jersey → last_mint → other", () => {
    const out = sortNotableSerials([
      row("other", 5),
      row("last_mint", 5),
      row("jersey", 5),
      row("#1", 5),
    ])
    expect(out.map((r) => r.tag)).toEqual(["#1", "jersey", "last_mint", "other"])
  })
  it("breaks ties within a rank by ascending serial", () => {
    const out = sortNotableSerials([row("#1", 30), row("#1", 2), row("#1", 17)])
    expect(out.map((r) => r.serial)).toEqual([2, 17, 30])
  })
  it("treats every unknown tag as the lowest rank, still serial-sorted", () => {
    const out = sortNotableSerials([row("zzz", 9), row("aaa", 3), row("#1", 100)])
    expect(out.map((r) => r.tag)).toEqual(["#1", "aaa", "zzz"])
  })
  it("does not mutate the input array", () => {
    const input = [row("other", 2), row("#1", 1)]
    const copy = [...input]
    sortNotableSerials(input)
    expect(input).toEqual(copy)
  })
  it("preserves extra row fields", () => {
    const out = sortNotableSerials([
      { tag: "other", serial: 2, holder_address: "0xB" },
      { tag: "#1", serial: 1, holder_address: "0xA" },
    ])
    expect(out[0]).toMatchObject({ tag: "#1", holder_address: "0xA" })
  })
})
