import { describe, it, expect } from "vitest"
import { pinnacleSetsForCallout, loadPinnacleCalloutSets } from "@/lib/collection/pinnacle-sets-callout"
import { nearCompleteSets } from "@/lib/collection/filter-options"
import { nearCompleteCostLabel } from "@/components/collection/PortfolioSummary"

// The Collection tab's "Close to completing" callout on Disney Pinnacle (2026-10-26).
describe("pinnacleSetsForCallout", () => {
  const set = { setId: "s1", setName: " Star Wars Alphabet Vol.1 ", missingCount: 3, completionPct: 88, listedCount: 1, totalMissingCost: 4 }

  it("maps listedCount to unpricedMissingCount, so a partial cost reads as a lower bound", () => {
    const [m] = pinnacleSetsForCallout([set])
    expect(m.unpricedMissingCount).toBe(2)
    expect(nearCompleteCostLabel(m)).toBe(" · ≥ $4.00 (2 unpriced)")
  })
  it("a stale floor map (null cost) reads 'unpriced', never $0.00", () => {
    const [m] = pinnacleSetsForCallout([{ ...set, totalMissingCost: null }])
    expect(nearCompleteCostLabel(m)).toBe(" · unpriced")
  })
  it("feeds the shared near-complete filter (1–3 missing, ≥ 50 %)", () => {
    const out = nearCompleteSets(pinnacleSetsForCallout([set, { ...set, setId: "s2", missingCount: 9 }]))
    expect(out.map((s) => s.setId)).toEqual(["s1"])
    expect(out[0].setName).toBe("Star Wars Alphabet Vol.1")
  })
})

describe("loadPinnacleCalloutSets", () => {
  it("a failed read is null (no callout), never an empty 'nothing close'", async () => {
    const out = await loadPinnacleCalloutSets("0x1", (async () => ({ ok: false, json: null })) as never)
    expect(out).toBeNull()
  })
  it("a 200 without a sets array is treated as a failure too", async () => {
    const out = await loadPinnacleCalloutSets("0x1", (async () => ({ ok: true, json: { error: "x" } })) as never)
    expect(out).toBeNull()
  })
  it("maps a good response and asks the Pinnacle tracker for that wallet", async () => {
    let url = ""
    const out = await loadPinnacleCalloutSets("0xab cd", (async (u: string) => {
      url = u
      return { ok: true, json: { sets: [{ setId: "s1", setName: "A", missingCount: 1, completionPct: 90, listedCount: 1, totalMissingCost: 2 }] } }
    }) as never)
    expect(url).toBe("/api/pinnacle-set-progress?wallet=0xab%20cd")
    expect(out?.sets[0]).toMatchObject({ setId: "s1", unpricedMissingCount: 0, totalMissingCost: 2 })
  })
})
