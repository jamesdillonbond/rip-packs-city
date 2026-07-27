import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { publishedCollections } from "@/lib/collections"

// lib/sitemap-data.ts::buildSitemapSegment enumerates every anon-indexable URL
// for Googlebot across 5 segment children. A regression here wastes crawl
// budget or drops real pages from the index, so these tests pin: the static +
// insights + per-collection-overview + series + profile composition (segment
// 0), the Top Shot fossil filter + edition-URL/priority mapping (segments 1-2),
// the set/player/team entity derivation with exhibition-team denylist + top-200
// moment cap (segment 3), and pack + Pinnacle pin mapping (segment 4). It also
// pins the defensive branches (Supabase query error → [], row-shape throw → [],
// missing service-role env → []). @supabase/supabase-js is mocked with a
// thenable builder whose per-table result is driven by a hoisted `t` map, reset
// each test. Counts/priorities were read from a real run, never guessed.

const h = vi.hoisted(() => ({ t: {} as Record<string, { data: any; error: any }> }))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const b: any = { _t: table }
      for (const m of ["select", "eq", "order", "limit", "in", "is", "gte", "lt", "not", "ilike"]) {
        b[m] = () => b
      }
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
  it("emits the fixed static/insights/feature skeleton (42 entries) with no DB rows", async () => {
    const s = await buildSitemapSegment(0)
    // 8 static + (1 insights index + 28 insight routes) + 5 published overviews.
    expect(s).toHaveLength(42)
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

  it("a series query error yields no series pages (defensive branch)", async () => {
    h.t.collection_series = err("boom")
    const s = await buildSitemapSegment(0)
    expect(s.some((x) => x.url.includes("/series/"))).toBe(false)
  })

  it("a profile query error yields no profile pages (defensive branch)", async () => {
    h.t.profile_bio = err("boom")
    const s = await buildSitemapSegment(0)
    expect(s.some((x) => x.url.includes("/profile/"))).toBe(false)
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

  it("a pack query error yields no pack pages but pinnacle pins still emit", async () => {
    h.t.pack_distributions = err("boom")
    h.t.pinnacle_catalog = ok([{ render_id: "r9", updated_at: null }])
    const s = await buildSitemapSegment(4)
    expect(s.some((x) => x.url.includes("/pack/dist/"))).toBe(false)
    expect(s.some((x) => x.url === `${BASE}/pinnacle/moment/r9`)).toBe(true)
  })
})

describe("defensive branches", () => {
  it("a non-iterable editions payload is caught → segment returns []", async () => {
    // data=123 makes `out.push(...rows)` throw inside fetchAllByCollection,
    // caught by getEditionRows.
    h.t.editions = ok(123 as any)
    const s = await buildSitemapSegment(1)
    expect(s).toEqual([])
  })

  it("missing SUPABASE_SERVICE_ROLE_KEY short-circuits edition enumeration to []", async () => {
    const saved = process.env.SUPABASE_SERVICE_ROLE_KEY
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    try {
      h.t.editions = ok([
        { id: "e1", external_id: "8:133", collection_id: TS_ID, updated_at: null, player_name: null, set_name: null, team_name: null },
      ])
      const s = await buildSitemapSegment(1)
      expect(s).toEqual([])
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = saved
    }
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── The remaining defensive catch arms ───────────────────────────────────────
// Every enumerator wraps its query + row mapping and returns [] on a throw, so a
// malformed payload from one table costs Googlebot that table's URLs — not the
// whole sitemap segment. The editions arm is pinned above; these are its three
// siblings, driven the same way (a non-iterable payload makes the row mapping
// throw inside the try).
describe("buildSitemapSegment — defensive catch arms", () => {
  it("a non-iterable collection_series payload drops only the series pages", async () => {
    h.t.collection_series = ok(42 as never)
    h.t.profile_bio = ok([{ username: "trevor", updated_at: null }])
    const urls = await buildSitemapSegment(0)
    expect(urls.some((u) => u.url.includes("/series/"))).toBe(false)
    // The sibling enumerator still contributed.
    expect(urls.some((u) => u.url === `${BASE}/profile/trevor`)).toBe(true)
  })

  it("a non-iterable pack_distributions payload drops only the pack pages", async () => {
    h.t.pack_distributions = ok(7 as never)
    h.t.pinnacle_catalog = ok([{ render_id: "GEN-DPIN-SIMB-S0", updated_at: null }])
    const urls = await buildSitemapSegment(4)
    expect(urls.some((u) => u.url.includes("/pack/dist/"))).toBe(false)
    expect(urls.some((u) => u.url.includes("/pinnacle/moment/"))).toBe(true)
  })

  it("a non-iterable pinnacle_catalog page drops only the pin pages", async () => {
    h.t.pinnacle_catalog = ok(9 as never)
    h.t.pack_distributions = ok([
      { dist_id: "5048", collection_id: TS_ID, updated_at: null },
    ])
    const urls = await buildSitemapSegment(4)
    expect(urls.some((u) => u.url.includes("/pinnacle/moment/"))).toBe(false)
    expect(urls.some((u) => u.url.includes("/pack/dist/5048"))).toBe(true)
  })
})
