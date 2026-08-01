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
//   STAGED (flag false) — the current shipped state:
//     · panini-squeeze absent from the sitemap
//     · layout carries robots:{index:false}
//   PUBLIC (flag true)  — what Trevor's one-line flip produces:
//     · panini-squeeze present in the sitemap at the standard insights priority
//     · layout drops robots entirely (root default = indexable)
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

describe("shipped state — Panini is STAGED", () => {
  it("PANINI_PUBLIC is false (only Trevor flips this)", async () => {
    const { PANINI_PUBLIC } = await import("@/lib/launch-flags")
    expect(PANINI_PUBLIC).toBe(false)
  })

  it("omits panini-squeeze from the sitemap while staged", async () => {
    const { buildSitemapSegment } = await import("@/lib/sitemap-data")
    const s = await buildSitemapSegment(0)
    expect(s.some((x: any) => x.url === `${BASE}/insights/panini-squeeze`)).toBe(false)
    // 43-entry skeleton since the 2026-07-31 Candy go-live (42 historical +
    // candy-mlb live). Panini stays absent — proof its gated entry is a no-op
    // while PANINI_PUBLIC is false, independent of Candy being live.
    expect(s).toHaveLength(43)
  })

  it("keeps robots:noindex on the board while staged", async () => {
    const { metadata } = await import("@/app/insights/panini-squeeze/layout")
    expect(metadata.robots).toEqual({ index: false, follow: false })
  })
})

describe("flipped state — one flag activates the whole launch", () => {
  it("adds panini-squeeze to the sitemap at the standard insights priority", async () => {
    vi.doMock("@/lib/launch-flags", () => ({ CANDY_MLB_PUBLIC: false, PANINI_PUBLIC: true }))
    const { buildSitemapSegment } = await import("@/lib/sitemap-data")
    const s = await buildSitemapSegment(0)
    const entry = s.find((x: any) => x.url === `${BASE}/insights/panini-squeeze`)
    expect(entry).toBeDefined()
    expect(entry!.priority).toBe(0.8)
    expect(entry!.changeFrequency).toBe("daily")
    // Exactly one entry added — no duplicate, no dropped sibling.
    expect(s).toHaveLength(43)
  })

  it("drops robots:noindex so the board is indexable", async () => {
    vi.doMock("@/lib/launch-flags", () => ({ CANDY_MLB_PUBLIC: false, PANINI_PUBLIC: true }))
    const { metadata } = await import("@/app/insights/panini-squeeze/layout")
    expect(metadata.robots).toBeUndefined()
  })

  it("the two flags are independent — flipping Panini does not publish Candy", async () => {
    vi.doMock("@/lib/launch-flags", () => ({ CANDY_MLB_PUBLIC: false, PANINI_PUBLIC: true }))
    const { buildSitemapSegment } = await import("@/lib/sitemap-data")
    const s = await buildSitemapSegment(0)
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
