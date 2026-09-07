// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "fs"
import path from "path"

// 2026-09-07 (Search Console pass, part three).
//
// Measured on every published collection: the five indexable client-shell
// tabs (collection / sniper / analytics / sets / market) served an anonymous
// fetch ≤ 180 chars of <main> ("Loading …") and ZERO entity links — sitemap
// URLs at priority 0.7 with nothing for a crawler to follow. /overview had the
// server-rendered `PopularOnCollection` fan-out (18 edition links + set /
// player / team / series hubs); the tabs did not.
//
// Two properties, pinned:
//   1. Each of the five tab layouts mounts <PopularOnCollection collection=…/>.
//      Source pin — a layout is an async server component and the component
//      gate cannot render one under jsdom.
//   2. The fan-out's reads are Data-Cached per collection (`unstable_cache`,
//      1 h) so six routes do not each pay two bounded reads per request — and
//      a FAILED read is neither cached for the hour nor read twice.

const ROOT = path.resolve(__dirname, "..")
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8")

const TABS = ["collection", "sniper", "analytics", "sets", "market"] as const

describe("the indexable client-shell tabs carry the server-rendered catalog fan-out", () => {
  for (const tab of TABS) {
    it(`app/(collections)/[collection]/${tab}/layout.tsx mounts PopularOnCollection with the route's collection`, () => {
      const src = read(`app/(collections)/[collection]/${tab}/layout.tsx`)
      expect(src).toMatch(/import PopularOnCollection from "@\/components\/entity\/PopularOnCollection"/)
      // Rendered with the param, not a literal — `collection={collection}` or `collection={id}`.
      expect(src).toMatch(/<PopularOnCollection collection=\{(collection|id)\} \/>/)
      // Rendered AFTER the tab's own content, never instead of it.
      expect(src.indexOf("{props.children}")).toBeGreaterThan(-1)
      expect(src.indexOf("<PopularOnCollection")).toBeGreaterThan(src.indexOf("{props.children}"))
    })
  }
  it("the overview keeps it too (the pass that added it, 2026-06-05)", () => {
    expect(read("app/(collections)/[collection]/overview/layout.tsx")).toMatch(/<PopularOnCollection collection=\{collection\} \/>/)
  })
})

// ── The cache wrapper ───────────────────────────────────────────────────────

vi.mock("@/lib/entity/popular-on-collection-fetchers", () => ({
  fetchHubRows: vi.fn(),
  fetchLinkRows: vi.fn(),
}))

// `unstable_cache` is mocked to a pass-through whose call count the tests can
// read — the real one throws its incrementalCache invariant under vitest, and
// the wrapper's FALLBACK on that throw is asserted separately below.
const cacheState = vi.hoisted(() => ({ throwInvariant: false, wrapped: 0 }))
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...a: unknown[]) => unknown) => {
    cacheState.wrapped += 1
    return async (...args: unknown[]) => {
      if (cacheState.throwInvariant) throw new Error("Invariant: incrementalCache missing in unstable_cache")
      return fn(...args)
    }
  },
}))

import { fetchHubRows, fetchLinkRows } from "@/lib/entity/popular-on-collection-fetchers"
import { loadPopularOnCollection } from "@/components/entity/PopularOnCollection"

const okLinks = { data: [{ external_id: "1:2", player_name: "A", team_name: "B", play_type: "Dunk", set_name: "S" }], ok: true }
const okHubs = { data: { editions: [{ set_name: "S", player_name: "A", team_name: "B" }], series: [{ display_label: "Series 8" }] }, ok: true }

beforeEach(() => {
  vi.mocked(fetchHubRows).mockReset()
  vi.mocked(fetchLinkRows).mockReset()
  cacheState.throwInvariant = false
})

describe("loadPopularOnCollection", () => {
  it("wraps the two reads in next/cache unstable_cache (one wrapper, created at module scope)", () => {
    expect(cacheState.wrapped).toBe(1)
  })

  it("returns both reads through the cache when they succeed", async () => {
    vi.mocked(fetchLinkRows).mockResolvedValue(okLinks as never)
    vi.mocked(fetchHubRows).mockResolvedValue(okHubs as never)
    const out = await loadPopularOnCollection("nba-top-shot")
    expect(out.linkRes.ok).toBe(true)
    expect(out.linkRes.links[0].href).toBe("/nba-top-shot/edition/1%3A2")
    expect(out.hubRes.hubs.series[0].href).toBe("/nba-top-shot/series/series-8")
    expect(vi.mocked(fetchLinkRows)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetchHubRows)).toHaveBeenCalledTimes(1)
  })

  it("a FAILED read is returned as-is (ok:false, reason kept) and is read ONCE — not retried, not cached", async () => {
    vi.mocked(fetchLinkRows).mockResolvedValue({ data: [], ok: false, reason: "Timed out acquiring connection" } as never)
    vi.mocked(fetchHubRows).mockResolvedValue(okHubs as never)
    const out = await loadPopularOnCollection("nba-top-shot")
    expect(out.linkRes.ok).toBe(false)
    expect(out.linkRes.reason).toBe("Timed out acquiring connection")
    expect(out.hubRes.ok).toBe(true)
    // ONE read each. A wrapper that caught the throw and re-ran the reads
    // would double the load exactly when the pool is exhausted.
    expect(vi.mocked(fetchLinkRows)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetchHubRows)).toHaveBeenCalledTimes(1)
  })

  it("outside a Next request scope (the cache throws its invariant) it falls back to the uncached reads", async () => {
    cacheState.throwInvariant = true
    vi.mocked(fetchLinkRows).mockResolvedValue(okLinks as never)
    vi.mocked(fetchHubRows).mockResolvedValue(okHubs as never)
    const out = await loadPopularOnCollection("nfl-all-day")
    expect(out.linkRes.ok).toBe(true)
    expect(out.linkRes.links[0].href).toBe("/nfl-all-day/edition/1%3A2")
    expect(vi.mocked(fetchLinkRows)).toHaveBeenCalledTimes(1)
  })
})
