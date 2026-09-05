import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { stripSqlComments } from "../scripts/lib/strip-sql-comments.mjs"

// ─────────────────────────────────────────────────────────────────────────────
// Every NEW migration that creates a public table must ENABLE ROW LEVEL SECURITY
// for that table, in the same file.
//
// ⚠ THIS EXISTS BECAUSE IT HAPPENED, AT 06:18Z ON 2026-09-05, AND THE ONLY THING
// THAT CAUGHT IT WAS A DEPLOY. Two audit tables were created with a bare
// `CREATE TABLE IF NOT EXISTS` and landed with `relrowsecurity = false` AND `anon`
// holding SELECT. The GHA `smoke` check went red on
// `rpc:check_public_security_invariants` seven minutes later, naming both objects —
// the only red in ten consecutive smoke runs.
//
// ⭐ AND THE REASON A GUARD IS STILL WORTH HAVING, THOUGH A SELF-HEALER EXISTS:
// `public.selfheal_audit_table_rls()` (pg_cron jobid 232, `47 * * * *`) enables RLS
// and revokes anon on every `public.audit\_%` table hourly — which is why 10 older
// migrations create a table with no inline RLS and are compliant in production
// anyway. But it covers ONLY the `audit_` prefix, and only ONCE AN HOUR:
//   · a non-`audit_` table (`series_detail_rollup`, `profile_bio`,
//     `flow_backfill_progress`, `mv_pack_ev_latest_refresh_state`, …) is never healed
//     at all — nothing but the invariants check would ever notice;
//   · an `audit_` table created at :50 is anon-readable until :47 the next hour, and
//     a deploy inside that window reds CI, which is exactly what happened.
// This moves the catch from "a deploy happened to land in the gap" to review time,
// on the diff, where the author can still see why.
//
// The rule: a `CREATE [UNLOGGED] TABLE [IF NOT EXISTS] [public.]<name>` must be
// followed somewhere in the same file by
// `ALTER TABLE [public.]<name> ENABLE ROW LEVEL SECURITY`, or be explicitly opted
// out with the marker below. Both are a DECISION; silence is not.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations")

// Opt-out marker for a table that intentionally runs without RLS. It must also pass
// `check_public_security_invariants()` in production, or the DB will flag it
// regardless of what this file says — the two halves are independent on purpose.
const NO_RLS_OPT_OUT = "no-rls-table: intentional"

/**
 * ⚠ GRANDFATHERED — pre-existing files that create a public table without enabling
 * RLS for it in the same file. They are NOT re-litigated: an applied migration is
 * history, editing it cannot change production (it is never re-run), and the churn
 * carries a real chance of altering what the file would do if it ever WERE replayed.
 * The point of the guard is that this list STOPS GROWING.
 *
 * ⚠ EVERY TABLE BELOW WAS CHECKED LIVE (2026-09-05) rather than assumed safe,
 * because "it is old" is not evidence. All nine that still exist read
 * `relrowsecurity = true` in production:
 *   · audit_20260716_impossible_parallel_wave4   RLS on, anon revoked (healer)
 *   · audit_20260904_atlas_drain_prior_src       RLS on, anon revoked (healer)
 *   · audit_20260904_ultimate_1of1_editions_created  ┐ RLS on, anon revoked —
 *   · audit_20260904_wmc_ultimate_denorm_backup      ┘ FIXED FORWARD, see below
 *   · series_detail_rollup                       RLS on, anon SELECT revoked
 *   · mv_pack_ev_latest_refresh_state            RLS on, anon SELECT revoked
 *   · evm_nft_transfers_unresolved / _2026_05 / _2026_06   RLS on, anon SELECT (public read)
 *   · flow_backfill_progress                     RLS on, anon SELECT (public read)
 *   · pinnacle_ownership_snapshots               RLS on, anon SELECT (public read)
 *   · profile_bio                                RLS on, policy-governed
 *   · flowty_archive                             table no longer exists
 * `check_public_security_invariants()` returns 0 rows, which is the authority.
 */
const GRANDFATHERED = new Set([
  "20260404030000_flow_backfill_progress.sql",
  "20260419000000_pinnacle_ownership_snapshots.sql",
  "20260512190000_flowty_archive_api_harvest.sql",
  "20260513120000_evm_nft_indexer_schema.sql",
  "20260716235650_audit_20260716_circ_floor_raise_impossible_parallel_wave4.sql",
  "20260823030000_audit_20260823_series_detail_rollup.sql",
  "20260830222057_audit_20260830_mv_pack_ev_latest_refresh_watermark_gate.sql",
  // The two that motivated this guard. Fixed FORWARD by
  // 20260905062849_..._close_the_anon_readable_audit_tables_i_created_two_hours_ago.sql
  // (an ALTER + REVOKE), rather than by editing these applied files.
  "20260905024630_audit_20260904_atlas_drain_also_fills_the_prose_and_media_the_dead_catalog_walker_used_to_write.sql",
  "20260905061815_audit_20260904_sixteen_ultimate_one_of_one_editions_atlas_has_and_we_never_had_five_of_them_in_user_collections.sql",
  "20260905062040_audit_20260904_propagate_the_sixteen_new_ultimate_editions_into_the_holder_denorm_now_not_a_rotation_later.sql",
  "add_profile_bio_table.sql",
])

/**
 * Comments AND single-quoted string literals are stripped with the SHARED SQL
 * stripper (`scripts/lib/strip-sql-comments.mjs`).
 *
 * ⚠ BOTH HALVES ARE LOAD-BEARING, AND THE SECOND ONE IS WHY AN EARLIER DRAFT OF THIS
 * GUARD WAS WITHHELD RATHER THAN SHIPPED.
 *   · Comments: this repo has repeatedly been bitten by source guards that matched
 *     their own explanatory prose. This file's own header quotes `CREATE TABLE`.
 *   · String literals: several migrations build DDL dynamically inside `format(...)`.
 *     Scanning those reports a format TEMPLATE as a real declaration — and, because
 *     the name is a percent placeholder, the regex backtracks and reports a table
 *     literally called `publi`. An unvalidated guard is worse than no guard; that
 *     draft found 14 "offenders" of which 2 were parse artifacts, and a later
 *     revision found 98 of which 85 were temp tables.
 */
const stripCommentsAndLiterals = (sql: string): string =>
  stripSqlComments(sql, { blankStringLiterals: true })

/**
 * ⚠ TEMP tables are deliberately NOT matched. `CREATE TEMP TABLE _rwfc_recent …`
 * inside a function body is session-local, has no RLS surface and no anon grant;
 * requiring an ALTER for one would be noise. 85 of the 98 hits in an earlier
 * revision were exactly this.
 */
const CREATE_TABLE_RX =
  /CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi

function tableNames(sql: string): string[] {
  const out = new Set<string>()
  let m: RegExpExecArray | null
  CREATE_TABLE_RX.lastIndex = 0
  while ((m = CREATE_TABLE_RX.exec(sql)) !== null) out.add(m[1])
  return [...out]
}

function hasRlsEnabled(sql: string, table: string): boolean {
  const rx = new RegExp(
    `ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:public\\s*\\.\\s*)?"?${table}"?\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`,
    "i"
  )
  return rx.test(sql)
}

function migrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
}

describe("migrations must enable RLS on every public table they create", () => {
  it("the guard is not vacuous — it finds real CREATE TABLE statements to check", () => {
    const all = migrationFiles().flatMap((f) =>
      tableNames(stripCommentsAndLiterals(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")))
    )
    // 127 real statements as of 2026-09-05, across ~900 migration files.
    expect(all.length).toBeGreaterThan(100)
  })

  it("does not mistake dynamic format() DDL or a TEMP table for a public table", () => {
    // The two parse traps that kept an earlier draft of this guard unshipped.
    const dynamic = stripCommentsAndLiterals(
      `EXECUTE format('CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.x FOR VALUES FROM (%L) TO (%L)', a, b, c);`
    )
    expect(tableNames(dynamic)).toEqual([])

    const temp = stripCommentsAndLiterals(`CREATE TEMP TABLE _scratch ON COMMIT DROP AS SELECT 1;`)
    expect(tableNames(temp)).toEqual([])

    // …while a real one is still found, so the exclusions are not swallowing everything.
    expect(tableNames(`CREATE TABLE IF NOT EXISTS public.real_thing (id uuid);`)).toEqual([
      "real_thing",
    ])
  })

  it("every non-grandfathered CREATE TABLE enables RLS (or carries an explicit opt-out)", () => {
    const offenders: string[] = []

    for (const file of migrationFiles()) {
      if (GRANDFATHERED.has(file)) continue
      const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8")
      if (raw.includes(NO_RLS_OPT_OUT)) continue
      const sql = stripCommentsAndLiterals(raw)

      for (const table of tableNames(sql)) {
        if (!hasRlsEnabled(sql, table)) offenders.push(`${file} → CREATE TABLE public.${table}`)
      }
    }

    expect(
      offenders,
      `These migrations create a public table without enabling RLS for it.\n\n` +
        `Add, in the same file and keyed to this exact table:\n` +
        `  ALTER TABLE public.<name> ENABLE ROW LEVEL SECURITY;\n` +
        `  REVOKE ALL ON public.<name> FROM anon, authenticated;\n` +
        `  GRANT ALL ON public.<name> TO postgres, service_role;\n\n` +
        `A table created without this is anon-readable from the moment it exists.\n` +
        `selfheal_audit_table_rls() closes it hourly for the audit_ prefix ONLY —\n` +
        `a non-audit_ table is never healed, and an audit_ table is exposed until :47.\n` +
        `If the table intentionally runs without RLS, put the marker\n` +
        `"${NO_RLS_OPT_OUT}" in a comment AND make sure\n` +
        `check_public_security_invariants() still returns zero rows.\n\n` +
        offenders.map((o) => `  · ${o}`).join("\n")
    ).toEqual([])
  })

  it("the grandfather list only names files that exist, and does not grow silently", () => {
    const present = new Set(migrationFiles())
    for (const f of GRANDFATHERED) expect(present.has(f), `grandfathered file is gone: ${f}`).toBe(true)
    // A stale entry is worse than none: it silently re-permits the defect for a
    // filename someone could reintroduce. Pin the size so growth is a visible diff.
    expect(GRANDFATHERED.size).toBe(11)
  })

  it("the two audit tables were repaired forward by an ALTER, not by editing history", () => {
    // ⚠ Pins the REMEDY, because the tempting fix — editing the applied migration to
    // add the ALTER — would make this guard green while production stayed exposed:
    // an applied file is never re-run.
    const repair = migrationFiles().find((f) => f.includes("close_the_anon_readable_audit_tables"))
    expect(repair, "the forward-fix migration is missing").toBeTruthy()
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, repair!), "utf8")
    expect(sql).toMatch(
      /ALTER TABLE public\.audit_20260904_ultimate_1of1_editions_created ENABLE ROW LEVEL SECURITY/i
    )
    expect(sql).toMatch(
      /ALTER TABLE public\.audit_20260904_wmc_ultimate_denorm_backup\s+ENABLE ROW LEVEL SECURITY/i
    )
    expect(sql).toMatch(/REVOKE ALL ON public\.audit_20260904_ultimate_1of1_editions_created FROM anon/i)
  })
})
