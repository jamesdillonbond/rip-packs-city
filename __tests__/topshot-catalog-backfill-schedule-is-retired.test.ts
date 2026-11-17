import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// `topshot-catalog-backfill` was UNSCHEDULED on 2026-09-04 (PT).
//
// Why: its upstream, `public-api.nbatopshot.com`, has answered HTTP 530
// (Cloudflare 1033 — origin decommissioned) since 2026-08-28. Measured from
// `pipeline_runs_daily`: last success 2026-08-28, then 7 of 7 daily ticks
// failed. A permanently red arm is worse than no arm — it teaches the next
// reader to skip this pipeline's failures.
//
// It is retired because it is REDUNDANT, not merely broken — all three jobs it
// owned have live owners (circulation on-chain; tier/badges and, since
// migration 20260905024630, prose + media from the Atlas edition walk).
//
// ⚠ This guard deliberately pins FIVE things, not one. "The entry is absent"
// would pass just as well if vercel.json were emptied or truncated, or if the
// route were deleted — so the cron list must still be real, the ROUTE must
// survive (retirement here is schedule-only), the restore line must still be
// printed where the next reader will find it, the replacement lanes must be
// named, and the lane that inherited the work must still be scheduled. Same
// shape as fossil-drain-schedule-is-retired.

const repoRoot = join(__dirname, "..")

function crons(): Array<{ path: string; schedule: string }> {
  const parsed = JSON.parse(readFileSync(join(repoRoot, "vercel.json"), "utf8"))
  return parsed.crons ?? []
}

const routePath = "app/api/cron/topshot-catalog-backfill/route.ts"
const routeSrc = () => readFileSync(join(repoRoot, routePath), "utf8")

describe("topshot-catalog-backfill schedule is retired", () => {
  it("is not vacuous — vercel.json parses and carries a real cron list", () => {
    const list = crons()
    expect(Array.isArray(list)).toBe(true)
    // A population check, not a fixed count: the number moves whenever anyone
    // schedules anything, and pinning it would redden CI on unrelated work.
    expect(list.length).toBeGreaterThan(20)
    for (const c of list) {
      expect(typeof c.path).toBe("string")
      expect(typeof c.schedule).toBe("string")
    }
  })

  it("has no cron entry pointed at the dead-upstream catalog walker", () => {
    const hits = crons().filter(
      (c) =>
        c.path.includes("topshot-catalog-backfill") ||
        c.path.includes("backfill-topshot-catalog"),
    )
    expect(hits).toEqual([])
  })

  it("keeps the route itself — retirement here is schedule-only", () => {
    const src = routeSrc()
    // Read CODE, not the header prose: a grep for the handler name alone would
    // pass on the comment that quotes it.
    expect(src).toMatch(/export\s+(const\s+GET|async\s+function\s+GET)/)
    expect(src).toContain("backfill-topshot-catalog")
  })

  it("prints the exact one-line restore, and names what took the work over", () => {
    const src = routeSrc()
    expect(src).toContain('"schedule": "12 2 * * *"')
    expect(src).toContain("To restore")
    // The three inheriting lanes, so a future reader who wants the capability
    // back looks at the live owner before re-arming a 530.
    expect(src).toContain("topshot-circulation-onchain")
    expect(src).toContain("atlas_editions_dispatch")
    expect(src).toContain("20260905024630")
  })

  it("still schedules the on-chain lane that inherited the circulation half", () => {
    const paths = crons().map((c) => c.path)
    expect(paths).toContain("/api/cron/topshot-circulation-onchain")
  })
})
