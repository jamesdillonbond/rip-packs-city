import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

// Three Vercel crons fired daily into the dead Top Shot GraphQL host
// (public-api.nbatopshot.com, 530 / CF 1033 since ~2026-08-28) and were UNSCHEDULED
// on 2026-09-08:
//
//   /api/cron/ingest-topshot-challenges                 `10 8 * * *`
//   /api/admin/backfill-topshot-subedition-circulation  `10 21 * * *`
//   /api/admin/drain-topshot-misattribution             `0 11 * * *`
//
// Measured over the FULL pipeline_runs retention window (inbox filing
// 2026-09-08T0530Z): 3 of 3 runs each, 0 ok, 0 rows written, `last_success` NULL
// throughout. They could not succeed, and each one was a permanently-red instrument
// on the failure list. The filing assumed their caller was cron-job.org; it was
// vercel.json — which is why this is a code change and not an operator item.
//
// Same disposition as sync-sales-ingest-dune (2026-07-28) and the ?wmc=1 drain leg
// (2026-08-17): SCHEDULE-ONLY. The routes, their gates and their route tests are
// untouched, so each lane runs by hand and can be re-scheduled (or re-pointed to
// Atlas) the moment a manual run writes rows.
//
// ⚠ Pins three things, not one: the entries are absent, vercel.json still carries
// a real cron list (so an emptied/truncated file cannot pass), and each route file
// still exists AND records why it is unscheduled next to the code.

const repoRoot = join(__dirname, "..")

const RETIRED = [
  { path: "/api/cron/ingest-topshot-challenges", route: "app/api/cron/ingest-topshot-challenges/route.ts" },
  {
    path: "/api/admin/backfill-topshot-subedition-circulation",
    route: "app/api/admin/backfill-topshot-subedition-circulation/route.ts",
  },
  { path: "/api/admin/drain-topshot-misattribution", route: "app/api/admin/drain-topshot-misattribution/route.ts" },
]

function crons(): Array<{ path: string; schedule: string }> {
  const parsed = JSON.parse(readFileSync(join(repoRoot, "vercel.json"), "utf8"))
  return parsed.crons ?? []
}

describe("Top Shot GraphQL dead-host crons are retired (schedule-only)", () => {
  it("is not vacuous — vercel.json parses and carries a real cron list", () => {
    const list = crons()
    expect(Array.isArray(list)).toBe(true)
    expect(list.length).toBeGreaterThan(20)
    for (const c of list) {
      expect(typeof c.path).toBe("string")
      expect(typeof c.schedule).toBe("string")
    }
  })

  for (const { path, route } of RETIRED) {
    it(`schedules NO tick for ${path} (any query string)`, () => {
      // Prefix match on purpose: `?limit=50`, `?probe=1` or a re-spelled entry must
      // trip this too — the host is dead whatever the parameters say.
      const hits = crons().filter((c) => c.path === path || c.path.startsWith(path + "?"))
      expect(hits).toEqual([])
    })

    it(`keeps the route for ${path} and records why it is unscheduled`, () => {
      const file = join(repoRoot, route)
      expect(existsSync(file)).toBe(true)
      const src = readFileSync(file, "utf8")
      // The failure mode this prevents is a future session seeing the route with no
      // schedule and "restoring" it — the measurement has to live next to the code.
      expect(src).toMatch(/UNSCHEDULED 2026-09-08/)
      expect(src).toMatch(/530/)
    })
  }
})
