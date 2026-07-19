import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

// The supabase/tests/*.sql DB-invariant tests embed a VERBATIM copy of the
// function-under-test's DDL so they run self-contained on a vanilla Postgres
// (no full-schema apply). That copy is only meaningful if it stays identical to
// the committed migration — otherwise the DB tests would validate stale logic.
// This guard extracts the function's DDL from both the SQL test file and its
// source migration, normalizes whitespace, and asserts they match. It needs no
// database, so it runs in the ordinary (blocking) unit-tests job even though the
// DB tests themselves run in the separate, initially-non-blocking db-tests job.

const root = process.cwd()

const PINS = [
  {
    fn: "_norm_player",
    test: "supabase/tests/norm_player.sql",
    migration: "supabase/migrations/20260713031000_audit_20260713_resolve_challenge_slots.sql",
  },
  {
    fn: "fmv_snapshots_block_phantoms",
    test: "supabase/tests/fmv_block_phantoms.sql",
    migration: "supabase/migrations/20260711185416_audit_20260711_fmv_snapshots_rename_wap_to_asp.sql",
  },
  {
    fn: "expire_ended_challenges",
    test: "supabase/tests/expire_ended_challenges.sql",
    migration: "supabase/migrations/20260716151708_audit_20260716_expire_ended_challenges.sql",
  },
]

/**
 * Extract a `CREATE OR REPLACE FUNCTION public.<name> ... $tag$ ... $tag$;` block
 * (dollar-quoted body, tag auto-detected) and normalize its whitespace.
 */
function extractSqlFn(src: string, name: string): string | null {
  const start = src.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`)
  if (start < 0) return null
  const rest = src.slice(start)
  const tagMatch = /\$([a-zA-Z_]*)\$/.exec(rest)
  if (!tagMatch) return null
  const tag = tagMatch[0] // "$$" or "$function$"
  const bodyOpen = tagMatch.index + tag.length
  const closeRel = rest.indexOf(tag, bodyOpen)
  if (closeRel < 0) return null
  const semi = rest.indexOf(";", closeRel + tag.length)
  if (semi < 0) return null
  return rest.slice(0, semi + 1).replace(/\s+/g, " ").trim()
}

describe("DB-invariant drift guard — embedded DDL must equal the committed migration", () => {
  it.each(PINS)("$fn: the SQL test's copy is byte-identical (normalized) to its migration", ({ fn, test, migration }) => {
    const testSrc = readFileSync(path.join(root, test), "utf8")
    const migSrc = readFileSync(path.join(root, migration), "utf8")

    const embedded = extractSqlFn(testSrc, fn)
    const committed = extractSqlFn(migSrc, fn)

    expect(embedded, `${fn} not found in ${test}`).not.toBeNull()
    expect(committed, `${fn} not found in ${migration}`).not.toBeNull()
    expect(embedded).toBe(committed)
  })
})
