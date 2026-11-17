import { describe, it, expect } from "vitest"
import { buildEditionOfferRows, upsertBatchesByShape, type OfferAcc } from "@/lib/offers/edition-offer-rows"

// known-issues "Merge upserts fed by a degraded read" (d): offers-sweep sent
// set_uuid/play_uuid = null for a GQL row lacking set.id/play.id, and the
// ON CONFLICT DO UPDATE overwrote a stored UUID. A value the sweep could not
// READ must be ABSENT from the payload its batch sends.
describe("offers-sweep edition_offers rows: an unread UUID is omitted, never sent as NULL", () => {
  const NOW = "2026-11-03T18:30:00.000Z"
  const acc: OfferAcc = new Map([
    ["1:1", { offer: 5, ask: 9, setUuid: "set-a", playUuid: "play-a" }],
    ["1:2", { offer: 4, ask: null, setUuid: null, playUuid: null }],
    ["1:3", { offer: null, ask: 7, setUuid: "set-c", playUuid: null }],
    ["1:4", { offer: null, ask: null, setUuid: "set-d", playUuid: "play-d" }],
  ])

  it("drops a row with neither offer nor ask, and omits (does not null) a missing UUID", () => {
    const rows = buildEditionOfferRows(acc, "col", NOW)
    expect(rows.map((r) => r.external_id)).toEqual(["1:1", "1:2", "1:3"])
    const r2 = rows.find((r) => r.external_id === "1:2")!
    expect("set_uuid" in r2).toBe(false)
    expect("play_uuid" in r2).toBe(false)
    const r3 = rows.find((r) => r.external_id === "1:3")!
    expect(r3.set_uuid).toBe("set-c")
    expect("play_uuid" in r3).toBe(false)
    // A measured absence of an offer IS written as null (the edition was read).
    expect(r2.low_ask).toBeNull()
  })

  it("no batch mixes shapes — so no batch's column union can carry a NULL UUID for a row that lacked one", () => {
    const rows = buildEditionOfferRows(acc, "col", NOW)
    const batches = upsertBatchesByShape(rows, 500)
    expect(batches.flat()).toHaveLength(rows.length)
    for (const b of batches) {
      const shapes = new Set(b.map((r) => Object.keys(r).sort().join(",")))
      expect(shapes.size).toBe(1)
      for (const r of b) {
        for (const k of ["set_uuid", "play_uuid"] as const) {
          if (k in r) expect((r as Record<string, unknown>)[k]).not.toBeNull()
        }
      }
    }
  })

  it("still splits a single shape into size-bounded batches", () => {
    const big: OfferAcc = new Map(
      Array.from({ length: 7 }, (_, i) => [`9:${i}`, { offer: 1, ask: 1, setUuid: "s", playUuid: "p" }] as const)
    )
    const batches = upsertBatchesByShape(buildEditionOfferRows(big, "col", NOW), 3)
    expect(batches.map((b) => b.length)).toEqual([3, 3, 1])
  })
})
