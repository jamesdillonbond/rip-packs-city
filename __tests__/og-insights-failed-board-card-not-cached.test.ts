import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

// Every /api/og/insights/<board> card tracks `let fetched = false` and renders
// "Couldn't load the live board" when its board read fails. Until 2026-10-09 all
// of them shipped that failure card with OG_CACHE_HEADERS (1 h + 24 h stale), so
// a shared /insights link unfurled the error for ~25 hours after one blip.
// The cache must follow the read: ogCacheHeaders(!fetched).
const DIR = "app/api/og/insights"
const routes = readdirSync(DIR)
  .map((d) => join(DIR, d, "route.tsx"))
  .filter((p) => existsSync(p))
  .filter((p) => readFileSync(p, "utf8").includes("let fetched = false"))

describe("insights OG cards: a failed board read is not cached for a day", () => {
  it("inspects the real population", () => {
    expect(routes.length).toBeGreaterThanOrEqual(15)
  })
  for (const p of routes) {
    it(`${p} ties its cache header to the read`, () => {
      const src = readFileSync(p, "utf8")
      expect(src).toContain("ogCacheHeaders(!fetched)")
      expect(src).not.toMatch(/headers:\s*OG_CACHE_HEADERS\b/)
    })
  }
})
