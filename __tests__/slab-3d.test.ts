import { describe, it, expect } from "vitest"
import {
  slabEnabled,
  normalizeDeg,
  showingBack,
  nearestRest,
  flipTarget,
  tiltFromOrientation,
  finishFromBadges,
} from "@/lib/slab-3d"

describe("slabEnabled", () => {
  it("is on for everyone when the viewer said nothing and no kill switch is set", () => {
    expect(slabEnabled({ envDefault: undefined, queryValue: null, storedValue: null })).toBe(true)
    expect(slabEnabled({ envDefault: "", queryValue: null, storedValue: null })).toBe(true)
    expect(slabEnabled({ envDefault: "1", queryValue: null, storedValue: null })).toBe(true)
  })
  it("turns off for everyone with the kill switch NEXT_PUBLIC_MOMENT_SLAB_3D=0", () => {
    expect(slabEnabled({ envDefault: "0", queryValue: null, storedValue: null })).toBe(false)
  })
  it("lets a viewer turn it off with ?slab=0 and remembers that", () => {
    expect(slabEnabled({ envDefault: undefined, queryValue: "0", storedValue: null })).toBe(false)
    expect(slabEnabled({ envDefault: undefined, queryValue: null, storedValue: "0" })).toBe(false)
    expect(slabEnabled({ envDefault: undefined, queryValue: "0", storedValue: "1" })).toBe(false)
  })
  it("lets a viewer's own ?slab=1 beat the kill switch", () => {
    expect(slabEnabled({ envDefault: "0", queryValue: "1", storedValue: null })).toBe(true)
    expect(slabEnabled({ envDefault: "0", queryValue: null, storedValue: "1" })).toBe(true)
    expect(slabEnabled({ envDefault: undefined, queryValue: "1", storedValue: "0" })).toBe(true)
  })
})

describe("slab angles", () => {
  it("folds any angle into [0, 360)", () => {
    expect(normalizeDeg(-90)).toBe(270)
    expect(normalizeDeg(720)).toBe(0)
    expect(normalizeDeg(Number.NaN)).toBe(0)
  })
  it("reports the back only between 90 and 270 degrees, in either spin direction", () => {
    expect(showingBack(0)).toBe(false)
    expect(showingBack(89)).toBe(false)
    expect(showingBack(180)).toBe(true)
    expect(showingBack(-180)).toBe(true)
    expect(showingBack(-540)).toBe(true)
    expect(showingBack(360)).toBe(false)
  })
  it("always settles on a face, never edge-on", () => {
    expect(nearestRest(80)).toBe(0)
    expect(nearestRest(100)).toBe(180)
    expect(nearestRest(-260)).toBe(-180)
    expect(nearestRest(Number.POSITIVE_INFINITY)).toBe(0)
  })
  it("flips one face from wherever it rests", () => {
    expect(flipTarget(0)).toBe(180)
    expect(flipTarget(180)).toBe(360)
    expect(flipTarget(10, -1)).toBe(-180)
  })
})

describe("tiltFromOrientation", () => {
  const base = { beta: 40, gamma: 0 }
  it("is flat in the pose tilt was switched on in", () => {
    const t = tiltFromOrientation(40, 0, base)
    expect(Math.abs(t.x)).toBe(0)
    expect(Math.abs(t.y)).toBe(0)
  })
  it("is clamped so a phone turned sideways cannot flip the slab", () => {
    const t = tiltFromOrientation(170, 90, base)
    expect(Math.abs(t.x)).toBeLessThanOrEqual(18)
    expect(Math.abs(t.y)).toBeLessThanOrEqual(18)
  })
  it("returns flat for a missing reading", () => {
    expect(tiltFromOrientation(null, 10, base)).toEqual({ x: 0, y: 0 })
  })
})

describe("finishFromBadges", () => {
  it("ranks #1 over jersey over perfect", () => {
    expect(finishFromBadges(["perfect_mint", "jersey_match", "first_serial"])).toBe("first")
    expect(finishFromBadges(["perfect_mint", "jersey_match"])).toBe("jersey")
    expect(finishFromBadges(["perfect_mint"])).toBe("perfect")
  })
  it("gives no finish to an ordinary serial or an unknown badge", () => {
    expect(finishFromBadges([])).toBe(null)
    expect(finishFromBadges(["constructor"])).toBe(null)
  })
})
