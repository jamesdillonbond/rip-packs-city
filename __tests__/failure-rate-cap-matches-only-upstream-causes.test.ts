// __tests__/failure-rate-cap-matches-only-upstream-causes.test.ts
//
// The failure_rate arm of get_pipeline_alerts_core caps a `high` row at `medium`
// when the lane's newest error names an UPSTREAM cause nobody here can fix:
// Dapper Studio 530 / Cloudflare 1033 (20261119014903) and, since
// 20261119171500, an Atlas Cloudflare challenge that exhausted every retry
// (compute-pinnacle-pack-ev paged `high` on one such run, 11-19).
//
// The cap is a REGEX in SQL, so a widened pattern silently stops paging on
// causes that ARE ours. This reads the pattern out of the newest migration and
// pins both sides: the upstream strings it must match, and the strings that must
// keep paging — above all a Supabase `<!DOCTYPE html>` 522, which is Cloudflare
// reporting OUR database unreachable (CLAUDE.md).
//
// Postgres `~*` (ARE) and JS RegExp agree on everything this pattern uses
// (`\s`, `[^0-9]`, `$`, alternation), so the JS compile is a faithful model.

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const MIGRATION = join(
  process.cwd(),
  "supabase/migrations/20261119171500_audit_20261119_failure_rate_arm_caps_an_atlas_cloudflare_challenge_at_medium.sql",
)

function capPattern(): RegExp {
  const sql = readFileSync(MIGRATION, "utf8")
  // n1 is the NEW severity fragment: `... ~* '<pattern>'\n THEN 'medium'`
  const n1 = sql.match(/n1 text := \$new\$[\s\S]*?~\* '([^']+)'\s*THEN 'medium'\$new\$/)
  if (!n1) throw new Error("could not find the n1 cap pattern in the migration")
  return new RegExp(n1[1], "i")
}

describe("failure_rate cap matches only upstream causes", () => {
  const re = capPattern()

  it.each([
    "atlas: SearchDistributions: HTTP 403 (cloudflare challenge) after 4 attempt(s) (page 0, offset 0)",
    "gql: HTTP 530",
    "floor phase: floor GQL 530",
    "error code: 1033",
    "2 gql chunk errors (first: GQL 530)",
  ])("caps (upstream): %s", (err) => {
    expect(re.test(err)).toBe(true)
  })

  it.each([
    '<!DOCTYPE html><html lang="en-US"><head><title>rippackscity | 522: Connection timed out</title>',
    "HTTP 522",
    "canceling statement due to statement timeout",
    "insert pack_ev_history: duplicate key value violates unique constraint",
    "GQL 5301 rows",
    "wrote 15300 rows",
    "atlas: SearchDistributions: HTTP 404 (not_found) after 1 attempt(s)",
  ])("keeps paging (ours, or not an upstream challenge): %s", (err) => {
    expect(re.test(err)).toBe(false)
  })
})
