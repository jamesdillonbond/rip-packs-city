import { vi, describe, it, expect, afterEach } from "vitest"

// ─────────────────────────────────────────────────────────────────────────────
// Panini WC Prizm launch-flag contract.
//
// Until 2026-07-28 `PANINI_PUBLIC` had ZERO consumers: proxy.ts gated
// `/…/panini` with a bare regex and the other four surfaces (sitemap, hub card,
// layout robots, smoke list) had no `panini` reference at all. Flipping the flag
// would have changed NOTHING — a silent non-launch, which is strictly worse than
// a loud one because you'd believe you had shipped.
//
// These tests pin the wiring in BOTH directions, mirroring the Candy contract:
//
//   LIVE (flag true) — the current shipped state, since the 2026-08-01 go-live:
//     · panini-squeeze present in the sitemap at the standard insights priority
//     · layout drops robots entirely (root default = indexable)
//   STAGED (flag false) — the rollback direction:
//     · panini-squeeze absent from the sitemap
//     · layout carries robots:{index:false}
//
// The proxy gate and the smoke-list entry are asserted at the source level: both
// live in modules that pull in heavy runtime deps (@supabase/ssr, the whole
// smoke suite), so importing them here would test the mock, not the wiring. What
// matters is that each file reads the flag rather than hardcoding the decision.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs"
import { join } from "node:path"

const BASE = "https://www.rippackscity.com"
const REPO = join(__dirname, "..")

// Supabase is mocked to return no rows so buildSitemapSegment(0) yields only the
// deterministic static/insights/overview skeleton — the part this test is about.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => {
      const b: any = {}
      for (const m of ["select", "eq", "order", "limit", "in", "is", "gte", "lt", "not", "ilike", "range"]) {
        b[m] = () => b
      }
      b.then = (resolve: any) => resolve({ data: [], error: null })
      return b
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}))

afterEach(() => {
  vi.resetModules()
  vi.doUnmock("@/lib/launch-flags")
})

describe("shipped state — Panini is LIVE (2026-08-01 go-live)", () => {
  it("PANINI_PUBLIC is true", async () => {
    const { PANINI_PUBLIC } = await import("@/lib/launch-flags")
    expect(PANINI_PUBLIC).toBe(true)
  })

  it("includes panini-squeeze in the sitemap at the standard insights priority", async () => {
    const { buildSitemapSegment } = await import("@/lib/sitemap-data")
    const s = await buildSitemapSegment(0)
    const entry = s.find((x: any) => x.url === `${BASE}/insights/panini-squeeze`)
    expect(entry).toBeDefined()
    expect(entry!.priority).toBe(0.8)
    expect(entry!.changeFrequency).toBe("daily")
    // Static skeleton grew by 2 on 2026-08-01 (/pricing + /nba/fast-break, both
    // long-public but never enumerated), and by 28 on 2026-08-20 (the
    // per-collection feature tabs proxy.ts un-gated on 2026-07-17, same class
    // again). ⚠ THIRD unrelated bump to these totals in three weeks: the launch
    // contract this file actually asserts is PRESENT-when-on / ABSENT-when-off,
    // and the length pin is standing in for "nothing else moved". It keeps
    // redding on changes that have nothing to do with either flag. Left as an
    // absolute pin rather than restructured here, because rewriting a go-live
    // contract test's semantics while shipping an unrelated sitemap change is
    // how a safety net gets loosened by accident — flagged for a deliberate pass.
    // 74 = 44 historical + candy-mlb (2026-07-31) + panini-squeeze (2026-08-01),
    // both live, + 28 feature tabs (2026-08-20).
    // 75 since 2026-09-06: + the registry-published /candy-mlb/overview.
    expect(s).toHaveLength(75)
  })

  it("drops robots:noindex so the board is indexable", async () => {
    const { metadata } = await import("@/app/insights/panini-squeeze/layout")
    expect(metadata.robots).toBeUndefined()
  })
})

describe("rollback direction — flipping the flag off re-gates the launch", () => {
  it("omits panini-squeeze from the sitemap when the flag is off", async () => {
    vi.doMock("@/lib/launch-flags", () => ({ CANDY_MLB_PUBLIC: true, PANINI_PUBLIC: false }))
    const { buildSitemapSegment } = await import("@/lib/sitemap-data")
    const s = await buildSitemapSegment(0)
    expect(s.some((x: any) => x.url === `${BASE}/insights/panini-squeeze`)).toBe(false)
    // Back to the 45-entry skeleton (44 historical + candy-mlb) + the 28
    // flag-independent feature tabs — proof rollback is a clean no-op that
    // leaves Candy untouched.
    expect(s).toHaveLength(74)
  })

  it("restores robots:noindex when the flag is off", async () => {
    vi.doMock("@/lib/launch-flags", () => ({ CANDY_MLB_PUBLIC: true, PANINI_PUBLIC: false }))
    const { metadata } = await import("@/app/insights/panini-squeeze/layout")
    expect(metadata.robots).toEqual({ index: false, follow: false })
  })

  it("the two flags are independent — flipping Candy off does not un-publish Panini", async () => {
    vi.doMock("@/lib/launch-flags", () => ({ CANDY_MLB_PUBLIC: false, PANINI_PUBLIC: true }))
    const { buildSitemapSegment } = await import("@/lib/sitemap-data")
    const s = await buildSitemapSegment(0)
    expect(s.some((x: any) => x.url === `${BASE}/insights/panini-squeeze`)).toBe(true)
    expect(s.some((x: any) => x.url === `${BASE}/insights/candy-mlb`)).toBe(false)
  })
})

describe("source wiring — every consumer reads the flag", () => {
  it("proxy.ts gates /…/panini behind PANINI_PUBLIC, not a bare regex", () => {
    const src = readFileSync(join(REPO, "proxy.ts"), "utf8")
    expect(src).toMatch(/import \{[^}]*PANINI_PUBLIC[^}]*\} from "@\/lib\/launch-flags"/)
    // The regression this pins: a `/…/panini/` test with no `!PANINI_PUBLIC &&`
    // in front of it makes the flag inert (the pre-2026-07-28 state). Asserted
    // as a source substring rather than a regex-of-a-regex, which is unreadable
    // and escapes wrong more often than it catches anything.
    const paniniGate = src
      .split("\n")
      .find((l) => l.includes("panini/.test(pathname)"))
    expect(paniniGate, "no /…/panini gate line found in proxy.ts").toBeDefined()
    expect(paniniGate).toContain("!PANINI_PUBLIC &&")
  })

  it("the /insights hub card is flag-gated", () => {
    const src = readFileSync(join(REPO, "app", "insights", "page.tsx"), "utf8")
    expect(src).toMatch(/\.\.\.\(PANINI_PUBLIC/)
    expect(src).toContain("/insights/panini-squeeze")
  })

  it("the smoke-test public-page list is flag-gated", () => {
    const src = readFileSync(join(REPO, "app", "api", "smoke-test", "route.ts"), "utf8")
    expect(src).toMatch(/\.\.\.\(PANINI_PUBLIC \? \["\/insights\/panini-squeeze"\] : \[\]\)/)
  })
})
