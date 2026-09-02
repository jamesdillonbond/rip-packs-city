import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// `topshot-wmc-fossil-drain` (the `?wmc=1` leg of
// /api/admin/drain-topshot-misattribution) was UNSCHEDULED on 2026-08-17.
//
// Why: its fossil population was measured at exactly ZERO — a chunked loose index
// scan enumerated all 11,799 distinct Top Shot `edition_key`s in
// wallet_moments_cache and none is non-canonical. Until then the weekly tick spent
// ~120s of connection time on an IO-throttled instance proving that emptiness, and
// failed 3 of 3 observable runs on `targets: canceling statement due to statement
// timeout`. Same disposition as topshot-flowty-unmapped-drain.
//
// This guard pins the RETIREMENT rather than the fix, because the two obvious
// "repairs" are both wrong on a provably empty predicate: the partial index would
// add write cost to the platform's most write-heavy table, and raising the
// function's declared statement_timeout is inert (the documented proconfig rule).
//
// ⚠ It deliberately pins THREE things, not one. Asserting only "the wmc entry is
// absent" would pass just as well if vercel.json were emptied, truncated, or if the
// whole route were deleted — so the sibling that must SURVIVE and the capability
// that must survive are asserted too. Retirement here means schedule-only.

const repoRoot = join(__dirname, "..")

function crons(): Array<{ path: string; schedule: string }> {
  const raw = readFileSync(join(repoRoot, "vercel.json"), "utf8")
  const parsed = JSON.parse(raw)
  return parsed.crons ?? []
}

const routeSrc = () =>
  readFileSync(
    join(repoRoot, "app/api/admin/drain-topshot-misattribution/route.ts"),
    "utf8",
  )

/**
 * ⚠ Load-bearing, and caught by mutation rather than review: the retirement note
 * this guard also asserts NAMES `topshot_wmc_fossil_targets` in prose, so a raw
 * grep for the capability passes on the comment alone — it survived a mutation
 * that swapped the real branch to the wrong RPC. The capability assertions must
 * read CODE. Same rule this repo already applies to every source guard that greps
 * for a string its own header quotes.
 */

describe("topshot-wmc-fossil-drain schedule is retired", () => {
  it("is not vacuous — vercel.json parses and carries a real cron list", () => {
    const list = crons()
    expect(Array.isArray(list)).toBe(true)
    // A population check, not a fixed count: the number moves whenever anyone
    // schedules anything, and pinning it here would redden CI on unrelated work.
    expect(list.length).toBeGreaterThan(20)
    for (const c of list) {
      expect(typeof c.path).toBe("string")
      expect(typeof c.schedule).toBe("string")
    }
  })

  it("schedules NO ?wmc=1 fossil-drain tick", () => {
    // Matched on the query param rather than a literal path string so a
    // reordered/re-spelled entry (`?rekey=1&wmc=1`, an added &limit=) still trips it.
    const wmc = crons().filter(
      (c) =>
        c.path.startsWith("/api/admin/drain-topshot-misattribution") &&
        /[?&]wmc=1(&|$)/.test(c.path),
    )
    expect(wmc).toEqual([])
  })

  it("keeps the daily non-wmc drain, which is a DIFFERENT and productive pool", () => {
    // The drain reads topshot_misattrib_drain_targets and wrote 888 rows on
    // 2026-08-17. Retiring the wmc leg must not touch it — they share a route but
    // not a target pool, a rekey RPC, or a pipeline name.
    const daily = crons().filter(
      (c) =>
        c.path.startsWith("/api/admin/drain-topshot-misattribution") &&
        !/[?&]wmc=1(&|$)/.test(c.path),
    )
    expect(daily).toHaveLength(1)
  })

  it("no longer schedules ?rekey=1 over HTTP — that leg moved to pg_cron 2026-09-02", () => {
    // ⚠ THIS ASSERTION WAS INVERTED, NOT DELETED. It used to require `rekey=1` on
    // the daily entry. The re-key reaches remap_topshot_from_onchain_map() over
    // PostgREST, where the Supabase gateway hard-caps the request at ~120 s — and
    // the CONTROL that settles what that costs is the audit tables: on all five
    // `rekey: upstream request timeout` days between 08-23 and 08-28,
    // audit_topshot_sale_drain_remap_20260621 gained ZERO rows. The gateway giving
    // up ROLLS THE WORK BACK; it is not a lost response over a committed re-key.
    // It now runs as pg_cron job `rpc-topshot-onchain-rekey` (11:33 UTC daily)
    // under `cron_heavy`, whose role statement_timeout is 600 s.
    //
    // Pinned so the obvious "restore" — putting rekey=1 back on the Vercel entry —
    // reds instead of silently double-running a 1.4 GB scan twice a day.
    const rekeyed = crons().filter((c) => /[?&]rekey=1(&|$)/.test(c.path))
    expect(rekeyed).toEqual([])
  })

  it("retires the rekey SCHEDULE only — ?rekey=1 still works on the route by hand", () => {
    // Same disposition as the wmc leg above: schedule-only. A manual re-key after
    // a large map import must stay possible.
    const code = stripComments(routeSrc())
    expect(code).toMatch(/searchParams\.get\("rekey"\)/)
    expect(code).toContain("remap_topshot_from_onchain_map")
  })

  it("retires the SCHEDULE only — the ?wmc=1 capability still exists on the route", () => {
    // If the fossil population ever regrows, the leg must still be invocable by
    // hand. Deleting the branch would make this retirement irreversible in a way
    // the measurement does not justify.
    const code = stripComments(routeSrc())
    expect(code).toContain("topshot_wmc_fossil_targets")
    expect(code).toContain("remap_topshot_wmc_from_onchain_map")
    expect(code).toContain("topshot-wmc-fossil-drain")
    // And the branch must still be reachable: the capability is worthless if the
    // ?wmc=1 param stops selecting it.
    expect(code).toMatch(/searchParams\.get\("wmc"\)/)
  })

  it("records why it is unscheduled, so nobody reschedules it without re-measuring", () => {
    // The failure mode this prevents is a future session seeing a dead cron
    // reference and "restoring" it — the measurement is the reason, and it has to
    // live next to the code, not only in the ledger.
    const src = routeSrc()
    expect(src).toMatch(/UNSCHEDULED 2026-08-17/)
    expect(src).toMatch(/11,799/)
  })
})
