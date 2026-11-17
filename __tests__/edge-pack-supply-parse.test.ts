import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  parseTopshotEditionEdges,
  buildTopshotPoolPayload,
  buildAllDaySupplyRows,
} from "@/supabase/functions/_shared/pack-supply-parse"
import { summarizeMatchRun } from "@/supabase/functions/_shared/match-run-summary"

// Unit tests for the pure pack-supply / match-run primitives that back three
// otherwise-zero-coverage edge functions (backfill-topshot-pack-supply,
// backfill-allday-pack-supply, match-topshot-players), PLUS a source-drift guard
// that pins each edge fn to still carry the load-bearing expression (they keep
// the logic inline rather than importing this module, to avoid a redeploy).

const root = process.cwd()

describe("parseTopshotEditionEdges", () => {
  it("keeps only edges with both set.flowId and play.flowID; coerces count", () => {
    const edges = [
      { node: { count: 5, edition: { set: { flowId: 10 }, play: { flowID: 20 } } } },
      { node: { count: "7", edition: { set: { flowId: 3 }, play: { flowID: 4 } } } },
      { node: { count: 9, edition: { set: { flowId: 1 }, play: null } } },     // missing play -> dropped
      { node: { count: 9, edition: { set: null, play: { flowID: 4 } } } },     // missing set -> dropped
      { node: { count: 1, edition: null } },                                    // no edition -> dropped
    ]
    expect(parseTopshotEditionEdges(edges)).toEqual([
      { ext: "10:20", count: 5 },
      { ext: "3:4", count: 7 },
    ])
  })
  it("null/empty edges -> []", () => {
    expect(parseTopshotEditionEdges(null)).toEqual([])
    expect(parseTopshotEditionEdges([])).toEqual([])
  })
  it("missing count defaults to 0 (not NaN)", () => {
    expect(parseTopshotEditionEdges([{ node: { edition: { set: { flowId: 1 }, play: { flowID: 2 } } } }])).toEqual([
      { ext: "1:2", count: 0 },
    ])
  })
})

describe("buildTopshotPoolPayload", () => {
  const opts = (idByExt: Map<string, string>) => ({ collectionId: "TS", distId: "d1", idByExt, nowIso: "2026-07-29T00:00:00.000Z" })

  it("aggregates counts per ext across pages and normalizes drop_weight to a fractional share", () => {
    const eds = [
      { ext: "1:2", count: 60 },
      { ext: "1:2", count: 40 }, // same ext on a later page -> 100 total
      { ext: "3:4", count: 100 },
    ]
    const idByExt = new Map([["1:2", "e12"], ["3:4", "e34"]])
    const rows = buildTopshotPoolPayload(eds, opts(idByExt))
    expect(rows).toHaveLength(2)
    const r12 = rows.find(r => r.edition_flow_id === "1:2")!
    expect(r12.drop_weight).toBe(0.5)       // 100 / 200 — NOT the raw 100
    expect(r12.orig_drop_weight).toBe(100)  // raw count preserved
    expect(r12.edition_id).toBe("e12")
    expect(r12.slot_name).toBe("default")
    expect(r12.pool_source).toBe("gql_historical")
    expect(r12.last_refreshed_at).toBe("2026-07-29T00:00:00.000Z")
  })

  it("drop_weight never exceeds 1 even for a large single-edition pool (numeric(8,6) overflow guard)", () => {
    const rows = buildTopshotPoolPayload([{ ext: "9:9", count: 5000 }], opts(new Map([["9:9", "e99"]])))
    expect(rows[0].drop_weight).toBe(1)      // 5000/5000, not 5000
    expect(rows[0].orig_drop_weight).toBe(5000)
  })

  it("drops exts with no resolvable edition id", () => {
    const eds = [{ ext: "1:2", count: 10 }, { ext: "7:7", count: 10 }]
    const rows = buildTopshotPoolPayload(eds, opts(new Map([["1:2", "e12"]])))
    expect(rows.map(r => r.edition_flow_id)).toEqual(["1:2"])
  })

  it("empty input -> [] (and never divides by zero)", () => {
    expect(buildTopshotPoolPayload([], opts(new Map()))).toEqual([])
  })
})

describe("buildAllDaySupplyRows", () => {
  it("dedupes by dist_id keeping the LAST node and maps the fields", () => {
    const nodes = [
      { id: 100, title: "Old", totalSupply: 500, availableSupply: 500, numberOfPackSlots: 5, price: { value: 10 }, packOdds: [{ tier: "COMMON" }], editionIds: ["e1"] },
      { id: 100, title: "New", totalSupply: 600, availableSupply: 600, numberOfPackSlots: 5, price: { value: 12 }, packOdds: [{ tier: "RARE" }], editionIds: ["e2"] },
      { id: 200, title: "B", totalSupply: 300, availableSupply: 300, numberOfPackSlots: 3, price: null, packOdds: null, editionIds: null },
    ]
    const rows = buildAllDaySupplyRows(nodes, "2026-07-29T00:00:00.000Z")
    expect(rows).toHaveLength(2) // dist 100 deduped
    const r100 = rows.find(r => r.dist_id === "100")!
    expect(r100.title).toBe("New")           // keep-last
    expect(r100.total_minted).toBe(600)      // from totalSupply
    expect(r100.pack_price).toBe(12)
    const r200 = rows.find(r => r.dist_id === "200")!
    expect(r200.pack_price).toBeNull()       // price null -> null (not NaN)
    expect(r200.pack_odds).toBeNull()
    expect(r200.edition_ids).toBeNull()
  })
  it("non-array packOdds/editionIds become null, never a bogus object", () => {
    const rows = buildAllDaySupplyRows([{ id: 1, totalSupply: 1, packOdds: { bogus: true }, editionIds: "x" }], "now")
    expect(rows[0].pack_odds).toBeNull()
    expect(rows[0].edition_ids).toBeNull()
  })
  it("skips null nodes; null/empty input -> []", () => {
    expect(buildAllDaySupplyRows([null as any, { id: 5, totalSupply: 2 }], "now")).toHaveLength(1)
    expect(buildAllDaySupplyRows(null, "now")).toEqual([])
  })
})

describe("summarizeMatchRun", () => {
  it("rows_found = skipped + total_unresolved; rows_written = auto_aliased", () => {
    const c = summarizeMatchRun({ skipped: 3, auto_aliased: 4, total_unresolved: 10, needs_review: [{ name: "x" }] })
    expect(c.rowsFound).toBe(13)   // NOT the 4 aliased
    expect(c.rowsWritten).toBe(4)
    expect(c.rowsSkipped).toBe(3)
    expect(c.needsReviewCount).toBe(1)
  })
  it("caps needs_manual_review at 200 while reporting the true count", () => {
    const big = Array.from({ length: 250 }, (_, i) => ({ i }))
    const c = summarizeMatchRun({ needs_review: big })
    expect(c.needsReviewCount).toBe(250)
    expect(c.needsManualReview).toHaveLength(200)
  })
  it("null/absent fields default to 0 / [] (never NaN)", () => {
    const c = summarizeMatchRun(null)
    expect(c).toMatchObject({ rowsFound: 0, rowsWritten: 0, rowsSkipped: 0, needsReviewCount: 0 })
    expect(c.needsManualReview).toEqual([])
  })
})

// ── Source-drift guard ───────────────────────────────────────────────────────
// The edge fns keep this logic inline (no import from _shared, to avoid a
// redeploy). Pin them to still carry the load-bearing expressions so a change to
// the supply math there fails CI until this tested module + its tests are updated
// in lockstep. Whitespace-insensitive substring match.
function squish(s: string): string {
  return s.replace(/\s+/g, "")
}
const EDGE_EXPECTATIONS: Array<{ fn: string; needles: string[] }> = [
  {
    fn: "backfill-topshot-pack-supply",
    needles: [
      "`${setF}:${playF}`",
      "(count / totalCount).toFixed(6)",
      "orig_drop_weight: count",
      'slot_name: "default"',
      'pool_source: "gql_historical"',
    ],
  },
  {
    fn: "backfill-allday-pack-supply",
    needles: [
      "byDist.set(String(n.id)",
      "total_minted: minted",
      "Array.isArray(n.packOdds)",
      'onConflict: "dist_id"',
    ],
  },
  {
    fn: "match-topshot-players",
    needles: ["skipped + totalUnresolved", "needsReview.slice(0, 200)"],
  },
]

describe("pack-supply / match edge fns keep their inline logic in sync with _shared", () => {
  for (const { fn, needles } of EDGE_EXPECTATIONS) {
    const src = readFileSync(path.join(root, `supabase/functions/${fn}/index.ts`), "utf8")
    const squished = squish(src)
    for (const needle of needles) {
      it(`${fn} still contains: ${needle}`, () => {
        expect(squished, `${fn} drifted — update supabase/functions/_shared/pack-supply-parse.ts + this test`).toContain(squish(needle))
      })
    }
  }
})
