import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

// Boards that group Top Shot holdings by resolve_canonical_owner() must DISPLAY
// the member that holds the moments, never the canonical Flow Wallet parent.
//
// 2026-09-29: after linked_accounts grew 217 -> 1,319 rows, 903 named collectors
// resolved to parents with no Top Shot username. The edition Top Owners panel
// showed LincolnCannon's 306 moments as 0x75c0ecb6ebc02f9c, and the rookie board
// would have dropped from 1,516 to 988 named top-25 rows at its next refresh.

const MIG = join(process.cwd(), "supabase/migrations")
const files = readdirSync(MIG).filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort()

function newest(re: RegExp): { file: string; sql: string } {
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = readFileSync(join(MIG, files[i]), "utf8")
    if (re.test(sql)) return { file: files[i], sql }
  }
  throw new Error(`no migration matches ${re}`)
}

// The displayed column must come from a group MEMBER, not the grouping key.
function displaysMember(body: string, col: string): boolean {
  const code = body.replace(/--[^\n]*/g, "")
  const showsCanon = new RegExp(`\\bcanon\\s+AS\\s+${col}\\b|resolve_canonical_owner\\([^)]*\\)\\s+AS\\s+${col}\\b`, "i").test(code)
  const showsMember = new RegExp(`\\bmember\\s+AS\\s+${col}\\b`, "i").test(code)
  return showsMember && !showsCanon
}

describe("linked owner groups show the holding member, not the Flow Wallet parent", () => {
  it("get_edition_top_owners (newest definition) displays a member as owner_address", () => {
    const { file, sql } = newest(/CREATE OR REPLACE (FUNCTION|PROCEDURE) public\.get_edition_top_owners\(/)
    const body = sql.slice(sql.search(/CREATE OR REPLACE (FUNCTION|PROCEDURE) public\.get_edition_top_owners\(/))
    expect(displaysMember(body.slice(0, body.indexOf("$function$;")), "owner_address"), file).toBe(true)
  })

  it("topshot_rookie_collector_leaderboard_mv (newest definition) displays a member as wallet_address", () => {
    const { file, sql } = newest(/CREATE MATERIALIZED VIEW public\.topshot_rookie_collector_leaderboard_mv\b/)
    const at = sql.search(/CREATE MATERIALIZED VIEW public\.topshot_rookie_collector_leaderboard_mv\b/)
    const body = sql.slice(at, sql.indexOf(";", at))
    expect(displaysMember(body, "wallet_address"), file).toBe(true)
  })

  it("the MV keeps the unique index its CONCURRENTLY refresh needs", () => {
    const { sql } = newest(/CREATE MATERIALIZED VIEW public\.topshot_rookie_collector_leaderboard_mv\b/)
    expect(sql).toMatch(/CREATE UNIQUE INDEX \w+ ON public\.topshot_rookie_collector_leaderboard_mv USING btree \(player_name, wallet_address\)/)
  })

  it("control: the check FAILS on the pre-2026-09-29 shapes", () => {
    const oldFn = `SELECT public.resolve_canonical_owner(owner_address) AS canon, serial_number FROM x
      SELECT a.canon AS owner_address, a.moments AS moment_count FROM agg a`
    const oldMv = `SELECT ev.player_name, resolve_canonical_owner(o.owner_address) AS wallet_address, ev.unit_fmv`
    expect(displaysMember(oldFn, "owner_address")).toBe(false)
    expect(displaysMember(oldMv, "wallet_address")).toBe(false)
  })
})
