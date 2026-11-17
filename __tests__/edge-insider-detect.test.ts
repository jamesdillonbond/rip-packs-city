import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  computeInsiderAlerts,
  lowSerialThreshold,
  evidenceOverlaps,
  type InsiderBuyback,
} from "@/supabase/functions/_shared/insider-detect"

// Pins the pure pattern-detection core for topshot-insider-detect-patterns.
// A regression here emits FALSE insider alerts or SUPPRESSES real ones — both
// invisible from every external signal (the run still logs ok:true).

// NOTE: uses `in` (not `??`) so an explicit null override is honored — the
// whole point of several cases is a null player/serial/circulation.
function bb(over: Partial<InsiderBuyback> = {}): InsiderBuyback {
  return {
    id: "id" in over ? (over.id as string) : "b1",
    serial_number: "serial_number" in over ? (over.serial_number as number | null) : 500,
    sold_at: "sold_at" in over ? (over.sold_at as string) : "2026-07-26T00:00:00.000Z",
    player_name: "player_name" in over ? (over.player_name as string | null) : "LeBron James",
    set_name: "set_name" in over ? (over.set_name as string | null) : "Base Set",
    edition_circulation: "edition_circulation" in over ? (over.edition_circulation as number | null) : 2500,
  }
}

describe("lowSerialThreshold — bottom 5% with a floor of 5", () => {
  it("uses 5% of circulation once above the floor", () => {
    expect(lowSerialThreshold(2500)).toBe(125) // ceil(125)
    expect(lowSerialThreshold(1000)).toBe(50)
  })
  it("floors at 5 for tiny editions (so a #3 of 40 still flags)", () => {
    expect(lowSerialThreshold(40)).toBe(5) // ceil(2) -> max(5,2)=5
    expect(lowSerialThreshold(10)).toBe(5)
  })
  it("ceils, never rounds down (a #6 of 101 must flag: ceil(5.05)=6)", () => {
    expect(lowSerialThreshold(101)).toBe(6)
  })
})

describe("evidenceOverlaps — conservative dedup predicate", () => {
  it("is true when any id is shared with an existing evidence set", () => {
    expect(evidenceOverlaps([["a", "b"]], ["b", "c"])).toBe(true)
  })
  it("is false when disjoint", () => {
    expect(evidenceOverlaps([["a", "b"]], ["c", "d"])).toBe(false)
  })
  it("is false with no existing alerts", () => {
    expect(evidenceOverlaps([], ["a"])).toBe(false)
  })
})

describe("cluster_buyback — a player with 5+ buybacks in 24h", () => {
  it("does NOT fire at 4 buybacks", () => {
    const rows = Array.from({ length: 4 }, (_, i) => bb({ id: `p${i}` }))
    const { alerts } = computeInsiderAlerts(rows)
    expect(alerts.filter((a) => a.alert_type === "cluster_buyback")).toHaveLength(0)
  })
  it("fires at exactly 5 and sorts evidence", () => {
    const rows = Array.from({ length: 5 }, (_, i) => bb({ id: `p${5 - i}` })) // reverse order
    const { alerts } = computeInsiderAlerts(rows)
    const cluster = alerts.find((a) => a.alert_type === "cluster_buyback")!
    expect(cluster).toBeTruthy()
    expect(cluster.title).toContain("bought 5 LeBron James")
    expect(cluster.evidence).toEqual(["p1", "p2", "p3", "p4", "p5"]) // sorted
    expect(cluster.severity).toBe(3)
  })
  it("severity climbs 3 → 4 (7+) → 5 (10+)", () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => bb({ id: `x${i}` }))
    expect(computeInsiderAlerts(mk(6)).alerts[0].severity).toBe(3)
    expect(computeInsiderAlerts(mk(7)).alerts[0].severity).toBe(4)
    expect(computeInsiderAlerts(mk(10)).alerts[0].severity).toBe(5)
  })
  it("truncates the summary to 8 rows with an '…and N more' tail", () => {
    const rows = Array.from({ length: 12 }, (_, i) => bb({ id: `x${i}` }))
    const cluster = computeInsiderAlerts(rows).alerts.find((a) => a.alert_type === "cluster_buyback")!
    expect(cluster.summary).toContain("…and 4 more")
    expect(cluster.summary.split("\n").filter((l) => l.startsWith("•"))).toHaveLength(8)
  })
  it("ignores rows with no player_name", () => {
    const rows = Array.from({ length: 6 }, (_, i) => bb({ id: `x${i}`, player_name: null }))
    expect(computeInsiderAlerts(rows).alerts.filter((a) => a.alert_type === "cluster_buyback")).toHaveLength(0)
  })
  it("is deduped when an active alert already covers one of the ids", () => {
    const rows = Array.from({ length: 5 }, (_, i) => bb({ id: `p${i}` }))
    const { alerts } = computeInsiderAlerts(rows, { cluster_buyback: [["p2"]] })
    expect(alerts.filter((a) => a.alert_type === "cluster_buyback")).toHaveLength(0)
  })
})

describe("set_concentration — a set with 10+ buybacks in 24h", () => {
  it("does NOT fire at 9, fires at 10", () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => bb({ id: `s${i}`, player_name: `P${i % 3}`, set_name: "Hot Set" }))
    expect(computeInsiderAlerts(mk(9)).alerts.filter((a) => a.alert_type === "set_concentration")).toHaveLength(0)
    const at10 = computeInsiderAlerts(mk(10)).alerts.find((a) => a.alert_type === "set_concentration")!
    expect(at10).toBeTruthy()
    expect(at10.summary).toContain("across 3 player(s)")
    expect(at10.severity).toBe(3)
  })
  it("severity 4 at 15, 5 at 25", () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => bb({ id: `s${i}`, set_name: "Hot Set" }))
    expect(computeInsiderAlerts(mk(15)).alerts.find((a) => a.alert_type === "set_concentration")!.severity).toBe(4)
    expect(computeInsiderAlerts(mk(25)).alerts.find((a) => a.alert_type === "set_concentration")!.severity).toBe(5)
  })
})

describe("low_serial_buyback — bottom 5% of the edition", () => {
  it("fires for a serial at/under the threshold, not above", () => {
    const under = computeInsiderAlerts([bb({ id: "lo", serial_number: 100, edition_circulation: 2500 })])
    expect(under.alerts.find((a) => a.alert_type === "low_serial_buyback")).toBeTruthy()
    const over = computeInsiderAlerts([bb({ id: "hi", serial_number: 200, edition_circulation: 2500 })])
    expect(over.alerts.find((a) => a.alert_type === "low_serial_buyback")).toBeFalsy()
  })
  it("severity 5 for #1, 4 for <=10, else 3", () => {
    const sev = (s: number) =>
      computeInsiderAlerts([bb({ id: `n${s}`, serial_number: s, edition_circulation: 2500 })]).alerts.find(
        (a) => a.alert_type === "low_serial_buyback",
      )!.severity
    expect(sev(1)).toBe(5)
    expect(sev(9)).toBe(4)
    expect(sev(50)).toBe(3)
  })
  it("skips rows missing serial or circulation (never divides by zero)", () => {
    const rows = [
      bb({ id: "a", serial_number: null }),
      bb({ id: "b", edition_circulation: null }),
      bb({ id: "c", edition_circulation: 0 }),
    ]
    expect(computeInsiderAlerts(rows).alerts.filter((a) => a.alert_type === "low_serial_buyback")).toHaveLength(0)
  })
})

describe("edge-fn source-drift guard", () => {
  const src = readFileSync(
    path.join(process.cwd(), "supabase/functions/topshot-insider-detect-patterns/index.ts"),
    "utf8",
  )
  it("imports the shared detector (so the inline copy cannot silently diverge)", () => {
    expect(/from\s+["'][^"']*_shared\/insider-detect/.test(src)).toBe(true)
    expect(/computeInsiderAlerts/.test(src)).toBe(true)
  })
  it("no longer carries the old inline thresholds (rows.length < 5 / < 10)", () => {
    // The magic numbers now live only in the shared, tested module.
    expect(src.includes("rows.length < 5")).toBe(false)
    expect(src.includes("rows.length < 10")).toBe(false)
  })
})
