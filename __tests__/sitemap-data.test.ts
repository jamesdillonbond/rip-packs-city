import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { publishedCollections } from "@/lib/collections"
import { SitemapReadIncomplete, assertUsableTiebreak } from "@/lib/sitemap-data"

// lib/sitemap-data.ts::buildSitemapSegment enumerates every anon-indexable URL
// for Googlebot across 5 segment children. A regression here wastes crawl
// budget or drops real pages from the index, so these tests pin: the static +
// insights + per-collection-overview + series + profile composition (segment
// 0), the Top Shot fossil filter + edition-URL/priority mapping (segments 1-2),
// the set/player/team entity derivation with exhibition-team denylist + top-200
// moment cap (segment 3), and pack + Pinnacle pin mapping (segment 4). It also
// pins what REPLACED the old defensive branches: a Supabase query error, a
// row-shape throw and a missing service-role env each REJECT with
// SitemapReadIncomplete rather than publishing an empty or partial sitemap
// (R47, 2026-08-23) — each with a no-change control that a genuinely empty
// table still resolves. @supabase/supabase-js is mocked with a
// thenable builder whose per-table result is driven by a hoisted `t` map, reset
// each test. Counts/priorities were read from a real run, never guessed.

const h = vi.hoisted(() => ({
  t: {} as Record<string, { data: any; error: any }> ,
  // Set by the tiebreaker test to record the ORDER KEYS a read actually used.
  orderSpy: undefined as undefined | ((col: string, table: string) => void),
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const b: any = { _t: table }
      for (const m of ["select", "eq", "limit", "in", "is", "gte", "lt", "not", "ilike"]) {
        b[m] = () => b
      }
      b.order = (col: string) => { h.orderSpy?.(col, table); return b }
      // .range(from,to) records the window so the thenable can slice a paged read,
      // matching real PostgREST behavior (a caller that pages 1,000-row windows
      // must see a short final page to stop). Backward-compatible: when data is a
      // small array the first window returns it whole (slice(0,1000) === all), and
      // non-array / error fixtures pass through untouched for the defensive tests.
      b.range = (from: number, to: number) => { b._range = [from, to]; return b }
      // Thenable: awaiting the chain resolves to the table's configured result,
      // emulating PostgREST's hard 1,000-row server cap — a read WITHOUT .range()
      // returns at most 1,000 rows (so a bare .limit(5000) is silently clamped,
      // the real bug), and a .range(from,to) read returns that window. Non-array /
      // error fixtures pass through untouched for the defensive tests.
      b.then = (resolve: any) => {
        const res = h.t[b._t] ?? { data: [], error: null }
        if (res.error || !Array.isArray(res.data)) return resolve(res)
        const data = b._range
          ? res.data.slice(b._range[0], b._range[1] + 1)
          : res.data.slice(0, 1000)
        return resolve({ data, error: null })
      }
      return b
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}))

// Imported AFTER the mock is registered (vi.mock is hoisted regardless).
import { buildSitemapSegment, SITEMAP_SEGMENT_IDS } from "@/lib/sitemap-data"

const BASE = "https://www.rippackscity.com"
const TS_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const ALLDAY_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"

function ok(data: any) {
  return { data, error: null }
}
function err(message: string) {
  return { data: null, error: { message } }
}

beforeEach(() => {
  // Default: every table returns an empty success. Individual tests override.
  h.t = {
    editions: ok([]),
    collection_series: ok([]),
    profile_bio: ok([]),
    pack_distributions: ok([]),
    pinnacle_catalog: ok([]),
  }
})

describe("SITEMAP_SEGMENT_IDS", () => {
  it("declares the 5 segment children", () => {
    expect(SITEMAP_SEGMENT_IDS).toEqual([0, 1, 2, 3, 4])
  })
})

describe("segment 0 — static + insights + overviews + series + profiles", () => {
  it("emits the fixed static/insights/feature skeleton (74 entries) with no DB rows", async () => {
    const s = await buildSitemapSegment(0)
    // 10 static + (1 insights index + 30 insight routes, incl. candy-mlb (live
    // 2026-07-31) + panini-squeeze (live 2026-08-01)) + 5 published overviews
    // + 28 anon-public feature tabs.
    // Static went 8 -> 10 on 2026-08-01: /pricing and /nba/fast-break were both
    // long-public (proxy.ts) but had never been enumerated here.
    // 46 -> 74 on 2026-08-20: the per-collection feature tabs un-gated by
    // proxy.ts on 2026-07-17 had never been enumerated either — same class as
    // the 08-01 addition, one month later and 28 URLs wider. The count is
    // DERIVED (each collection's `pages` ∩ lib/seo PUBLIC_TAB_PAGES), so it
    // moves when a collection gains or loses a tab; __tests__/
    // sitemap-urls-are-anon-public.test.ts is what pins the SET against
    // proxy.ts isPublicPath in both directions.
    expect(s).toHaveLength(74)
    // Root is priority 1.0, changeFrequency daily.
    expect(s[0].url).toBe(BASE)
    expect(s[0].priority).toBe(1)
    expect(s[0].changeFrequency).toBe("daily")
    // Insights index present at 0.9.
    expect(s.find((x) => x.url === `${BASE}/insights`)?.priority).toBe(0.9)
    // A representative insight route at 0.8.
    expect(s.find((x) => x.url === `${BASE}/insights/squeeze`)?.priority).toBe(0.8)
    // One overview per published collection, all at 0.9.
    const overviews = s.filter((x) => x.url.endsWith("/overview"))
    expect(overviews).toHaveLength(publishedCollections().length)
    expect(overviews.every((x) => x.priority === 0.9)).toBe(true)
    expect(s.some((x) => x.url === `${BASE}/nba-top-shot/overview`)).toBe(true)
  })

  it("appends a series page (mapped via collection uuid → urlSlug + slugified label)", async () => {
    h.t.collection_series = ok([
      { display_label: "Series 3", collection_id: TS_ID },
      // Non-empty guard: blank label is dropped.
      { display_label: "", collection_id: TS_ID },
    ])
    const s = await buildSitemapSegment(0)
    const series = s.filter((x) => x.url.includes("/series/"))
    expect(series).toHaveLength(1)
    expect(series[0].url).toBe(`${BASE}/nba-top-shot/series/series-3`)
    expect(series[0].priority).toBe(0.55)
    expect(series[0].changeFrequency).toBe("weekly")
  })

  it("appends profile pages from profile_bio, encoding the username", async () => {
    h.t.profile_bio = ok([
      { username: "trevor", updated_at: "2026-05-01T00:00:00.000Z" },
      { username: "a b", updated_at: null },
    ])
    const s = await buildSitemapSegment(0)
    const profiles = s.filter((x) => x.url.includes("/profile/"))
    expect(profiles.map((p) => p.url)).toEqual([
      `${BASE}/profile/trevor`,
      `${BASE}/profile/a%20b`,
    ])
    expect(profiles[0].priority).toBe(0.5)
    // updated_at present → concrete lastModified date.
    expect((profiles[0].lastModified as Date).toISOString()).toBe("2026-05-01T00:00:00.000Z")
  })

  it("pages profile_bio past the 1,000-row PostgREST cap (no silent truncation)", async () => {
    // 1,500 public profiles across two .range() windows (1,000 + 500). A bare
    // .limit(5000) would be clamped to 1,000 by PostgREST and silently drop the
    // last 500 profiles from the sitemap — the exact trap the paged loop avoids.
    h.t.profile_bio = ok(
      Array.from({ length: 1500 }, (_, i) => ({ username: `u${i}`, updated_at: null })),
    )
    const s = await buildSitemapSegment(0)
    const profiles = s.filter((x) => x.url.includes("/profile/"))
    expect(profiles).toHaveLength(1500)
    // The window boundary (row 1,000) and the final row both survive.
    expect(profiles.some((p) => p.url === `${BASE}/profile/u999`)).toBe(true)
    expect(profiles.some((p) => p.url === `${BASE}/profile/u1000`)).toBe(true)
    expect(profiles.some((p) => p.url === `${BASE}/profile/u1499`)).toBe(true)
  })

// ── ⚠ INVERTED 2026-08-23 (R47 / known-issues #28), NOT DELETED ─────────────
// EIGHT tests in this file asserted that a failed read yields an EMPTY or
// PARTIAL sitemap, and two of them carried the defect in their own NAME
// ("...is caught → segment returns []", "...short-circuits edition enumeration
// to []"). A sitemap is a claim about which URLs EXIST: publishing the rows we
// happened to get says the rest are gone. Measured from a production runtime
// log — segment 3 built its whole set/player/team universe from 24,000 of
// 27,121 editions after a statement timeout, served under a 200.
//
// A passing test asserting a promise is what holds that promise in place, so
// each is now inverted to the property that replaced it: the read must REJECT
// with SitemapReadIncomplete, and the route turns that into a 503 a crawler
// retries. Every case is paired with a NO-CHANGE CONTROL, because turning a
// genuinely empty table into an error is the mirror-image defect.
  it("a series read FAILURE rejects — it must not publish a sitemap without series", async () => {
    h.t.collection_series = err("boom")
    await expect(buildSitemapSegment(0)).rejects.toThrow(SitemapReadIncomplete)
  })

  it("NO-CHANGE CONTROL: a series table that is genuinely EMPTY still resolves", async () => {
    h.t.collection_series = ok([])
    h.t.profile_bio = ok([])
    const s = await buildSitemapSegment(0)
    // The static URLs still come through; only the series ones are absent, and
    // that absence is now an ANSWER rather than a failure.
    expect(s.some((x) => x.url.includes("/series/"))).toBe(false)
    expect(s.length).toBeGreaterThan(0)
  })

  it("a profile read FAILURE rejects — it must not publish a sitemap without profiles", async () => {
    h.t.profile_bio = err("boom")
    await expect(buildSitemapSegment(0)).rejects.toThrow(SitemapReadIncomplete)
  })
})

describe("segment 1 — Top Shot editions (fossil filter)", () => {
  it("maps int-pair external_ids to edition URLs and drops hyphenated TS fossils + null ids", async () => {
    h.t.editions = ok([
      { id: "e1", external_id: "8:133", collection_id: TS_ID, updated_at: "2026-07-01T00:00:00.000Z", player_name: "Dame", set_name: "Base", team_name: null },
      // Hyphenated external_id on Top Shot = dedup-merge fossil → dropped.
      { id: "e2", external_id: "abc-def-ghi", collection_id: TS_ID, updated_at: null, player_name: null, set_name: null, team_name: null },
      // Null external_id → filtered by buildEditionPages.
      { id: "e3", external_id: null, collection_id: TS_ID, updated_at: null, player_name: null, set_name: null, team_name: null },
    ])
    const s = await buildSitemapSegment(1)
    expect(s).toHaveLength(1)
    expect(s[0].url).toBe(`${BASE}/nba-top-shot/edition/8%3A133`)
    expect(s[0].priority).toBe(0.6)
    expect(s[0].changeFrequency).toBe("daily")
    expect((s[0].lastModified as Date).toISOString()).toBe("2026-07-01T00:00:00.000Z")
  })
})

describe("segment 2 — AllDay/Golazos/UFC editions (no fossil filter)", () => {
  it("keeps hyphenated non-TS slugs and builds their edition URLs", async () => {
    h.t.editions = ok([
      { id: "a1", external_id: "some-allday-slug", collection_id: ALLDAY_ID, updated_at: null, player_name: "WR", set_name: "Base", team_name: null },
    ])
    const s = await buildSitemapSegment(2)
    expect(s).toHaveLength(1)
    expect(s[0].url).toBe(`${BASE}/nfl-all-day/edition/some-allday-slug`)
    // null updated_at → lastModified defaults to a Date (now).
    expect(s[0].lastModified).toBeInstanceOf(Date)
  })
})

describe("segment 3 — set/player/team entities + top moments", () => {
  it("emits capped moment pages + distinct entity pages, excluding exhibition teams", async () => {
    h.t.editions = ok([
      {
        id: "m1", external_id: "1:1", collection_id: TS_ID, updated_at: "2026-07-01T00:00:00.000Z",
        player_name: "A Player", set_name: "A Set", team_name: "Portland Trail Blazers",
      },
      {
        id: "m2", external_id: "2:2", collection_id: TS_ID, updated_at: "2026-07-02T00:00:00.000Z",
        // Exhibition roster → team page must be suppressed; no player/set here.
        player_name: null, set_name: null, team_name: "Team LeBron",
      },
    ])
    const s = await buildSitemapSegment(3)
    const moments = s.filter((x) => x.url.includes("/moment/"))
    const sets = s.filter((x) => x.url.includes("/set/"))
    const players = s.filter((x) => x.url.includes("/player/"))
    const teams = s.filter((x) => x.url.includes("/team/"))

    // One /moment/<id> per edition, priority 0.65.
    expect(moments.map((m) => m.url).sort()).toEqual([
      `${BASE}/moment/m1`,
      `${BASE}/moment/m2`,
    ])
    expect(moments.every((m) => m.priority === 0.65)).toBe(true)

    expect(sets.map((x) => x.url)).toEqual([`${BASE}/nba-top-shot/set/a-set`])
    expect(sets[0].priority).toBe(0.6)
    expect(players.map((x) => x.url)).toEqual([`${BASE}/nba-top-shot/player/a-player`])
    expect(players[0].priority).toBe(0.6)
    // Real franchise kept, exhibition "Team LeBron" excluded.
    expect(teams.map((x) => x.url)).toEqual([`${BASE}/nba-top-shot/team/portland-trail-blazers`])
    expect(teams[0].priority).toBe(0.55)
  })

  it("dedupes entity slugs keeping the most-recent lastModified", async () => {
    h.t.editions = ok([
      { id: "x1", external_id: "1:1", collection_id: TS_ID, updated_at: "2026-06-01T00:00:00.000Z", player_name: null, set_name: "Shared Set", team_name: null },
      { id: "x2", external_id: "2:2", collection_id: TS_ID, updated_at: "2026-07-10T00:00:00.000Z", player_name: null, set_name: "Shared Set", team_name: null },
    ])
    const s = await buildSitemapSegment(3)
    const sets = s.filter((x) => x.url.includes("/set/"))
    expect(sets).toHaveLength(1)
    expect((sets[0].lastModified as Date).toISOString()).toBe("2026-07-10T00:00:00.000Z")
  })

  it("caps moment pages at 200", async () => {
    h.t.editions = ok(
      Array.from({ length: 250 }, (_, i) => ({
        id: `m${i}`, external_id: `${i}:0`, collection_id: TS_ID, updated_at: null,
        player_name: null, set_name: null, team_name: null,
      }))
    )
    const s = await buildSitemapSegment(3)
    expect(s.filter((x) => x.url.includes("/moment/"))).toHaveLength(200)
  })
})

describe("segment 4 — pack distributions + Pinnacle pins", () => {
  it("maps packs (collection uuid → urlSlug) and pinnacle renders, dropping null ids", async () => {
    h.t.pack_distributions = ok([
      { dist_id: "d1", collection_id: TS_ID, updated_at: null },
      // Null dist_id → filtered out by getPackRows.
      { dist_id: null, collection_id: TS_ID, updated_at: null },
    ])
    h.t.pinnacle_catalog = ok([
      { render_id: "r1", updated_at: "2026-06-01T00:00:00.000Z" },
    ])
    const s = await buildSitemapSegment(4)
    const packs = s.filter((x) => x.url.includes("/pack/dist/"))
    const pins = s.filter((x) => x.url.includes("/pinnacle/moment/"))
    expect(packs.map((x) => x.url)).toEqual([`${BASE}/nba-top-shot/pack/dist/d1`])
    expect(packs[0].priority).toBe(0.5)
    expect(pins.map((x) => x.url)).toEqual([`${BASE}/pinnacle/moment/r1`])
    expect(pins[0].priority).toBe(0.55)
    expect((pins[0].lastModified as Date).toISOString()).toBe("2026-06-01T00:00:00.000Z")
  })

  it("a pack read FAILURE rejects — a surviving SIBLING is not a reason to publish", async () => {
    // ⚠ The old version of this test asserted the sibling's survival as the
    // GOOD outcome. It is not: a segment carrying the pins but silently missing
    // every pack URL is exactly the partial-under-200 this file now bans.
    h.t.pack_distributions = err("boom")
    h.t.pinnacle_catalog = ok([{ render_id: "r9", updated_at: null }])
    await expect(buildSitemapSegment(4)).rejects.toThrow(SitemapReadIncomplete)
  })

  it("NO-CHANGE CONTROL: packs empty + pins present still resolves with the pins", async () => {
    h.t.pack_distributions = ok([])
    h.t.pinnacle_catalog = ok([{ render_id: "r9", updated_at: null }])
    const s = await buildSitemapSegment(4)
    expect(s.some((x) => x.url.includes("/pack/dist/"))).toBe(false)
    expect(s.some((x) => x.url === `${BASE}/pinnacle/moment/r9`)).toBe(true)
  })
})

describe("assertUsableTiebreak", () => {
  it("rejects a tiebreaker equal to the order column — it breaks no ties", () => {
    // The live one it caught: getPackRows passed 'dist_id' as both.
    expect(() => assertUsableTiebreak("pack_distributions", "dist_id", "dist_id")).toThrow(
      /must differ from orderColumn/,
    )
  })

  it("rejects a timestamp-shaped tiebreaker — it cannot be unique", () => {
    for (const bad of ["updated_at", "created_at", "sold_at", "computed_time", "some_timestamp"]) {
      expect(() => assertUsableTiebreak("editions", "player_name", bad), bad).toThrow(/timestamp-shaped/)
    }
  })

  it("NO-CHANGE CONTROL: a distinct non-timestamp key is accepted", () => {
    // Banning too much would push callers toward removing the tiebreaker.
    for (const good of ["id", "external_id", "render_id", "username"]) {
      expect(() => assertUsableTiebreak("editions", "updated_at", good), good).not.toThrow()
    }
  })
})

describe("the paging tiebreaker is checked by VALUE, not just by shape", () => {
  // 🚨 THE MUTATION THE STATIC BAN COULD NOT CATCH. The order column and the
  // tiebreaker are both PARAMETERS here, so a source-level guard sees two
  // `.order()` calls and stops. Swapping this module's `'id'` back to
  // `'updated_at'` left that ban green while restoring R47 in full — 68.4% of
  // editions rows sit in a tied `updated_at` group, largest group 1,084, wider
  // than the 1,000-row page. A shape check and a value check are different
  // guards; this file owns the value one.
  it("editions page by a tiebreaker that is NOT the order column", async () => {
    const seen: string[] = []
    h.orderSpy = (col: string, table: string) => { if (table === "editions") seen.push(col) }
    try {
      h.t.editions = ok([])
      await buildSitemapSegment(1)
    } finally {
      h.orderSpy = undefined
    }
    const cols = seen
    expect(cols, "the editions read must carry TWO order keys").toHaveLength(2)
    expect(cols[0]).toBe("updated_at")
    expect(cols[1], "the tiebreaker must not be the order column").not.toBe(cols[0])
    // ...and it must not be another timestamp wearing a different name.
    expect(cols[1]).not.toMatch(/(_at|_time|timestamp)$/i)
  })
})

describe("defensive branches", () => {
  it("a non-iterable editions payload REJECTS — the old name for this was the defect", async () => {
    // data=123 makes `out.push(...rows)` throw inside fetchAllByCollection.
    // This test used to be called "...is caught → segment returns []".
    h.t.editions = ok(123 as any)
    await expect(buildSitemapSegment(1)).rejects.toThrow(SitemapReadIncomplete)
  })

  it("a missing SUPABASE_SERVICE_ROLE_KEY REJECTS — a config gap is not an empty catalogue", async () => {
    const saved = process.env.SUPABASE_SERVICE_ROLE_KEY
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    try {
      h.t.editions = ok([
        { id: "e1", external_id: "8:133", collection_id: TS_ID, updated_at: null, player_name: null, set_name: null, team_name: null },
      ])
      await expect(buildSitemapSegment(1)).rejects.toThrow(SitemapReadIncomplete)
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = saved
    }
  })

  it("NO-CHANGE CONTROL: a genuinely empty editions table resolves to an empty segment", async () => {
    // The mirror-image defect would be to call every empty result a failure,
    // which would 503 a segment that is legitimately empty.
    h.t.editions = ok([])
    await expect(buildSitemapSegment(1)).resolves.toEqual([])
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── The remaining read arms ─────────────────────────────────────────────────
// ⚠ This block's header used to read: "Every enumerator wraps its query + row
// mapping and returns [] on a throw, so a malformed payload from one table costs
// Googlebot that table's URLs — not the whole sitemap segment." That was the
// defect stated as a design goal. Costing Googlebot "that table's URLs" is
// telling it those pages are GONE. Each arm now rejects; the route serves 503.
describe("buildSitemapSegment — defensive catch arms", () => {
  it("a non-iterable collection_series payload REJECTS rather than dropping the series pages", async () => {
    h.t.collection_series = ok(42 as never)
    h.t.profile_bio = ok([{ username: "trevor", updated_at: null }])
    await expect(buildSitemapSegment(0)).rejects.toThrow(SitemapReadIncomplete)
  })

  it("a non-iterable pack_distributions payload REJECTS rather than dropping the pack pages", async () => {
    h.t.pack_distributions = ok(7 as never)
    h.t.pinnacle_catalog = ok([{ render_id: "GEN-DPIN-SIMB-S0", updated_at: null }])
    await expect(buildSitemapSegment(4)).rejects.toThrow(SitemapReadIncomplete)
  })

  it("a non-iterable pinnacle_catalog page REJECTS rather than dropping the pin pages", async () => {
    h.t.pinnacle_catalog = ok(9 as never)
    h.t.pack_distributions = ok([
      { dist_id: "5048", collection_id: TS_ID, updated_at: null },
    ])
    await expect(buildSitemapSegment(4)).rejects.toThrow(SitemapReadIncomplete)
  })
})
