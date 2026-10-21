import { describe, it, expect } from "vitest"
import { migrationFiles } from "./helpers/migration-defs"
import { stripSqlComments } from "../scripts/lib/strip-sql-comments.mjs"

// `check_edge_fn_http_failures()` (read by get_pipeline_alerts) attributes a pg_net 4xx to its lane
// by joining net._http_response.id to the table where that lane recorded its dispatch id. A 4xx it
// cannot join files as `pg_net_http_<code>` — CRITICAL for a 403. Dapper's Atlas host
// (api.production.atlas.dapperlabs.com) sits behind Cloudflare, which challenges this egress at a
// ~5–15 % base rate, so EVERY Atlas lane produces 403s in normal operation. An Atlas lane the arm
// was never taught therefore pages a false CRITICAL on its first challenge. That happened four times:
// usernames (20261002150259), the two supply lanes (20261004015738), and the autograph sweep
// (20261021024211, 10-20: 41 of 41 "unknown" 403s in 6 h were its pages).
//
// POPULATION (a tree walk, not a list): every table created in supabase/migrations with a
// `request_id` / `req_id` bigint column whose WRITERS (an INSERT INTO / UPDATE of it in some
// migration) live in a migration that also names the Atlas host. Each must be joined by the arm
// (`JOIN public.<table> <alias> ON <alias>.request_id = r.id` in a migration that touches
// check_edge_fn_http_failures), or carry a reason in SUPPRESSED.

const ATLAS_HOST = /api\.production\.atlas\.dapperlabs\.com/
const ARM = /check_edge_fn_http_failures/

const SUPPRESSED: Record<string, string> = {}

function lanes() {
  const files = migrationFiles().map((f) => ({ ...f, code: stripSqlComments(f.src) as string }))
  const tables = new Set<string>()
  for (const { code } of files) {
    for (const m of code.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?\s*\(([\s\S]*?)\n\s*\)\s*;/gi)) {
      if (/\b(?:request_id|req_id)\s+bigint/i.test(m[2])) tables.add(m[1].toLowerCase())
    }
    for (const m of code.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?([a-z0-9_]+)"?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:request_id|req_id)\b/gi)) {
      tables.add(m[1].toLowerCase())
    }
  }
  // the arm's join text lives inside string literals of the splice migrations, so read RAW source
  const armSrc = files.filter((f) => ARM.test(f.src)).map((f) => f.src).join("\n")
  const out: Array<{ table: string; atlas: boolean; attributed: boolean }> = []
  for (const t of [...tables].sort()) {
    const writes = new RegExp(`\\b(?:INSERT\\s+INTO|UPDATE)\\s+(?:public\\.)?${t}\\b`, "i")
    const atlas = files.some((f) => writes.test(f.code) && ATLAS_HOST.test(f.src))
    const join = new RegExp(`JOIN\\s+public\\.${t}\\s+(\\w+)\\s+ON\\s+\\1\\.(?:request_id|req_id)\\s*=\\s*r\\.id`, "i")
    out.push({ table: t, atlas, attributed: join.test(armSrc) })
  }
  return out
}

describe("every Atlas pg_net lane is attributed by the 4xx alert arm", () => {
  const all = lanes()
  const atlas = all.filter((l) => l.atlas)

  it("inspects a real population", () => {
    // 10-20: 20+ request-id tables; 7 Atlas lanes (editions, market, usernames, supply, pack supply,
    // autograph, challenges). A walk that collapsed would pass the ban vacuously.
    expect(all.length).toBeGreaterThanOrEqual(20)
    expect(atlas.length).toBeGreaterThanOrEqual(7)
    for (const known of ["atlas_edition_requests", "topshot_atlas_market_requests", "autograph_sweep_requests"]) {
      expect(atlas.map((l) => l.table), known).toContain(known)
    }
  })

  it("POSITIVE CONTROL — the attribution test sees the joins that exist", () => {
    expect(all.find((l) => l.table === "atlas_edition_requests")?.attributed).toBe(true)
    expect(all.find((l) => l.table === "autograph_sweep_requests")?.attributed).toBe(true)
  })

  it("BAN: no Atlas lane outside the arm and outside the curated suppressions", () => {
    const offenders = atlas.filter((l) => !l.attributed && !(l.table in SUPPRESSED)).map((l) => l.table)
    expect(offenders, "teach check_edge_fn_http_failures this lane (see 20261021024211 for the splice)").toEqual([])
  })

  it("every suppression still names an unattributed Atlas lane (no stale entries)", () => {
    const live = new Set(atlas.filter((l) => !l.attributed).map((l) => l.table))
    expect(Object.keys(SUPPRESSED).filter((t) => !live.has(t))).toEqual([])
  })
})
