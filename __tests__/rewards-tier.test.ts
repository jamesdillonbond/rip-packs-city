import { describe, it, expect } from "vitest"
import { TIERS, tierProgress, tierNameForStatus } from "@/lib/rewards-tier"

describe("tierProgress", () => {
  it("places status 0 in Rookie with a Role Player next", () => {
    const p = tierProgress(0)
    expect(p.current.name).toBe("Rookie")
    expect(p.next?.name).toBe("Role Player")
    expect(p.pct).toBe(0)
    expect(p.toNext).toBe(500)
  })

  it("computes the % into the current tier and points to next", () => {
    // 250 of the 0→500 span = 50%
    const p = tierProgress(250)
    expect(p.current.name).toBe("Rookie")
    expect(p.pct).toBe(50)
    expect(p.toNext).toBe(250)
  })

  it("clamps at the boundary — exactly at a tier min advances into that tier", () => {
    const p = tierProgress(500)
    expect(p.current.name).toBe("Role Player")
    expect(p.next?.name).toBe("Starter")
    expect(p.pct).toBe(0)
    expect(p.toNext).toBe(2000)
  })

  it("returns 100% / no next at the top tier (Franchise)", () => {
    const p = tierProgress(50000)
    expect(p.current.name).toBe("Franchise")
    expect(p.next).toBeNull()
    expect(p.pct).toBe(100)
    expect(p.toNext).toBe(0)
  })

  it("never yields a pct outside 0–100 or a negative toNext for mid-tier values", () => {
    for (const s of [1, 499, 501, 2499, 9999, 10001, 29999]) {
      const p = tierProgress(s)
      expect(p.pct).toBeGreaterThanOrEqual(0)
      expect(p.pct).toBeLessThanOrEqual(100)
      expect(p.toNext).toBeGreaterThanOrEqual(0)
    }
  })

  it("picks the correct tier for an All-Star-range value", () => {
    const p = tierProgress(15000)
    expect(p.current.name).toBe("All-Star")
    expect(p.next?.name).toBe("Franchise")
    // 5000 of the 10000→30000 span (20000) = 25%
    expect(p.pct).toBe(25)
    expect(p.toNext).toBe(15000)
  })
})

describe("tierNameForStatus", () => {
  it("maps each tier min to its own name", () => {
    expect(tierNameForStatus(0)).toBe("Rookie")
    expect(tierNameForStatus(500)).toBe("Role Player")
    expect(tierNameForStatus(2500)).toBe("Starter")
    expect(tierNameForStatus(10000)).toBe("All-Star")
    expect(tierNameForStatus(30000)).toBe("Franchise")
  })

  it("resolves an in-between value to the lower tier's name", () => {
    expect(tierNameForStatus(499)).toBe("Rookie")
    expect(tierNameForStatus(2499)).toBe("Role Player")
    expect(tierNameForStatus(999999)).toBe("Franchise")
  })

  it("TIERS is ordered ascending by min", () => {
    for (let i = 1; i < TIERS.length; i++) {
      expect(TIERS[i].min).toBeGreaterThan(TIERS[i - 1].min)
    }
  })
})
