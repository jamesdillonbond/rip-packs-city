import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

// `refresh_challenge_costs` reads `pack_ev_latest` as the FIRST arm of the COALESCE
// that fills `challenges.cached_reward_value`. That view is
// `DISTINCT ON (pack_listing_id) … ORDER BY pack_listing_id, snapshotted_at DESC`, so a
// CORRELATED scalar subquery against it cannot push `dist_id` through the DISTINCT —
// Postgres re-materialises the entire view once per challenge row.
//
// Measured 2026-09-02 (EXPLAIN ANALYZE, BUFFERS, warm, 31 challenge rows):
//   correlated : 40,716 ms / 21,094,324 buffers   ← 99.7% of the whole function
//   hoisted    :  1,220 ms /    681,430 buffers
// The view's own `pack_ask_state` NOT EXISTS subplan alone ran 3,849,487 times.
//
// ⚠ THE CONSEQUENCE WAS A SILENT DAILY OUTAGE, NOT JUST SLOWNESS. pg_cron jobid 87
// `rpc-refresh-challenge-costs` died at exactly 120.0 s (the CLUSTER default
// statement_timeout, which is what a `postgres`-owned job runs under) on 8 of its last
// 52 runs — 15.4%. Both UPDATEs live in one `SELECT refresh_challenge_costs()`, so the
// timeout rolled back the cost refresh too: on those days NOTHING was refreshed. The
// function writes no `pipeline_runs` row, so the only witness was
// `cron.job_run_details`, which nothing sweeps.
//
// ⛔ WHAT THIS PINS IS THE HOIST, and it is worth pinning because the correlated form
// is the one a reader reaches for: it is shorter, it reads naturally next to the three
// sibling arms, and NOTHING about it looks expensive. Re-inlining it would restore a
// 30× cost with no visible diff in behaviour — the function would still return the same
// numbers, just slowly enough to be killed one day in seven.
//
// ⚠ Pinned as the PROPERTY (the view is read once, into a temp table, and the arm reads
// that table) rather than as a spelling, so a better hoist — a CTE, a different temp
// name — is free to land as long as the arm is not correlated against the view again.

const MIGRATION = join(
  process.cwd(),
  "supabase/migrations/20260902120329_audit_20260902_challenge_costs_arm1_hoisted_out_of_the_per_row_loop.sql",
)

const sql = () => readFileSync(MIGRATION, "utf8")

/** The `CREATE OR REPLACE FUNCTION … $function$ … $function$;` body, tag auto-detected. */
function fnBody(src: string): string {
  const start = src.indexOf("CREATE OR REPLACE FUNCTION public.refresh_challenge_costs")
  expect(start, "the migration must define refresh_challenge_costs").toBeGreaterThan(-1)
  const rest = src.slice(start)
  const open = rest.indexOf("$function$")
  const close = rest.indexOf("$function$", open + "$function$".length)
  expect(close, "the function body must be dollar-quoted with $function$").toBeGreaterThan(open)
  return rest.slice(open, close)
}

describe("refresh_challenge_costs reads pack_ev_latest once, not once per challenge", () => {
  it("is not vacuous: the migration exists and carries the function", () => {
    const src = sql()
    expect(src.length).toBeGreaterThan(2000)
    expect(src).toContain("CREATE OR REPLACE FUNCTION public.refresh_challenge_costs")
    // The body extractor must return real SQL, not an empty slice.
    expect(fnBody(src).length).toBeGreaterThan(500)
  })

  it("reads the view EXACTLY ONCE, and that read builds the lookup table", () => {
    const body = fnBody(sql())
    const reads = body.match(/FROM\s+public\.pack_ev_latest/g) ?? []
    expect(
      reads.length,
      "more than one read of pack_ev_latest means it is back inside the per-row COALESCE",
    ).toBe(1)
    // …and the single read must be the one that populates the temp table.
    expect(body).toMatch(/CREATE TEMP TABLE\s+_pack_ev[\s\S]{0,200}FROM\s+public\.pack_ev_latest/)
  })

  it("the COALESCE's first arm reads the hoisted table, not the view", () => {
    const body = fnBody(sql())
    // ⚠ Anchor on the REWARD update, not on the first COALESCE in the body — the cost
    // CTE above it also uses COALESCE, and slicing from there swept in the temp-table
    // build and made this assertion fail for the wrong reason (caught on first run).
    const reward = body.slice(body.indexOf("cached_reward_value = ("))
    expect(reward.length, "the reward-value UPDATE must still be there").toBeGreaterThan(200)
    const coalesce = reward.slice(reward.indexOf("COALESCE("))
    const firstArm = coalesce.slice(0, coalesce.indexOf("(SELECT round("))
    expect(firstArm).toContain("_pack_ev")
    expect(firstArm).not.toContain("pack_ev_latest")
  })

  it("the hoisted read is deterministic — a bare LIMIT 1 is physical order, not a pick", () => {
    // The arm it replaces was `… LIMIT 1` with no ORDER BY. Preserving that
    // arbitrariness in the hoist would make the cached value depend on heap layout.
    const body = fnBody(sql())
    expect(body).toMatch(/DISTINCT ON \(pe\.dist_id\)[\s\S]{0,400}ORDER BY pe\.dist_id, pe\.snapshotted_at DESC/)
  })

  it("still filters the lookup by the collection it was called for", () => {
    // Dropping this makes the temp table 5.7× larger and lets a dist_id from another
    // collection answer for a Top Shot challenge.
    const body = fnBody(sql())
    const build = body.slice(body.indexOf("CREATE TEMP TABLE _pack_ev"))
    expect(build.slice(0, 400)).toContain("pe.collection_id = p_collection_id")
  })

  it("the migration is the newest one defining this function, so the pin points at live DDL", () => {
    // ⚠ The drift trap this repo records: a pin can name a superseded migration and
    // stay green while validating DDL that no longer runs anywhere. Derived by a walk,
    // never a hardcoded list.
    const dir = join(process.cwd(), "supabase/migrations")
    const defining = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) =>
        readFileSync(join(dir, f), "utf8").includes(
          "CREATE OR REPLACE FUNCTION public.refresh_challenge_costs",
        ),
      )
      .sort()
    expect(defining.length).toBeGreaterThan(0)
    expect(defining[defining.length - 1]).toBe(
      "20260902120329_audit_20260902_challenge_costs_arm1_hoisted_out_of_the_per_row_loop.sql",
    )
  })
})
