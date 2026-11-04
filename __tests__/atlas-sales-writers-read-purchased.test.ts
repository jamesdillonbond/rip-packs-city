import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { stripSqlComments } from "../scripts/lib/strip-sql-comments.mjs"

// ── A SALE FROM ATLAS IS A LISTING THAT WAS *PURCHASED*, NOT ONE THAT *COMPLETED* (2026-11-04) ──────────
// Atlas (`topshot_atlas_market_events`) marks a listing `completed` whenever it ENDS — sold, cancelled or
// repriced. Only `purchased` says it sold. `backfill_topshot_sales_from_atlas_events()` (20260909003000)
// read `kind = 'listing' AND completed` and never `purchased`, and wrote 4,361 + 1,036 Top Shot "sales"
// that were a seller repricing a listing ($463k that never traded; the Knueppel Signature 1/1 showed three
// sales in five days by the owner who still holds it). Controls: 400 real on-chain sales matched a
// purchased listing 182× and a cancelled one 5×; the backfill's rows 115× and 4,364×.
//
// Rule: a migration that INSERTs into `sales` AND reads `topshot_atlas_market_events` must say `purchased`
// in code (comments stripped; `purchased_at` does not count — it is set on a cancel too).
// Suppression (curated, each a claim the CODE was wrong and is no longer live):
const SUPPRESSED = new Map<string, string>([
  ["20260909003000_audit_20260909_recover_topshot_sales_already_captured_in_atlas_events.sql",
   "the defect itself; its rows backed up 20261104224945 / 20261104233041, its function dropped by the staged delete"],
])

const DIR = join(process.cwd(), "supabase/migrations")
const READS_ATLAS = /topshot_atlas_market_events/
const WRITES_SALES = /insert\s+into\s+(public\.)?sales\b/i
const SAYS_PURCHASED = /\bpurchased\b/

function violates(sql: string): boolean {
  const code = stripSqlComments(sql)
  return READS_ATLAS.test(code) && WRITES_SALES.test(code) && !SAYS_PURCHASED.test(code)
}

describe("every migration that writes sales from Atlas events reads `purchased`", () => {
  it("the matcher catches the defect and passes the fix (planted)", () => {
    const bad = `INSERT INTO public.sales (id) SELECT gen_random_uuid() FROM public.topshot_atlas_market_events ev
                 WHERE ev.kind = 'listing' AND ev.completed IS TRUE AND ev.purchased_at IS NOT NULL;`
    expect(violates(bad)).toBe(true)
    expect(violates(bad.replace("ev.completed IS TRUE", "ev.purchased"))).toBe(false)
    // a comment naming the flag is not a filter on it
    expect(violates(`-- requires purchased\n${bad}`)).toBe(true)
    // a reader that writes nothing to sales is out of scope
    expect(violates(`SELECT 1 FROM public.topshot_atlas_market_events WHERE completed;`)).toBe(false)
  })

  it("BAN AT ZERO across supabase/migrations (suppressions listed above)", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".sql"))
    expect(files.length).toBeGreaterThan(1000)
    let inspected = 0
    const hits: string[] = []
    for (const f of files) {
      const sql = readFileSync(join(DIR, f), "utf8")
      const code = stripSqlComments(sql)
      if (READS_ATLAS.test(code) && WRITES_SALES.test(code)) inspected++
      if (violates(sql) && !SUPPRESSED.has(f)) hits.push(f)
    }
    // the population this guard is about: 3 correct writers + the suppressed defect, as of 2026-11-04
    expect(inspected).toBeGreaterThanOrEqual(4)
    expect(hits, "an Atlas-fed sales writer must filter on `purchased`, never `completed` alone").toEqual([])
  })

  it("every suppression still names a file that exists and still violates (a stale suppression is a false claim)", () => {
    const files = new Set(readdirSync(DIR))
    for (const f of SUPPRESSED.keys()) {
      expect(files.has(f), f).toBe(true)
      expect(violates(readFileSync(join(DIR, f), "utf8")), f).toBe(true)
    }
  })
})
