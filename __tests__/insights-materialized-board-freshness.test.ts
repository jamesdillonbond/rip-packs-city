import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"

/**
 * Pins ONE property: a materialized board must never present the CURRENT TIME as the age
 * of its rows.
 *
 * WHY (2026-08-22). deals / panini-squeeze / first-mint moved from live-computed views to
 * materialized views. `fetched_at: new Date().toISOString()` had been honest for a live
 * view — the fetch computed the rows, so fetch time WAS data time — and it silently
 * stopped being honest behind an MV. `/insights/deals` renders that value as
 * "Updated <FreshnessStamp>", so the page claimed the board was current while the rows
 * could be a full refresh interval old, on a board whose whole subject is listings that
 * disappear.
 *
 * These assert the ABSENCE of the false claim (no now()-derived stamp, null instead),
 * not the presence of any particular error text.
 */

const state: { row: any; error: any; throws: boolean } = { row: null, error: null, throws: false }

vi.mock("@/lib/supabase", () => {
  const q: any = {
    select: () => q, eq: () => q, order: () => q, limit: () => q,
    maybeSingle: async () => {
      if (state.throws) throw new Error("pool timeout")
      return { data: state.row, error: state.error }
    },
  }
  const admin: any = { from: () => q }
  return { supabaseAdmin: admin, supabase: admin }
})

import { readMvAsOf, MV_PIPELINE } from "@/lib/insights/mv-freshness"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

beforeEach(() => { state.row = null; state.error = null; state.throws = false })

describe("readMvAsOf", () => {
  it("returns the MV's real refresh time when it can read one", async () => {
    state.row = { started_at: "2026-08-22T22:12:00.000Z" }
    expect(await readMvAsOf("deals")).toBe("2026-08-22T22:12:00.000Z")
  })

  for (const [label, setup] of [
    ["the read errors", () => { state.error = { message: "boom" } }],
    ["the read throws", () => { state.throws = true }],
    ["no row exists (refresh never ran / aged out of retention)", () => { state.row = null }],
    ["the value is not a string", () => { state.row = { started_at: 12345 } }],
    ["the value is an unparseable date", () => { state.row = { started_at: "not-a-date" } }],
  ] as const) {
    it(`returns NULL — never a timestamp — when ${label}`, async () => {
      setup()
      const got = await readMvAsOf("deals")
      // The property: null, and specifically NOT something near "now". A now() fallback
      // would be indistinguishable from a healthy board at exactly the moment the refresh
      // pipeline is broken, which is when the board is MOST stale.
      expect(got).toBeNull()
    })
  }

  it("never yields a value within a second of now on any failure path", async () => {
    // A stronger form of the same property, stated as the thing a reader would be misled
    // by, so a future `?? new Date().toISOString()` reintroduction reddens here even if
    // someone changes the null convention.
    for (const setup of [
      () => { state.error = { message: "x" } },
      () => { state.throws = true },
      () => { state.row = null },
    ]) {
      setup()
      const got = await readMvAsOf("panini-squeeze")
      if (got !== null) {
        expect(Math.abs(Date.now() - new Date(got).getTime())).toBeGreaterThan(1000)
      }
    }
  })

  it("maps every materialized board to the pipeline its refresh function actually writes", () => {
    // These strings are the contract with the audit_20260822_* migrations. A rename on
    // either side silently turns every stamp into "—", which is honest but useless.
    expect(MV_PIPELINE).toEqual({
      deals: "cross-collection-deals-mv",
      "panini-squeeze": "panini-squeeze-mv",
      "first-mint": "topshot-first-mint-mv",
    })
  })
})

describe("no materialized board page fabricates a freshness stamp", () => {
  // Ban at population zero: this passes when the offending pattern is absent, so it does
  // not punish its own success, and it fails the moment someone re-adds the coalesce.
  const PAGES = [
    "app/insights/deals/page.tsx",
    "app/insights/panini-squeeze/page.tsx",
  ]
  for (const p of PAGES) {
    it(`${p} does not coalesce a missing timestamp to new Date()`, () => {
      // Strip comments first — this repo has fired at least six guards on the
      // comment that documents the fix rather than on live code.
      //
      // ⚠ Uses the ONE shared stripper. A local copy of this exact shape was
      // measured BLIND on 2026-08-22: the block regex runs first, so an ordinary
      // line comment mentioning a glob path opens a block comment that closes at
      // the next `*/` ANYWHERE in the file — 103,590 chars hidden across 49
      // product files, and it concealed a live P0.
      const src = stripComments(readFileSync(p, "utf8"))
      expect(src).not.toMatch(/\?\?\s*new Date\(\)/)
    })
  }
})
