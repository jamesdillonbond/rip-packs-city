import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { stripSqlComments } from "../scripts/lib/strip-sql-comments.mjs"

// ─────────────────────────────────────────────────────────────────────────────
// BAN AT ZERO (new migrations only): a migration that takes a table-level lock on an
// EXISTING table — CREATE / DROP TRIGGER, or ALTER TABLE — must set `lock_timeout`.
//
// ⚠ THIS EXISTS BECAUSE IT HAPPENED THREE TIMES ON 2026-11-27, AND EVERY GUARD WAS GREEN.
// `20261127164214`, `20261127184110` and `20261127213224` each ran `DROP TRIGGER IF EXISTS …
// ON public.fmv_snapshots` + `CREATE TRIGGER`, inside the ONE transaction `apply_migration`
// wraps the whole file in. `DROP TRIGGER` takes ACCESS EXCLUSIVE on the table (on a
// partitioned table, on every partition) — even when the trigger does not exist — and the
// lock is held until COMMIT, i.e. through every statement after it (a re-stamp, a backup,
// function bodies). Postgres logs at 18:41:10Z: dozens of `still waiting for AccessShareLock
// on relation 18563` (= fmv_snapshots) for 1–8 s each, then `canceling statement due to
// statement timeout`. Vercel at the same seconds: 74 `[edition] get_edition_detail error …
// statement timeout` in 24 h across 31 users, in bursts at 16:42, 18:41 and 21:32 UTC —
// the three apply times — on every collection's edition page at once.
//
// Nothing else sees this: tsc / vitest / lint check text, migration-parity checks presence,
// the parse check runs on an EMPTY database where no reader is waiting.
//
// WHAT THIS ASKS: `SET lock_timeout` (or `SET LOCAL lock_timeout`) in the file, so the DDL
// gives up in seconds instead of queueing every reader behind it — and, per database.md,
// put the lock-taking DDL LAST (or in its own migration) so the lock is held for
// milliseconds, not for the rest of the file. The second half is a review rule, not
// asserted here: "last" has too many legitimate shapes to check by regex.
//
// POPULATION: every migration newer than CUTOFF (files before it are history and were
// applied; rewriting them would not change production). A table CREATEd in the same file
// is exempt — nobody can be reading a table that did not exist before the transaction.
// Satisfiable at zero: an empty population passes.
// ─────────────────────────────────────────────────────────────────────────────

const MIG_DIR = path.join(__dirname, "..", "supabase", "migrations")
const CUTOFF = "20261127223054" // the newest migration when this guard landed

const LOCK_DDL = [
  /\bDROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?[a-z0-9_"]+\s+ON\s+(?:ONLY\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi,
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+[a-z0-9_"]+\s+(?:BEFORE|AFTER|INSTEAD\s+OF)\b[\s\S]*?\bON\s+(?:ONLY\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi,
  /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi,
]
const CREATED = /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi

/** Existing tables this SQL takes a table lock on, with no lock_timeout set. */
function lockedTablesWithoutTimeout(src: string): string[] {
  const code = stripSqlComments(src)
  if (/\block_timeout\b/i.test(code)) return []
  const created = new Set([...code.matchAll(CREATED)].map((m) => m[1].toLowerCase()))
  const hit = new Set<string>()
  for (const re of LOCK_DDL) {
    for (const m of code.matchAll(re)) {
      const t = m[1].toLowerCase()
      if (!created.has(t)) hit.add(t)
    }
  }
  return [...hit].sort()
}

function newMigrations() {
  return fs
    .readdirSync(MIG_DIR)
    .filter((f) => /^\d{14}_.*\.sql$/.test(f) && f.slice(0, 14) > CUTOFF)
    .sort()
}

describe("a migration that locks an existing table sets lock_timeout", () => {
  it("finds the DROP TRIGGER shape that took fmv_snapshots on 11-27 (planted defect)", () => {
    const planted = `
      DROP TRIGGER IF EXISTS fmv_snapshots_tier_cap_topshot_unsold_trg ON public.fmv_snapshots;
      CREATE TRIGGER fmv_snapshots_tier_cap_topshot_unsold_trg
        BEFORE INSERT ON public.fmv_snapshots
        FOR EACH ROW EXECUTE FUNCTION public.fmv_snapshots_tier_cap_topshot_unsold();`
    expect(lockedTablesWithoutTimeout(planted)).toEqual(["fmv_snapshots"])
    expect(lockedTablesWithoutTimeout("ALTER TABLE public.sales ADD COLUMN x int;")).toEqual(["sales"])
  })

  it("flags the real 11-27 migration that caused the 18:41 UTC burst (positive control on a real file)", () => {
    const real = fs.readdirSync(MIG_DIR).find((f) => f.startsWith("20261127184110_"))
    expect(real).toBeTruthy()
    expect(lockedTablesWithoutTimeout(fs.readFileSync(path.join(MIG_DIR, real as string), "utf8"))).toContain(
      "fmv_snapshots",
    )
  })

  it("accepts the same DDL with lock_timeout, and a table created in the same file", () => {
    expect(
      lockedTablesWithoutTimeout(
        "SET LOCAL lock_timeout = '3s';\nDROP TRIGGER IF EXISTS t ON public.fmv_snapshots;",
      ),
    ).toEqual([])
    expect(
      lockedTablesWithoutTimeout(
        "CREATE TABLE IF NOT EXISTS public.x (a int);\nALTER TABLE public.x ENABLE ROW LEVEL SECURITY;",
      ),
    ).toEqual([])
    // a comment naming the setting is not the setting
    expect(
      lockedTablesWithoutTimeout("-- remember lock_timeout\nALTER TABLE public.editions ADD COLUMN y int;"),
    ).toEqual(["editions"])
  })

  it("every migration newer than the cutoff complies", () => {
    const files = newMigrations()
    const offenders = files
      .map((f) => ({ f, tables: lockedTablesWithoutTimeout(fs.readFileSync(path.join(MIG_DIR, f), "utf8")) }))
      .filter((x) => x.tables.length > 0)
      .map((x) => `${x.f}: ${x.tables.join(", ")}`)
    expect(
      offenders,
      `add SET LOCAL lock_timeout = '3s' and put the lock-taking DDL last (docs/reference/database.md, ` +
        `"lock-taking DDL"); inspected ${files.length} migration(s) newer than ${CUTOFF}`,
    ).toEqual([])
  })
})
