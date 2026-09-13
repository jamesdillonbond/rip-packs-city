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
    // ✅ THE ABSOLUTE LENGTH PIN THAT USED TO SIT HERE IS GONE (2026-09-12), and
    // the comment it carried is why — preserved below because it called the
    // shot and nobody acted on it for five more bumps.
    //
    // It read 73 and the tree was at 74: Candy MLB gained a real Market tab, an
    // entry with nothing to do with either flag. That is the SIXTH such bump,
    // and this time it reddened `main`. ⭐ **A ceiling that churns gets raised
    // rather than read — and this one was being raised by whoever happened to
    // trip it, which is worse: the number was re-derived from the observed
    // state each time, so it could never disagree with reality.**
    //
    // What the pin was standing in for is "nothing ELSE moved when the flag
    // flips", and that is a DELTA between two sitemaps, not an absolute count of
    // one. It is now asserted as exactly that, in the dedicated test below —
    // strictly stronger (it proves the two builds differ by the panini entry and
    // in no other way) and immune to unrelated growth.
    //
    // Historical note, kept verbatim:
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
    // 74 on 2026-09-07: /pricing left the sitemap (footer + index too). Fourth
    // unrelated bump — the deliberate restructure above is still owed.
    // 73 on 2026-09-07: UFC's sniper tab retired from the registry (no market
    // since 2026-05-13). FIFTH unrelated bump, and still flag-independent.
    //
    // ⚠ NON-VACUITY, which is the half of the length pin worth keeping: a
    // mocked Supabase that returned nothing, or a build that threw and was
    // swallowed, would make "panini-squeeze is present" pass against a
    // near-empty list. The skeleton is asserted to be substantial WITHOUT
    // pinning an exact number nobody can maintain.
    expect(s.length).toBeGreaterThan(50)
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
    // Back to the 45-entry skeleton (44 historical + candy-mlb) + the
    // flag-independent feature tabs — proof rollback is a clean no-op that
    // leaves Candy untouched. 73 -> 72 on 2026-09-07: one fewer feature tab,
    // UFC's retired sniper. Both directions move by the same 1.
    //
    // ✅ Absolute pin removed 2026-09-12 for the reason given at the LIVE case:
    // it was re-derived from the observed state on every unrelated bump, so it
    // could never disagree with reality. "Both directions move by the same 1"
    // is the real claim and is now asserted directly, below.
    expect(s.length).toBeGreaterThan(50)
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

// ─────────────────────────────────────────────────────────────────────────────
// ⭐ THE CLAIM THE TWO LENGTH PINS WERE STANDING IN FOR, asserted directly.
//
// Both absolute pins were removed on 2026-09-12 after their SIXTH unrelated
// bump — Candy MLB's new Market tab — which reddened `main` on a change that
// touches neither flag. The pins' own comment had flagged the restructure as
// owed since the third bump.
//
// ⛔ The deeper problem was not the churn. It was that the expected number was
// RE-DERIVED FROM THE OBSERVED STATE each time it broke, so it could never
// disagree with reality — a fixer that reads from the thing it repairs launders
// an error into internal consistency. The same shape CLAUDE.md records for
// `scripts/fix-inbox-index-counts.mjs`.
//
// A DELTA cannot be laundered that way: it is computed from two builds of the
// same tree that differ only in the flag, so unrelated growth cancels.
// ─────────────────────────────────────────────────────────────────────────────
describe("flipping PANINI_PUBLIC moves EXACTLY the panini entries and nothing else", () => {
  async function sitemapUnder(PANINI_PUBLIC: boolean): Promise<string[]> {
    vi.resetModules()
    vi.doMock("@/lib/launch-flags", () => ({ CANDY_MLB_PUBLIC: true, PANINI_PUBLIC }))
    const { buildSitemapSegment } = await import("@/lib/sitemap-data")
    const s = await buildSitemapSegment(0)
    return (s as any[]).map((x) => x.url)
  }

  it("the symmetric difference is exactly /insights/panini-squeeze", async () => {
    const on = await sitemapUnder(true)
    const off = await sitemapUnder(false)

    // ⚠ NON-VACUITY FIRST. Two empty lists have an empty symmetric difference,
    // so without this the assertion below passes hardest when the build is most
    // broken — the vacuous-guard shape this repo keeps re-finding.
    expect(on.length).toBeGreaterThan(50)
    expect(off.length).toBeGreaterThan(50)

    const onlyOn = on.filter((u) => !off.includes(u))
    const onlyOff = off.filter((u) => !on.includes(u))

    expect(onlyOn, "turning the flag ON added something other than panini-squeeze").toEqual([
      `${BASE}/insights/panini-squeeze`,
    ])
    expect(onlyOff, "turning the flag OFF removed something it should not have").toEqual([])
    // "Both directions move by the same 1", stated as the counts rather than
    // as two absolute totals that drift apart on every unrelated change.
    expect(on.length - off.length).toBe(1)
  })

  it("POSITIVE CONTROL — the comparison can SEE a difference", async () => {
    // Without this, `onlyOn`/`onlyOff` returning [] would be indistinguishable
    // from a `sitemapUnder` that hands back the same array twice (a failed
    // `resetModules`, a cached module, a mock that never took).
    const on = await sitemapUnder(true)
    const off = await sitemapUnder(false)
    expect(on).not.toEqual(off)
    expect(on).toContain(`${BASE}/insights/panini-squeeze`)
    expect(off).not.toContain(`${BASE}/insights/panini-squeeze`)
  })
})
