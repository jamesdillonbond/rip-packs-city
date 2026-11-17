import { describe, it, expect } from "vitest"
import {
  reachableFloor,
  sporkFloorOf,
  isTransient,
  cdcField,
  cdcPrim,
  type SporkConfig,
} from "@/supabase/functions/_shared/spork-cursor"

// First unit tests for the edge-function (Deno) layer's pure backfill-walk math,
// extracted to a shared module. These pin the exact behavior whose absence
// caused the 2026-07-11 spork-floor 404 loop (a window below the reachable floor
// retried forever and never advanced the cursor).

// Live AllDay constants (mirror ingest-allday-pack-opens).
const CFG: SporkConfig = {
  currentSporkMin: 137390146,
  sporkFloor: 27341470,
  sporkMaxHeights: [
    31735954, 35858810, 40171633, 44950206, 47169686, 55114466,
    65264618, 85981134, 88226266, 130290658, 137390145,
  ],
  sporkAvailable: true,
}
const CFG_NO_PROXY: SporkConfig = { ...CFG, sporkAvailable: false }
const ALLDAY_GENESIS_FLOOR = 35000000

describe("reachableFloor — the backfill must terminate, not 404-loop below the floor", () => {
  it("clamps a below-floor request UP to the spork floor when the proxy is wired", () => {
    expect(reachableFloor(20_000_000, CFG)).toBe(CFG.sporkFloor)
    // Nothing below the spork floor is recoverable, so the walk stops there.
    expect(reachableFloor(0, CFG)).toBe(CFG.sporkFloor)
  })

  it("leaves an above-floor request (e.g. the AllDay genesis target) unchanged", () => {
    expect(reachableFloor(ALLDAY_GENESIS_FLOOR, CFG)).toBe(ALLDAY_GENESIS_FLOOR)
  })

  it("clamps to the CURRENT spork root when no spork proxy is available", () => {
    // Without the proxy only rest-mainnet (current spork) is reachable.
    expect(reachableFloor(ALLDAY_GENESIS_FLOOR, CFG_NO_PROXY)).toBe(CFG.currentSporkMin)
    expect(reachableFloor(200_000_000, CFG_NO_PROXY)).toBe(200_000_000)
  })
})

describe("sporkFloorOf — a scan window never crosses a spork boundary", () => {
  it("returns the current-spork root for any block at or above it", () => {
    expect(sporkFloorOf(CFG.currentSporkMin, CFG)).toBe(CFG.currentSporkMin)
    expect(sporkFloorOf(200_000_000, CFG)).toBe(CFG.currentSporkMin)
  })

  it("maps a height into the spork whose upper bound contains it", () => {
    // 30M ≤ first max (31_735_954) → floor is the genesis sporkFloor.
    expect(sporkFloorOf(30_000_000, CFG)).toBe(CFG.sporkFloor)
    // 33M is above max[0] but ≤ max[1] (35_858_810) → floor = max[0] + 1.
    expect(sporkFloorOf(33_000_000, CFG)).toBe(31_735_954 + 1)
  })

  it("puts a block exactly at a spork's upper bound in that spork (inclusive)", () => {
    expect(sporkFloorOf(31_735_954, CFG)).toBe(CFG.sporkFloor)
    // One above rolls into the next spork.
    expect(sporkFloorOf(31_735_955, CFG)).toBe(31_735_954 + 1)
  })

  it("returns the last spork's floor for a height just under the current-spork root", () => {
    expect(sporkFloorOf(137_390_145, CFG)).toBe(130_290_658 + 1)
  })
})

describe("isTransient — retry vs skip decision that keeps the cursor moving", () => {
  it.each([0, 429, 500, 502, 503])("treats %s as transient (retry the window)", (s) => {
    expect(isTransient(s)).toBe(true)
  })

  it.each([400, 401, 403, 404])("treats %s as permanent (skip the window, advance)", (s) => {
    expect(isTransient(s)).toBe(false)
  })
})

describe("cdcField / cdcPrim — Cadence event unwrap", () => {
  const event = {
    value: {
      fields: [
        { name: "id", value: { type: "UInt64", value: "12345" } },
        { name: "to", value: { type: "Optional", value: { type: "Address", value: "0xbuyer" } } },
        { name: "missing", value: { type: "Optional", value: null } },
      ],
    },
  }

  it("extracts a plain typed primitive", () => {
    expect(cdcPrim(cdcField(event, "id"))).toBe("12345")
  })

  it("unwraps an Optional-wrapped address to the inner primitive", () => {
    expect(cdcPrim(cdcField(event, "to"))).toBe("0xbuyer")
  })

  it("returns null for an empty Optional and for an absent field", () => {
    expect(cdcPrim(cdcField(event, "missing"))).toBeNull()
    expect(cdcPrim(cdcField(event, "nope"))).toBeNull()
  })
})
