import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// The three Candy MLB OpenSea indexers were UNSCHEDULED on 2026-10-13 (decided
// by delegation — Trevor: "make decisions on these yourself").
//
// Why: `OPENSEA_API_KEY` is not set in Vercel (known-issues #58, shelved
// 2026-09-23), so every scheduled tick failed with "OPENSEA_API_KEY not set" —
// 16/16, 8/8 and 16/16 runs over three days, ~40 failures a day, three
// permanently-HIGH `failure_rate` alarms and three Vercel error groups. An alarm
// that is always red is indistinguishable from a broken one, and these three sat
// on top of every health read. Candy MLB stays covered by Magic Eden (its
// primary venue): `/api/candy-sales-indexer`, `/api/candy-listings-indexer` and
// `/api/ingest/candy-offers` keep their schedules, and OpenSea was always
// additive.
//
// RETIREMENT IS SCHEDULE-ONLY. The routes, the client and their honest
// "key not set" failure stay in the tree, so the way back is: set
// OPENSEA_API_KEY in Vercel (all environments), restore the three entries
// below in vercel.json (listings "55 */3 * * *", sales "40 */3 * * *",
// offers "5 1-23/6 * * *"), and delete this file.
//
// Like the other *-schedule-is-retired guards, this pins three things, not one:
// the absence, the siblings that must SURVIVE (so an emptied vercel.json cannot
// pass), and the capability that must survive (read from CODE, not comments).

const repoRoot = join(__dirname, "..")
const crons = (): Array<{ path: string; schedule: string }> =>
  JSON.parse(readFileSync(join(repoRoot, "vercel.json"), "utf8")).crons ?? []

const PARKED = [
  "/api/candy-opensea-listings-indexer",
  "/api/candy-opensea-sales-indexer",
  "/api/candy-opensea-offers-indexer",
]
const MAGIC_EDEN_SIBLINGS = ["/api/candy-sales-indexer", "/api/candy-listings-indexer", "/api/ingest/candy-offers"]

describe("Candy OpenSea indexers are parked until OPENSEA_API_KEY exists", () => {
  it("is not vacuous — vercel.json parses and carries a real cron list", () => {
    const list = crons()
    expect(list.length).toBeGreaterThan(20)
    for (const c of list) expect(typeof c.path).toBe("string")
  })

  it("schedules none of the three OpenSea indexers", () => {
    const paths = new Set(crons().map((c) => c.path))
    for (const p of PARKED) expect(paths.has(p), p).toBe(false)
  })

  it("keeps the Magic Eden lanes scheduled — Candy coverage did not go with them", () => {
    const paths = new Set(crons().map((c) => c.path))
    for (const p of MAGIC_EDEN_SIBLINGS) expect(paths.has(p), p).toBe(true)
  })

  it("keeps the routes, and each still refuses to run without the key (read from code, not comments)", () => {
    for (const p of PARKED) {
      const file = join(repoRoot, "app", p, "route.ts")
      expect(existsSync(file), file).toBe(true)
      const code = stripComments(readFileSync(file, "utf8"))
      expect(code, file).toMatch(/OPENSEA_API_KEY/)
    }
  })
})
