import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripSqlComments } from "../scripts/lib/strip-sql-comments.mjs"

// Boards that rank Top Shot COLLECTORS from public.topshot_ownership must exclude Top Shot's own
// accounts, resolved through the registry public.flowty_excluded_addresses (never a literal list).
//
// 2026-10-20: Dapper's pack-distribution account 0xb6f2481eba4df97b (22,718 Moments, zero lifetime
// buys or sells) was rank 1 on 39 of the 61 2025-rookie "Top Collectors" boards, and system accounts
// appeared on all 61; the edition "Top Owners" panel counted them as collectors too. Fixed in
// 20261020222700. This guard keeps a re-created board from dropping the predicate.
//
// POPULATION: the newest definition of each collector-RANKING object below. Holdings readers that are
// not boards (writers, the walker, coverage notes) live in
// topshot-ownership-holdings-readers-filter-walk-missed.test.ts and are not collector rankings.

const MIG = join(process.cwd(), "supabase/migrations")
const files = readdirSync(MIG).filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort()

function newestBody(start: RegExp, end: (sql: string, at: number) => number): { file: string; body: string } {
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = stripSqlComments(readFileSync(join(MIG, files[i]), "utf8"))
    const at = sql.search(start)
    if (at >= 0) return { file: files[i], body: sql.slice(at, end(sql, at)) }
  }
  throw new Error(`no migration defines ${start}`)
}

const REGISTRY = /\bflowty_excluded_addresses\b/
const LITERAL_SYSTEM_ADDRESS = /0xb6f2481eba4df97b|0xe1f2a091f7bb5245|0x4d2c9216f1dca098/i

describe("Top Shot collector boards exclude Top Shot's own accounts", () => {
  it("topshot_rookie_collector_leaderboard_mv (newest definition) excludes the registry", () => {
    const { file, body } = newestBody(
      /CREATE MATERIALIZED VIEW public\.topshot_rookie_collector_leaderboard_mv\b/,
      (sql, at) => sql.indexOf(";", at),
    )
    expect(body, file).toMatch(REGISTRY)
    expect(body, file).not.toMatch(LITERAL_SYSTEM_ADDRESS)
  })

  it("get_edition_top_owners (newest definition) excludes the registry", () => {
    const { file, body } = newestBody(
      /CREATE (?:OR REPLACE )?FUNCTION public\.get_edition_top_owners\(/,
      (sql, at) => sql.indexOf("$function$;", at),
    )
    expect(body, file).toMatch(REGISTRY)
    expect(body, file).not.toMatch(LITERAL_SYSTEM_ADDRESS)
  })

  it("refresh_topshot_edition_concentration_v2 (newest definition) splits system holdings by the registry", () => {
    const { file, body } = newestBody(
      /CREATE (?:OR REPLACE )?FUNCTION public\.refresh_topshot_edition_concentration_v2\(/,
      (sql, at) => sql.indexOf("$function$;", at),
    )
    expect(body, file).toMatch(REGISTRY)
    expect(body, file).not.toMatch(LITERAL_SYSTEM_ADDRESS)
  })

  it("the guard fails on the real MV body with the predicate removed (planted defect)", () => {
    const { body } = newestBody(
      /CREATE MATERIALIZED VIEW public\.topshot_rookie_collector_leaderboard_mv\b/,
      (sql, at) => sql.indexOf(";", at),
    )
    const planted = body.replace(/AND NOT EXISTS \(SELECT 1 FROM flowty_excluded_addresses[^)]*\)/, "")
    expect(planted).not.toBe(body)
    expect(planted).not.toMatch(REGISTRY)
  })
})
