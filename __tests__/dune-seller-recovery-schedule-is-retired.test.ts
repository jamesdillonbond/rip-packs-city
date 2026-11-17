import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

// `sync-sales-seller-recovery-dune` (Vercel cron `47 * * * *`) was UNSCHEDULED on 2026-10-18.
//
// Why: since 2026-09-10 every run stops on `dune_budget_state.paused` — the Dune free tier went
// view-only and reviving the lane needs a paid plan, which the no-spend-before-revenue rule
// excludes. Measured 10-18: 24 runs/day, 0 found, 0 written, ~0.2 s each, every day since 10-05
// (and since the pause). Same disposition as its sibling `sync-sales-ingest-dune` (07-28).
//
// Retirement is SCHEDULE-ONLY: the route stays so the lane revives by re-adding one vercel.json
// line once a plan exists (and setting dune_budget_state.paused = false). Its cadence watch row is
// deactivated by migration 20261018193321_audit_20261018_retire_dune_seller_lane_watch.
// Pinned three ways, so an emptied/truncated vercel.json or a deleted route cannot pass.

const repoRoot = join(__dirname, "..")
const crons = (): Array<{ path: string; schedule: string }> =>
  JSON.parse(readFileSync(join(repoRoot, "vercel.json"), "utf8")).crons ?? []

describe("sync-sales-seller-recovery-dune schedule is retired", () => {
  it("is not vacuous — vercel.json carries a real cron list", () => {
    expect(crons().length).toBeGreaterThan(10)
  })
  it("no vercel.json cron calls the paused Dune seller lane", () => {
    expect(crons().filter((c) => c.path.includes("sync-sales-seller-recovery-dune"))).toEqual([])
  })
  it("the route survives, so the lane is revivable by one line", () => {
    expect(existsSync(join(repoRoot, "app/api/cron/sync-sales-seller-recovery-dune/route.ts"))).toBe(true)
  })
})
