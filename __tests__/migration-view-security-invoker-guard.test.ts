import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { stripSqlComments } from "../scripts/lib/strip-sql-comments.mjs"

// ─────────────────────────────────────────────────────────────────────────────
// Every NEW migration that creates a public view must state its security mode.
//
// ⚠ THIS EXISTS BECAUSE THE DEFECT IS INVISIBLE TO EVERY CORRECTNESS CHECK.
// `CREATE OR REPLACE VIEW ... AS` with no WITH clause RESETS reloptions, so it
// silently strips `security_invoker=on` from an already-hardened view. Verified
// empirically on the live instance 2026-08-15:
//
//     create view pg_temp.zz with (security_invoker=on) as select 1;  -- security_invoker=on
//     create or replace view pg_temp.zz as select 1;                  -- options GONE
//
// A view's security mode does not appear in its OUTPUT. On 2026-08-15 migration
// 20260815153324 recreated `topshot_deals_vs_fmv` + `cross_collection_deals_board`
// for a genuine performance win and verified output md5, row count, buffers and
// `Subplans Removed` — all of which pass identically either way — while both views
// dropped to definer mode. `check_public_security_invariants()` caught it, but only
// on the next monitor sweep ~3h later, and nothing failed CI at all.
//
// ⚠ AND IT HAS HAPPENED AT LEAST FOUR TIMES, which is the real argument for a
// guard rather than another comment. Every prior instance was documented — inside
// the migration that caused it, where the next author never looks:
//   · v_rpc_trust_health   — "THE ALTER VIEW BELOW IS LOAD-BEARING … this exact
//                             view silently lost security_invoker=on that way"
//   · panini_squeeze_board — "this migration dropped security_invoker as a side
//                             effect, repaired minutes later by …"
//   · pack_ev_latest       — 20260801012254 creates TWO views, re-asserts the
//                             option for v_topshot_pack_market and NOT for
//                             pack_ev_latest, though its own header says it meant
//                             to. That is why this guard is keyed per VIEW NAME:
//                             a file hardening view A must not vouch for view B.
//   · topshot_deals_vs_fmv + cross_collection_deals_board — 2026-08-15.
// The knowledge existed and was unreachable. This moves it from a comment in one
// migration to a check on every migration: REPO-SIDE and STATEMENT-LEVEL, firing at
// review time on the diff, where the author can still see why.
//
// The rule: a `CREATE [OR REPLACE] VIEW public.<name>` must either carry
// `security_invoker` in its own WITH clause, or be explicitly opted out with a
// marker comment (below). Both are a DECISION; silence is not.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations")

// Opt-out marker for a view that is intentionally SECURITY DEFINER. It must also
// be present in the DB's `security_definer_view_allowlist`, or
// `check_public_security_invariants()` will flag it in production regardless of
// what this file says — the two halves are independent on purpose.
const DEFINER_OPT_OUT = "definer-view: intentional"

// ⚠ GRANDFATHERED — pre-existing files that create a public view without naming a
// security mode for it. They are NOT re-litigated: an applied migration is history,
// editing it cannot change production (it is never re-run), and the churn carries a
// real chance of altering what the file would do if it ever WERE replayed. The point
// of the guard is that this list STOPS GROWING. Do not add to it — put
// `WITH (security_invoker = on)` on the statement, add a matching `ALTER VIEW … SET`,
// or use the opt-out marker.
//
// ⚠ EVERY VIEW BELOW WAS CHECKED LIVE (2026-08-15) rather than assumed safe, because
// "it is old" is not evidence. All are in a correct state today:
//   · pack_ev_latest                 DEFINER, but ALLOWLISTED and anon SELECT revoked
//                                    → accepted by design, no anon exposure
//   · panini_squeeze_board           invoker=on (repaired 2026-07-28), anon revoked
//   · pinnacle_unresolved_with_owner invoker=true, allowlisted, anon revoked
//   · the rest                       create views that are invoker or allowlisted
// `check_public_security_invariants()` returns 0 rows, which is the authority.
const GRANDFATHERED = new Set([
  "20260504000000_analytics_sales_pinnacle_marketplace_label.sql",
  "20260625040127_ufc_studio_history_resolver_and_targets.sql",
  "20260703234059_audit_20260703_materialize_pack_ev_latest_for_pack_table_rows.sql",
  "20260707060008_audit_20260707_pack_table_rows_golazos_canonical_slug.sql",
  "20260707153348_audit_20260707_pack_ev_latest_filter_survivor_biased_vs_live_ask.sql",
  "20260707153808_audit_20260707_pack_table_rows_null_survivor_biased_ev.sql",
  "20260717163000_audit_20260717_pack_ev_latest_sentinel_null_guard.sql",
  "20260801183138_audit_20260801_pack_ev_latest_admit_unknown_price_packs_v2.sql",
  "20260803202225_audit_20260803_fmv_sweep_stall_trust_arm.sql",
  "20260811033305_audit_20260810_candy_pack_ev_model_scope_fmv_to_collection.sql",
  // The one that motivated this guard. Fixed FORWARD by
  // 20260815190500_audit_20260815_restore_security_invoker_on_deals_views.sql
  // (an ALTER VIEW), rather than by editing this applied file.
  "20260815153324_audit_20260815_deals_board_prune_empty_fmv_partitions.sql",
  // These five DO mention security_invoker somewhere in the file, but not for the
  // view flagged — which is exactly the per-view distinction this guard enforces,
  // and why a per-FILE grep (my first survey) undercounted them.
  "20260419000000_pinnacle_ownership_snapshots.sql",
  "20260425220153_pinnacle_unresolved_with_owner_buyer_first.sql",
  "20260425224118_pinnacle_unresolved_with_owner_revert_to_snapshot.sql",
  "20260728170943_audit_20260728_panini_squeeze_honest_coverage_column.sql",
  "20260801012254_audit_20260801_pack_ev_sentinel_price_guard.sql",
])

/**
 * Comments are stripped with the SHARED SQL stripper (`scripts/lib/strip-sql-comments.mjs`).
 *
 * ⚠ It replaced a local two-regex copy on 2026-09-05. The local one closed a NESTED
 * block comment at the first inner terminator and treated a double dash inside a
 * string literal as a comment — both of which blank or reveal the wrong text with no
 * error, which is the failure mode `guards-use-the-shared-comment-stripper` exists to
 * prevent. Migrating the three SQL guards took that ratchet to zero.
 *
 * ⚠ REQUIRED, NOT TIDINESS. This repo has repeatedly been bitten by source guards
 * that matched their own explanatory comments — `pack-dist-contents-not-streamed`,
 * `collection-analytics-failed-vs-empty-guard`, the OG empty-copy sweep, the
 * api-fmv-demo docs guard. The migration this guard was written for quotes
 * `CREATE OR REPLACE VIEW public.topshot_deals_vs_fmv` inside its own header
 * comment, so an uncommented scan reports the explanation as the offence.
 */

type ViewStatement = { file: string; viewName: string; header: string }

/**
 * Does this file re-assert `security_invoker` for THIS view via a separate
 * `ALTER VIEW <name> SET (...)`?
 *
 * ⚠ This is the repo's ESTABLISHED convention and the guard was wrong before it
 * accounted for it: `CREATE OR REPLACE VIEW ... AS ...;` followed by
 * `ALTER VIEW ... SET (security_invoker = on);` is equally correct, and is what
 * `v_rpc_trust_health` and friends do. Keyed to the VIEW NAME, not the file — a
 * file that hardens view A must not vouch for view B, since that is the exact
 * shape of the failure being guarded.
 */
function hasAlterViewHardening(sql: string, viewName: string): boolean {
  const rx = new RegExp(
    `ALTER\\s+VIEW\\s+(?:public\\.)?"?${viewName}"?\\s+SET\\s*\\([^)]*security_invoker[^)]*\\)`,
    "i"
  )
  return rx.test(sql)
}

/**
 * Find each `CREATE [OR REPLACE] VIEW public.<name>` and capture the text between
 * the view name and the `AS` that opens its body — the only place a WITH clause
 * can legally appear.
 */
function findViewStatements(file: string, sql: string): ViewStatement[] {
  const out: ViewStatement[] = []
  const rx = /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:public\.)?"?([A-Za-z0-9_]+)"?([\s\S]*?)\bAS\b/gi
  let m: RegExpExecArray | null
  while ((m = rx.exec(sql)) !== null) {
    out.push({ file, viewName: m[1], header: m[2] ?? "" })
  }
  return out
}

function migrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
}

describe("migrations must state a security mode when creating a public view", () => {
  it("the guard is not vacuous — it finds real CREATE VIEW statements to check", () => {
    const all = migrationFiles().flatMap((f) =>
      findViewStatements(f, stripSqlComments(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")))
    )
    // ~96 files create public views; the statement count is higher still.
    expect(all.length).toBeGreaterThan(50)
  })

  it("every non-grandfathered CREATE VIEW carries security_invoker (or an explicit opt-out)", () => {
    const offenders: string[] = []

    for (const file of migrationFiles()) {
      if (GRANDFATHERED.has(file)) continue
      const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8")
      if (raw.includes(DEFINER_OPT_OUT)) continue
      const sql = stripSqlComments(raw)

      for (const stmt of findViewStatements(file, sql)) {
        const hardenedInline = /security_invoker/i.test(stmt.header)
        const hardenedByAlter = hasAlterViewHardening(sql, stmt.viewName)
        if (!hardenedInline && !hardenedByAlter) {
          offenders.push(`${file} → CREATE VIEW public.${stmt.viewName}`)
        }
      }
    }

    expect(
      offenders,
      `These CREATE VIEW statements do not state a security mode.\n\n` +
        `Fix with EITHER, keyed to this exact view:\n` +
        `  · \`WITH (security_invoker = on)\` on the CREATE statement, or\n` +
        `  · a following \`ALTER VIEW <name> SET (security_invoker = on);\`\n` +
        `CREATE OR REPLACE VIEW resets reloptions, so a view that was already\n` +
        `hardened loses it silently — the output is byte-identical either way.\n` +
        `If the view is intentionally SECURITY DEFINER, put the marker\n` +
        `"${DEFINER_OPT_OUT}" in a comment AND add it to the DB's\n` +
        `security_definer_view_allowlist.\n\n` +
        offenders.map((o) => `  · ${o}`).join("\n")
    ).toEqual([])
  })

  it("the grandfather list only names files that exist, and does not grow silently", () => {
    const present = new Set(migrationFiles())
    for (const f of GRANDFATHERED) expect(present.has(f), `grandfathered file is gone: ${f}`).toBe(true)
    // A stale entry is worse than none: it silently re-permits the defect for a
    // filename someone could reintroduce. Pin the size so growth is a visible diff.
    expect(GRANDFATHERED.size).toBe(16)
  })

  it("the two deals views were repaired forward by an ALTER, not by editing history", () => {
    // ⚠ Pins the REMEDY, because the tempting fix — editing the applied migration to
    // add the WITH clause — would make this guard green while production stayed
    // definer: an applied file is not re-run. The repair has to be its own migration.
    const repair = migrationFiles().find((f) => f.includes("restore_security_invoker_on_deals_views"))
    expect(repair, "the forward-fix migration is missing").toBeTruthy()
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, repair!), "utf8")
    expect(sql).toMatch(/ALTER VIEW public\.topshot_deals_vs_fmv SET \(security_invoker = on\)/i)
    expect(sql).toMatch(/ALTER VIEW public\.cross_collection_deals_board SET \(security_invoker = on\)/i)
  })
})
