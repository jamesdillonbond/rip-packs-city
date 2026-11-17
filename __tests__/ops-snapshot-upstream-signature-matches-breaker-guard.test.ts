import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

import { CLOUDFLARE_ORIGIN_DOWN } from "@/lib/pipeline/upstream-breaker"

// ── rpc_ops_snapshot's upstream classifier must not drift from the breaker's ──
//
// WHY THIS EXISTS
// `rpc_ops_snapshot()` splits its 24 h failure buckets into `fails` and
// `upstream`, where `upstream` is the subset of failures caused by the Top Shot
// / Dapper Cloudflare origin being down. That classification decides the ORDER
// an operator reads the failure list in, so a signature that stops matching
// does not fail loudly — it silently re-buries the pipelines that are actually
// broken underneath one upstream outage, which is the exact defect the
// migration was written to remove.
//
// SQL cannot import `CLOUDFLARE_ORIGIN_DOWN`, so the pattern is a hand-copy.
// This guard is the thing that makes the copy safe: change either side and CI
// fails HERE, naming the other side, instead of the readout quietly rotting.
//
// ⚠ It is a REPO-vs-REPO check, and it says nothing about production. A
// definition applied via MCP and never committed would satisfy this file while
// the live function ran something else — that gap belongs to
// scripts/check-db-pin-staleness.mjs. What this guard adds on top of plain
// equality is the NEWEST-DEFINITION rule below: it resolves the migration by
// walking every file that redefines the function and taking the last one, so a
// later migration that drops the classifier fails here rather than being
// checked against a superseded file it does not govern.

const root = process.cwd()
const MIGRATIONS = path.join(root, "supabase", "migrations")
const FN = "CREATE OR REPLACE FUNCTION public.rpc_ops_snapshot"

/** Every migration that redefines rpc_ops_snapshot, oldest first (filenames sort chronologically). */
function migrationsDefiningOpsSnapshot(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => readFileSync(path.join(MIGRATIONS, f), "utf8").includes(FN))
}

/**
 * The regex literal inside the `error ~* '...'` FILTER of the pipeline_fails_24h
 * bucket. Anchored on `~*` rather than on the alternation text, so a guard that
 * found nothing cannot be mistaken for a guard that found a match.
 *
 * ⚠ It requires EXACTLY ONE occurrence and returns null otherwise, rather than
 * taking the first. SQL comments are not stripped here — deliberately, because
 * a stripper is itself a thing that can go blind — so a header comment that
 * quoted the pattern would otherwise be read INSTEAD of the code. Two matches
 * is a failure, not a coin flip.
 */
function sqlUpstreamPattern(sql: string): string | null {
  const all = [...sql.matchAll(/error\s*~\*\s*'([^']+)'/g)]
  return all.length === 1 ? all[0][1] : null
}

describe("rpc_ops_snapshot's upstream signature matches lib/pipeline/upstream-breaker", () => {
  const defining = migrationsDefiningOpsSnapshot()

  it("finds the migrations that define the function (non-vacuous)", () => {
    expect(defining.length).toBeGreaterThan(0)
  })

  it("the NEWEST definition still classifies upstream failures", () => {
    const newest = defining[defining.length - 1]
    const sql = readFileSync(path.join(MIGRATIONS, newest), "utf8")
    // The classifier is what makes the bucket readable; a redefinition that drops
    // it is a silent regression, so it is asserted on the newest file, not on a
    // named one.
    expect(sql, `${newest} redefines rpc_ops_snapshot without the 'upstream' bucket`).toContain(
      "'upstream', z.u",
    )
    expect(sqlUpstreamPattern(sql), `${newest} has no error ~* '...' filter`).not.toBeNull()
  })

  it("the SQL copy is character-identical to CLOUDFLARE_ORIGIN_DOWN's source", () => {
    const newest = defining[defining.length - 1]
    const sql = readFileSync(path.join(MIGRATIONS, newest), "utf8")
    const sqlPattern = sqlUpstreamPattern(sql)

    // `.source` drops the delimiters and the `i` flag; the SQL side gets its
    // case-insensitivity from the `~*` operator, so the two bodies must match
    // exactly. Any real token change — a new spelling added to one side, a
    // narrowed alternative — separates them here.
    expect(sqlPattern).toBe(CLOUDFLARE_ORIGIN_DOWN.source)
  })

  it("the pattern is a multi-spelling alternation, not a bare 530", () => {
    // The two ways this signature can fail are opposite and both silent: too
    // narrow and a real outage is filed as our own failure; a bare `530` and one
    // of OUR failures whose message happens to contain a row count is filed as
    // someone else's outage. Pin the shape so neither can be introduced quietly.
    const alternatives = CLOUDFLARE_ORIGIN_DOWN.source.replace(/^\(|\)$/g, "").split("|")
    expect(alternatives.length).toBeGreaterThanOrEqual(4)
    expect(CLOUDFLARE_ORIGIN_DOWN.source).not.toBe("530")
    expect(CLOUDFLARE_ORIGIN_DOWN.test("wrote 530 rows")).toBe(false)
    expect(CLOUDFLARE_ORIGIN_DOWN.test("Top Shot GraphQL failed with 530.")).toBe(true)
  })
})
