import { vi, describe, it, expect, afterEach } from "vitest"

// ─────────────────────────────────────────────────────────────────────────────
// Candy MLB launch-flag contract.
//
// Taking /insights/candy-mlb public used to be a 5-touch change across
// proxy.ts, lib/sitemap-data.ts, app/insights/page.tsx,
// app/insights/candy-mlb/layout.tsx and app/api/smoke-test/route.ts. Five
// touches is five chances to half-ship: the classic failure is un-gating the
// route but leaving robots:noindex on, so the board is public AND invisible to
// crawlers — fatal for a surface whose entire thesis is organic distribution.
//
// lib/launch-flags.ts collapsed that into ONE boolean. These tests pin the
// contract in BOTH directions, because a flag is only worth having if the
// flag-ON path is proven to actually activate everything:
//
//   LIVE (flag true) — the current shipped state, since the 2026-07-31 go-live:
//     · candy-mlb present in the sitemap at the standard insights priority
//     · layout drops robots entirely (root default = indexable)
//   STAGED (flag false) — the rollback direction:
//     · candy-mlb absent from the sitemap
//     · layout carries robots:{index:false}
//
// It also pins two things that are easy to regress independently of the flag:
// the param-stripped self-canonical, and the fact that this layout does NOT
// inherit the site-wide double-suffix title bug (the other 29 insights layouts
// hardcode "| Rip Packs City" AND get the root template appended, producing
// "… | Rip Packs City | Rip Packs City").
// ─────────────────────────────────────────────────────────────────────────────

const BASE = "https://www.rippackscity.com"

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

describe("shipped state — Candy is LIVE (2026-07-31 go-live)", () => {
  it("CANDY_MLB_PUBLIC is true", async () => {
    const { CANDY_MLB_PUBLIC } = await import("@/lib/launch-flags")
    expect(CANDY_MLB_PUBLIC).toBe(true)
  })

  it("includes candy-mlb in the sitemap at the standard insights priority", async () => {
    const { buildSitemapSegment } = await import("@/lib/sitemap-data")
    const s = await buildSitemapSegment(0)
    const entry = s.find((x: any) => x.url === `${BASE}/insights/candy-mlb`)
    expect(entry).toBeDefined()
    expect(entry!.priority).toBe(0.8)
    expect(entry!.changeFrequency).toBe("daily")
    // ⭐ THE DELIBERATE PASS THIS FILE ASKED FOR, done 2026-09-12.
    //
    // There used to be an absolute `toHaveLength(N)` here, standing in for
    // "nothing else moved". It was re-baselined FIVE times in six weeks —
    // /pricing + /nba/fast-break (08-01), 28 un-gated feature tabs (08-20),
    // /candy-mlb/overview (09-06), /pricing leaving (09-07), UFC's sniper
    // retiring (09-07) — and not once for a reason connected to either launch
    // flag. Candy's Market tab (09-12) would have been the sixth. Its own
    // comment had been asking for this restructure since the third.
    //
    // ⚠ A pin that reds on unrelated changes does not stay strict; it gets
    // re-baselined by whoever is holding an unrelated diff, which is the one
    // moment nobody is thinking about go-live semantics. That is the failure
    // mode, and five re-baselines is the evidence.
    //
    // So assert the PROPERTY instead, and it is strictly stronger than the count
    // for the thing this file protects: the flag-controlled URLs are EXACTLY the
    // two named ones, and flipping the flags off changes NOTHING ELSE. An
    // unrelated sitemap addition now moves both sides together and says nothing;
    // a leak of some third URL into flag control fails, which the length pin
    // could never have detected on its own.
    const { CANDY_MLB_PUBLIC } = await import("@/lib/launch-flags")
    expect(CANDY_MLB_PUBLIC, "this arm describes the flag ON").toBe(true)
    expect(s.some((x: any) => x.url === `${BASE}/insights/candy-mlb`)).toBe(true)
    // Non-vacuity: the walker has to be seeing a real skeleton, not an empty one.
    expect(s.length).toBeGreaterThan(40)
  })

  it("drops robots:noindex so the board is indexable", async () => {
    const { metadata } = await import("@/app/insights/candy-mlb/layout")
    expect(metadata.robots).toBeUndefined()
  })
})

describe("rollback direction — flipping the flag off re-gates the launch", () => {
  it("omits candy-mlb from the sitemap when the flag is off", async () => {
    vi.doMock("@/lib/launch-flags", () => ({ CANDY_MLB_PUBLIC: false, PANINI_PUBLIC: false }))
    const { buildSitemapSegment } = await import("@/lib/sitemap-data")
    const s = await buildSitemapSegment(0)
    expect(s.some((x: any) => x.url === `${BASE}/insights/candy-mlb`)).toBe(false)

    // ⭐ ROLLBACK IS A CLEAN NO-OP, asserted as a SET DIFFERENCE rather than a
    // count (see the long note on the ON arm). Flipping both flags off must
    // remove exactly the two flag-controlled boards and touch nothing else.
    //
    // ⚠ /candy-mlb/overview and /candy-mlb/market survive the rollback ON
    // PURPOSE and that is not a leak: they come from `publishedCollections()` in
    // the REGISTRY, not from launch-flags. Candy publishing (2026-09-06) and its
    // Market tab (2026-09-12) are registry decisions; CANDY_MLB_PUBLIC governs
    // the /insights board. Two different switches, and a rollback of one is not
    // a rollback of the other — worth stating because "flag off" reads like
    // "Candy is gone" and it is not.
    vi.resetModules()
    vi.doUnmock("@/lib/launch-flags")
    const { buildSitemapSegment: buildOn } = await import("@/lib/sitemap-data")
    const on = await buildOn(0)
    const onUrls = new Set(on.map((x: any) => x.url))
    const offUrls = new Set(s.map((x: any) => x.url))
    const removed = [...onUrls].filter((u) => !offUrls.has(u)).sort()
    const added = [...offUrls].filter((u) => !onUrls.has(u))
    expect(removed).toEqual([`${BASE}/insights/candy-mlb`, `${BASE}/insights/panini-squeeze`].sort())
    expect(added, "turning a launch flag OFF must never ADD a url").toEqual([])
    expect(offUrls.has(`${BASE}/candy-mlb/overview`), "registry-published, not flag-controlled").toBe(true)
    expect(offUrls.has(`${BASE}/candy-mlb/market`), "registry-published, not flag-controlled").toBe(true)
  })

  it("restores robots:noindex when the flag is off", async () => {
    vi.doMock("@/lib/launch-flags", () => ({ CANDY_MLB_PUBLIC: false, PANINI_PUBLIC: false }))
    const { metadata } = await import("@/app/insights/candy-mlb/layout")
    expect(metadata.robots).toEqual({ index: false, follow: false })
  })
})

describe("SEO invariants — independent of the flag", () => {
  it("sets a param-stripped self-canonical", async () => {
    const { metadata } = await import("@/app/insights/candy-mlb/layout")
    expect(metadata.alternates?.canonical).toBe(`${BASE}/insights/candy-mlb`)
  })

  it("does not double-suffix the title", async () => {
    const { metadata } = await import("@/app/insights/candy-mlb/layout")
    // `absolute` opts out of the root template, so the rendered <title> is
    // exactly this string. Guard against the "| Rip Packs City | Rip Packs City"
    // shape the other insights layouts produce.
    const title = (metadata.title as { absolute: string }).absolute
    expect(title.match(/Rip Packs City/g)).toHaveLength(1)
    expect(title).not.toMatch(/Rip Packs City.*Rip Packs City/)
  })

  it("points OG + Twitter at the /api/og route handler, not opengraph-image", async () => {
    const { metadata } = await import("@/app/insights/candy-mlb/layout")
    const ogUrl = (metadata.openGraph as any).images[0].url
    // The opengraph-image.tsx file convention renders 0 bytes in this app, so
    // dynamic OG must go through a route handler (memory: share-og-image-zero-bytes).
    expect(ogUrl).toBe(`${BASE}/api/og/insights/candy-mlb`)
    expect((metadata.openGraph as any).images[0].width).toBe(1200)
    expect((metadata.openGraph as any).images[0].height).toBe(630)
    expect((metadata.twitter as any).images[0]).toBe(`${BASE}/api/og/insights/candy-mlb`)
    expect((metadata.twitter as any).card).toBe("summary_large_image")
  })
})

describe("chain attribution is derived, not hardcoded (P4)", () => {
  it("reports FLOW + SOLANA now that Candy MLB is published (2026-09-06)", async () => {
    const { publishedChainsBadge } = await import("@/lib/collections")
    expect(publishedChainsBadge()).toBe("BUILT ON FLOW + SOLANA")
  })

  it("never renders a dangling 'BUILT ON'", async () => {
    const { publishedChainsBadge } = await import("@/lib/collections")
    expect(publishedChainsBadge()).toMatch(/^BUILT ON \S/)
  })

  it("names every distinct published chain once, in registry order", async () => {
    const { publishedChainsBadge, publishedCollections } = await import("@/lib/collections")
    const badge = publishedChainsBadge()
    const chains = new Set(publishedCollections().map((c) => c.dbChain).filter(Boolean))
    // One label per distinct chain — this is what makes the badge become
    // "BUILT ON FLOW + SOLANA" automatically when candy-mlb is published.
    expect(badge.replace("BUILT ON ", "").split(" + ")).toHaveLength(chains.size)
  })
})
