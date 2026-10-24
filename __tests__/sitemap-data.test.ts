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
  r: {} as Record<string, { data: any; error: any }> ,
  // Set by the tiebreaker test to record the ORDER KEYS a read actually used.
  orderSpy: undefined as undefined | ((col: string, table: string) => void),
  // Records every .in/.gte/.lt FILTER a read applied (the mock does not apply
  // them), so a test can assert which collections / id range a segment asked for.
  filters: [] as Array<{ table: string; op: string; col: string; val: any }>,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const b: any = { _t: table }
      for (const m of ["select", "eq", "limit", "is", "not", "ilike"]) {
        b[m] = () => b
      }
      for (const m of ["in", "gte", "lt"]) {
        b[m] = (col: string, val: any) => { h.filters.push({ table, op: m, col, val }); return b }
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
    // 2026-09-25 (batch 62): team_historic_slugs per collection; a test sets
    // h.r[<fn>] to answer, the default is an answered-empty list.
    // 2026-10-21 (#204): a thenable builder, because panini_product_set_pages is PAGED
    // (.order().range()) past the 1,000-row clamp; the window is sliced as for tables.
    rpc: (fn: string) => {
      const r: any = {}
      r.order = () => r
      r.range = (from: number, to: number) => { r._range = [from, to]; return r }
      r.then = (resolve: any, reject: any) => {
        const res = h.r[fn] ?? { data: [], error: null }
        const out = res.error || !Array.isArray(res.data) || !r._range ? res : { data: res.data.slice(r._range[0], r._range[1] + 1), error: null }
        return Promise.resolve(out).then(resolve, reject)
      }
      return r
    },
  }),
}))

// Imported AFTER the mock is registered (vi.mock is hoisted regardless).
import { buildSitemapSegment, SITEMAP_SEGMENT_IDS, PANINI_SHARDS, MAX_URLS_PER_SITEMAP } from "@/lib/sitemap-data"

const BASE = "https://www.rippackscity.com"
const TS_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const AD_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const ALLDAY_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"

function ok(data: any) {
  return { data, error: null }
}
function err(message: string) {
  return { data: null, error: { message } }
}

beforeEach(() => {
  h.filters = []
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
  it("declares the 5 original children plus the four Panini edition shards (2026-10-14)", () => {
    expect(SITEMAP_SEGMENT_IDS).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  })
})

const PANINI_ID = "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b"

describe("Panini edition shards (segments 5-8) — the 50,000-URL cap, 2026-10-14", () => {
  it("segment 2 no longer reads Panini (it took segment 2 to 37,659 URLs and climbing)", async () => {
    await buildSitemapSegment(2)
    const ins = h.filters.filter((f) => f.table === "editions" && f.op === "in")
    expect(ins).toHaveLength(1)
    expect(ins[0].val).not.toContain(PANINI_ID)
    expect(ins[0].val).not.toContain(TS_ID)
    expect(ins[0].val).toContain(ALLDAY_ID)
  })

  it("each shard reads ONLY Panini, over its own id range", async () => {
    for (const { segment, range } of PANINI_SHARDS) {
      h.filters = []
      await buildSitemapSegment(segment)
      const ed = h.filters.filter((f) => f.table === "editions")
      expect(ed.find((f) => f.op === "in")?.val).toEqual([PANINI_ID])
      expect(ed.find((f) => f.op === "gte")?.val).toBe(range.gte)
      expect(ed.find((f) => f.op === "lt")?.val).toBe(range.lt)
    }
  })

  it("the shards tile the whole uuid space: contiguous, no gap, no overlap, both ends open", () => {
    expect(PANINI_SHARDS[0].range.gte).toBeUndefined()
    expect(PANINI_SHARDS[PANINI_SHARDS.length - 1].range.lt).toBeUndefined()
    for (let i = 1; i < PANINI_SHARDS.length; i++) {
      expect(PANINI_SHARDS[i].range.gte).toBe(PANINI_SHARDS[i - 1].range.lt)
    }
  })

  it("a shard emits Panini edition URLs", async () => {
    h.t.editions = ok([
      { id: "0aa", external_id: "packcard-1_2_3_4", collection_id: PANINI_ID, updated_at: null, player_name: "P", set_name: "S", team_name: null },
    ])
    const s = await buildSitemapSegment(5)
    expect(s.map((e) => e.url)).toEqual([`${BASE}/panini-blockchain/edition/packcard-1_2_3_4`])
  })

  it("REFUSES a segment over the cap instead of publishing a file Google rejects whole", async () => {
    const rows = Array.from({ length: MAX_URLS_PER_SITEMAP + 1 }, (_, i) => ({
      id: `id${i}`, external_id: `slug-${i}`, collection_id: ALLDAY_ID, updated_at: null, player_name: null, set_name: null, team_name: null,
    }))
    h.t.editions = ok(rows)
    await expect(buildSitemapSegment(2)).rejects.toThrow(/over the 50000-URL cap/)
  })

  it("NO-CHANGE CONTROL: exactly the cap is still served", async () => {
    const rows = Array.from({ length: MAX_URLS_PER_SITEMAP }, (_, i) => ({
      id: `id${i}`, external_id: `slug-${i}`, collection_id: ALLDAY_ID, updated_at: null, player_name: null, set_name: null, team_name: null,
    }))
    h.t.editions = ok(rows)
    await expect(buildSitemapSegment(2)).resolves.toHaveLength(MAX_URLS_PER_SITEMAP)
  })

  it("segment 3 reads past 60,000 editions (the old maxRows that would have 503'd it ~10-20)", async () => {
    const rows = Array.from({ length: 61000 }, (_, i) => ({
      id: `id${i}`, external_id: `slug-${i}`, collection_id: ALLDAY_ID, updated_at: null, player_name: null, set_name: null, team_name: null,
    }))
    h.t.editions = ok(rows)
    await expect(buildSitemapSegment(3)).resolves.toBeDefined()
  })
})

describe("segment 0 — static + insights + overviews + series + profiles", () => {
  it("emits the fixed static/insights/feature skeleton with no DB rows", async () => {
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
    // 74 -> 75 on 2026-09-06: Candy MLB published (thin, overview only) adds
    // /candy-mlb/overview to the feature pages.
    // 75 -> 74 on 2026-09-07: /pricing left the sitemap with its footer link
    // (static 10 -> 9). Pinned below as an absence, not just a count.
    // 74 -> 73 on 2026-09-07: UFC's `sniper` was RETIRED from the registry
    // (Trevor — "there is no market currently"; the Flow market closed
    // 2026-05-13), so /ufc/sniper stops being advertised. The count is derived
    // from `pages` ∩ PUBLIC_TAB_PAGES, so this moved on its own — the number
    // below is the RECORD of that, not the cause. Pinned as an absence too.
    // 73 → 74 on 2026-09-12: Candy MLB gained a real Market tab (/api/market now
    // dispatches its collection id to a Solana arm), and segment 0 derives tab
    // URLs from `pages` ∩ PUBLIC_TAB_PAGES — so /candy-mlb/market entered the
    // sitemap the moment the registry changed, with no edit here. That coupling
    // is the feature: it is what made the anon-gating arm in
    // sitemap-urls-are-anon-public.test.ts fire on the same commit, catching
    // that proxy.ts would have 302'd the new URL to /login for Googlebot.
    // 74 → 75 on 2026-09-19: Candy MLB gained its Collection tab. Same derived
    // coupling as 09-12 — `pages` grew, so /candy-mlb/collection entered segment 0
    // by itself and this number is the record, not the cause. The tab shipped
    // because a route-by-route sweep found the data path was already Solana-safe
    // and only Flow-shaped GATES in front of it were failing (7 routes fixed);
    // proxy.ts's anon rule gained a second member in the same commit, which is
    // what keeps sitemap-urls-are-anon-public.test.ts green.
    // 75 → 76 on 2026-09-20: Candy MLB gained its Analytics tab. Same derived
    // coupling for the third time — `pages` grew, /candy-mlb/analytics entered
    // segment 0 by itself, and this number is the record. The tab shipped after
    // a per-panel sweep against live Candy rows (31 daily volume rows, 1,564
    // sales in 30 d, 125 priced editions, ~1,900 live asks) plus TWO silent-empty
    // fixes it needed first: shortSlug() was handing the RPCs a hyphen slug they
    // key nothing on, and analytics_listings_summary read only `cached_listings`,
    // where Candy has zero rows. proxy.ts's Candy anon rule gained a third member
    // in the same commit and `analytics` left THIN_COLLECTION_MISSING_TABS.
    // 76 → 77 on 2026-09-20: Disney Pinnacle gained its Sets tab — the last
    // per-collection gap on that tab (routes-and-surfaces.md had recorded
    // "`sets`: all except Pinnacle" since the IA reorg). Same derived coupling
    // as the three Candy entries above: `pages` grew and /disney-pinnacle/sets
    // entered segment 0 by itself, so this number is the RECORD, not the cause.
    // The tab shipped with its own backend (/api/pinnacle-set-progress) because
    // Pinnacle has ZERO rows in `editions`/`sets` and the generic /api/sets-db
    // answered every wallet "0 sets" out of a join that matched nothing.
    // 77 → 76 on 2026-09-24: /nba/fast-break LEFT the static list while
    // app/nba/fast-break/layout.tsx redirect()s it to "/" (parked 09-23,
    // known-issues #8) — a sitemap entry that 307s is crawl waste. It returns
    // with the redirect's removal.
    // 76 → 77 on 2026-09-25: /teams, the team-hub directory (app/teams/page.tsx),
    // entered the static list. The hubs it links stay out (noindex while one
    // collection per league — hubIsIndexable).
    // 77 → 78 on 2026-09-25: Candy MLB gained its Sets tab (/api/candy-set-progress,
    // its own Solana backend). Same derived coupling: `pages` grew and
    // /candy-mlb/sets entered segment 0 by itself.
    // 78 → 79 on 2026-09-25: Candy MLB gained its Packs tab (/api/candy-pack-market,
    // its native pack plane). Same derived coupling.
    // 79 → 81 on 2026-09-25: Panini PUBLISHED (Overview + Market). Same derived
    // coupling: /panini-blockchain/overview + /panini-blockchain/market entered
    // segment 0 by themselves.
    // 81 → 82 on 2026-09-27: Panini gained its Packs tab (/api/panini-pack-market,
    // its native pack plane). Same derived coupling.
    // 82 → 83 on 2026-09-27: Panini gained its Sets tab (/api/panini-set-progress).
    // 83 → 84 on 2026-09-27: Panini gained its Collection tab (by username).
    // 84 → 85 on 2026-09-28: Panini gained its Sniper tab (panini-boards deal snapshot).
    // 85 → 86 on 2026-09-28: Panini gained its Analytics tab (panini_sales).
    // 86 → 87 on 2026-09-28: /sniper, the cross-collection Sniper hub (the bottom
    // bar's SNIPER tab), entered the static list.
    // 87 → 88 on 2026-09-28: /market, the cross-collection Market hub.
    // 88 → 89 on 2026-10-03: /insights/market-cap (market cap on collector-held supply).
    // 89 → 90 on 2026-10-10: /insights/panini-premiums (Panini parallel + serial premiums).
    // 90 → 91 on 2026-10-14: /blog/premium-chance-hit-vs-chance-hit.
    // 91 → 92 on 2026-10-19: /insights/autographs (signed Top Shot / All Day editions).
    expect(s).toHaveLength(92)
    expect(s.find((x) => x.url === `${BASE}/insights/autographs`)).toBeTruthy()
    expect(s.find((x) => x.url === `${BASE}/sniper`)).toBeTruthy()
    expect(s.find((x) => x.url === `${BASE}/market`)).toBeTruthy()
    expect(s.find((x) => x.url === `${BASE}/panini-blockchain/analytics`)).toBeTruthy()
    expect(s.find((x) => x.url === `${BASE}/panini-blockchain/sniper`)).toBeTruthy()
    expect(s.find((x) => x.url === `${BASE}/panini-blockchain/collection`)).toBeTruthy()
    expect(s.find((x) => x.url === `${BASE}/panini-blockchain/packs`)).toBeTruthy()
    expect(s.find((x) => x.url === `${BASE}/panini-blockchain/sets`)).toBeTruthy()
    expect(s.find((x) => x.url === `${BASE}/panini-blockchain/overview`)).toBeTruthy()
    expect(s.find((x) => x.url === `${BASE}/panini-blockchain/market`)).toBeTruthy()
    // Negative control (was /sniper until 2026-09-28): a retired Panini tab stays out.
    expect(s.find((x) => x.url === `${BASE}/panini-blockchain/pack-sniper`)).toBeUndefined()
    expect(s.find((x) => x.url === `${BASE}/teams`)).toBeDefined()
    expect(s.find((x) => x.url === `${BASE}/pricing`)).toBeUndefined()
    expect(s.find((x) => x.url === `${BASE}/nba/fast-break`)).toBeUndefined()
    expect(s.find((x) => x.url === `${BASE}/ufc/sniper`)).toBeUndefined()
    // ⚠ PRESENCE, not just the count — a bare length pin is satisfied by ANY
    // 76th URL, so each Candy tab that entered the sitemap is named here. That
    // is what makes the anon-gating arm in sitemap-urls-are-anon-public.test.ts
    // meaningful: it can only check a URL the sitemap actually advertises.
    expect(s.find((x) => x.url === `${BASE}/candy-mlb/analytics`)).toBeTruthy()
    expect(s.find((x) => x.url === `${BASE}/candy-mlb/market`)).toBeTruthy()
    expect(s.find((x) => x.url === `${BASE}/candy-mlb/collection`)).toBeTruthy()
    expect(s.find((x) => x.url === `${BASE}/candy-mlb/sets`)).toBeTruthy()
    expect(s.find((x) => x.url === `${BASE}/disney-pinnacle/sets`)).toBeTruthy()
    // …and the pages Pinnacle still does NOT expose stay out.
    expect(s.find((x) => x.url === `${BASE}/disney-pinnacle/play`)).toBeUndefined()
    // …and the tabs Candy does NOT have stay out (the complement proxy.ts
    // redirects). A sitemap entry for one is a login redirect handed to a crawler.
    expect(s.find((x) => x.url === `${BASE}/candy-mlb/sniper`)).toBeUndefined()
    expect(s.find((x) => x.url === `${BASE}/candy-mlb/packs`)).toBeTruthy()
    // …and the no-change control: the other collections still advertise theirs.
    expect(s.find((x) => x.url === `${BASE}/nba-top-shot/sniper`)).toBeTruthy()
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

  // 2026-10-17: a series MEASURED at 0 editions is noindex on its page, so it
  // must not be advertised (Search Console: "Submitted URL marked noindex").
  describe("series measured at 0 editions are left out", () => {
    const UFC_ID = "9b4824a8-736d-4a96-b450-8dcc0c46b023"
    beforeEach(() => {
      h.t.collection_series = ok([
        { display_label: "Series 0", collection_id: UFC_ID, series_number: 0 },
        { display_label: "Series 1", collection_id: UFC_ID, series_number: 1 },
        { display_label: "Series 2", collection_id: UFC_ID, series_number: 2 },
      ])
    })
    const seriesUrls = async () => (await buildSitemapSegment(0)).map((x) => x.url).filter((u) => u.includes("/series/"))

    it("drops the series whose rollup edition_count is 0", async () => {
      h.t.series_detail_rollup = ok([{ collection_id: UFC_ID, series_number: 0, edition_count: 0 }])
      const urls = await seriesUrls()
      expect(urls).not.toContain(`${BASE}/ufc/series/series-0`)
      expect(urls).toContain(`${BASE}/ufc/series/series-1`)
      expect(urls).toContain(`${BASE}/ufc/series/series-2`)
    })

    it("keeps a series with NO rollup row — unknown is not empty", async () => {
      h.t.series_detail_rollup = ok([])
      expect(await seriesUrls()).toContain(`${BASE}/ufc/series/series-0`)
    })

    it("a failed rollup read prunes nothing (a hint, not the catalogue)", async () => {
      h.t.series_detail_rollup = err("boom")
      const urls = await seriesUrls()
      expect(urls).toContain(`${BASE}/ufc/series/series-0`)
      expect(urls).toHaveLength(3)
    })
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
    // updated_at null → none (never "now").
    expect(profiles[1].lastModified).toBeUndefined()
  })

  it("stamps NO segment-0 entry with the generation time (child-segment half of R35)", async () => {
    // Static pages, insights boards, collection tabs and the timestamp-less
    // series rows all used to carry lastModified = new Date(): /privacy and
    // /terms claimed to have changed on every fetch. A lastModified that exists
    // must be a real timestamp, which cannot be within a second of now here.
    const before = Date.now()
    const s = await buildSitemapSegment(0)
    expect(s.length).toBeGreaterThan(20)
    const stampedNow = s.filter(
      (x) => x.lastModified instanceof Date && Math.abs(x.lastModified.getTime() - before) < 60_000,
    )
    expect(stampedNow.map((x) => x.url)).toEqual([])
    const statics = s.filter((x) => /\/(privacy|terms|about|insights)$/.test(x.url))
    expect(statics.length).toBeGreaterThanOrEqual(4)
    for (const x of statics) expect(x.lastModified).toBeUndefined()
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
    // null updated_at → NO lastModified (never "now"; the route then omits
    // <lastmod>). Inverted 2026-09-25 from "defaults to a Date (now)".
    expect(s[0].lastModified).toBeUndefined()
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
      // Second edition of "A Set": a one-edition set is not listed (2026-10-14).
      { id: "m3", external_id: "1:2", collection_id: TS_ID, updated_at: null, player_name: null, set_name: "A Set", team_name: null },
    ])
    h.t.sets_summary = ok([{ collection_id: TS_ID, set_slug: "a-set" }, { collection_id: TS_ID, set_slug: "shared-set" }])
    h.t.players = ok([{ id: "p1", collection_id: TS_ID, name: "A Player" }])
    const s = await buildSitemapSegment(3)
    const moments = s.filter((x) => x.url.includes("/moment/"))
    const sets = s.filter((x) => x.url.includes("/set/"))
    const players = s.filter((x) => x.url.includes("/player/"))
    const teams = s.filter((x) => x.url.includes("/team/"))

    // 2026-09-06 (Search Console): NO /moment/<edition uuid> entries. Every one
    // canonicalises to — and now 301s to — the edition page segment 2 already
    // lists; GSC had 6,462 of them as "Alternate page with proper canonical".
    // Asserted as the ABSENCE of the URL family, not a count of something else.
    expect(moments).toEqual([])

    expect(sets.map((x) => x.url)).toEqual([`${BASE}/nba-top-shot/set/a-set`])
    expect(sets[0].priority).toBe(0.6)
    expect(players.map((x) => x.url)).toEqual([`${BASE}/nba-top-shot/player/a-player`])
    expect(players[0].priority).toBe(0.6)
    // Real franchise kept, exhibition "Team LeBron" excluded.
    expect(teams.map((x) => x.url)).toEqual([`${BASE}/nba-top-shot/team/portland-trail-blazers`])
    expect(teams[0].priority).toBe(0.55)
  })

  it("lists only sets the set page can RESOLVE (sets_summary), never one ingested after its last refresh (2026-09-30)", async () => {
    // E2E DOM smoke, 2026-09-30: /panini-blockchain/set/dominance-prizms-green
    // was listed from editions.set_name 4 minutes after the hourly sets_summary
    // refresh, and its page 404'd until the next one. Assert the ABSENCE of the
    // 404 URL, with a control that a resolvable set in the same run is kept.
    h.t.editions = ok([
      { id: "s1", external_id: "1:1", collection_id: TS_ID, updated_at: null, player_name: null, set_name: "Old Set", team_name: null },
      { id: "s2", external_id: "2:2", collection_id: TS_ID, updated_at: null, player_name: null, set_name: "Brand New Set", team_name: null },
      // Two editions each, so only routability (not the one-edition rule) decides.
      { id: "s3", external_id: "1:2", collection_id: TS_ID, updated_at: null, player_name: null, set_name: "Old Set", team_name: null },
      { id: "s4", external_id: "2:3", collection_id: TS_ID, updated_at: null, player_name: null, set_name: "Brand New Set", team_name: null },
    ])
    h.t.sets_summary = ok([{ collection_id: TS_ID, set_slug: "old-set" }])
    const sets = (await buildSitemapSegment(3)).filter((x) => x.url.includes("/set/")).map((x) => x.url)
    expect(sets).not.toContain(`${BASE}/nba-top-shot/set/brand-new-set`)
    expect(sets).toEqual([`${BASE}/nba-top-shot/set/old-set`])
  })

  it("lists Panini PRODUCT set pages (#204) with ≥2 editions, paged past 1,000 rows; a one-edition product is not listed", async () => {
    const rows = Array.from({ length: 1100 }, (_, i) => ({ slug: `p1-k-${String(i).padStart(4, "0")}`, editions: 1, last_updated_at: null }))
    rows[1050] = { slug: "p1819-base-prizms-blue", editions: 97, last_updated_at: "2026-10-21T00:00:00Z" } as any
    h.r.panini_product_set_pages = ok(rows)
    try {
      const sets = (await buildSitemapSegment(3)).filter((x) => x.url.includes("/set/")).map((x) => x.url)
      expect(sets).toEqual([`${BASE}/panini-blockchain/set/p1819-base-prizms-blue`])
    } finally {
      delete h.r.panini_product_set_pages
    }
  })

  it("a panini_product_set_pages read FAILURE rejects — never a sitemap silently missing the product pages", async () => {
    h.r.panini_product_set_pages = err("boom")
    try {
      await expect(buildSitemapSegment(3)).rejects.toThrow(SitemapReadIncomplete)
    } finally {
      delete h.r.panini_product_set_pages
    }
  })

  it("a sets_summary read FAILURE rejects — it must not fall back to listing unresolvable sets, nor publish none", async () => {
    h.t.editions = ok([{ id: "s1", external_id: "1:1", collection_id: TS_ID, updated_at: null, player_name: null, set_name: "Old Set", team_name: null }])
    h.t.sets_summary = err("boom")
    await expect(buildSitemapSegment(3)).rejects.toThrow(SitemapReadIncomplete)
  })

  it("pages sets_summary past PostgREST's 1,000-row cap — a set on the second page is still listed", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({ collection_id: TS_ID, set_slug: `s-${String(i).padStart(4, "0")}` }))
    h.t.sets_summary = ok(rows)
    h.t.editions = ok([
      { id: "p1", external_id: "1:1", collection_id: TS_ID, updated_at: null, player_name: null, set_name: "S 1150", team_name: null },
      { id: "p2", external_id: "1:2", collection_id: TS_ID, updated_at: null, player_name: null, set_name: "S 1150", team_name: null },
    ])
    const sets = (await buildSitemapSegment(3)).filter((x) => x.url.includes("/set/")).map((x) => x.url)
    expect(sets).toEqual([`${BASE}/nba-top-shot/set/s-1150`])
  })

  it("does NOT list a ONE-edition set (a near-duplicate of its edition page), with a two-edition control (2026-10-14)", async () => {
    const UFC_ID = "9b4824a8-736d-4a96-b450-8dcc0c46b023"
    h.t.editions = ok([
      { id: "u1", external_id: "aaaa-1", collection_id: UFC_ID, updated_at: null, player_name: "Fighter A", set_name: "UFC 237 KO/TKO", team_name: null },
      { id: "u2", external_id: "bbbb-2", collection_id: UFC_ID, updated_at: null, player_name: "Fighter B", set_name: "UFC 300 Base", team_name: null },
      { id: "u3", external_id: "cccc-3", collection_id: UFC_ID, updated_at: null, player_name: "Fighter C", set_name: "UFC 300 Base", team_name: null },
    ])
    h.t.sets_summary = ok([{ collection_id: UFC_ID, set_slug: "ufc-237-ko-tko" }, { collection_id: UFC_ID, set_slug: "ufc-300-base" }])
    h.t.players = ok([
      { id: "f1", collection_id: UFC_ID, name: "Fighter A" },
      { id: "f2", collection_id: UFC_ID, name: "Fighter B" },
      { id: "f3", collection_id: UFC_ID, name: "Fighter C" },
    ])
    const s = await buildSitemapSegment(3)
    const sets = s.filter((x) => x.url.includes("/set/")).map((x) => x.url)
    expect(sets).not.toContain(`${BASE}/ufc/set/ufc-237-ko-tko`)
    expect(sets).toEqual([`${BASE}/ufc/set/ufc-300-base`])
    // The one-edition set's PLAYER is still listed — only the set URL is dropped.
    expect(s.map((x) => x.url)).toContain(`${BASE}/ufc/player/fighter-a`)
  })

  it("routes a TEAM Moment (player_name === team_name) to /team/ only, never /player/ — and unaccents player slugs", async () => {
    // Measured 2026-09-06: 57 of 1,413 sitemap player URLs 404'd; 44 were
    // franchises stored as player_name (Squad Goals / Season Rewind / WNBA
    // Skyline) with no `players` row, 4 were diacritics ("Vít Krejčí" → the
    // slug "v-t-krej-" resolves nothing). Assert the ABSENCE of the 404 URL.
    h.t.editions = ok([
      { id: "t1", external_id: "3:3", collection_id: TS_ID, updated_at: null, player_name: "Dallas Wings", set_name: "WNBA Skyline", team_name: "Dallas Wings" },
      { id: "t2", external_id: "4:4", collection_id: TS_ID, updated_at: null, player_name: "Vít Krejčí", set_name: "Base Set", team_name: "Atlanta Hawks" },
    ])
    // The players row spells the name without the accent (measured 2026-09-06: the
    // label and the row disagree on diacritics) — slugifyPlayerName folds both to one key.
    h.t.players = ok([{ id: "p2", collection_id: TS_ID, name: "Vit Krejci" }])
    const s = await buildSitemapSegment(3)
    const players = s.filter((x) => x.url.includes("/player/")).map((x) => x.url)
    const teams = s.filter((x) => x.url.includes("/team/")).map((x) => x.url).sort()
    expect(players).not.toContain(`${BASE}/nba-top-shot/player/dallas-wings`)
    expect(players).not.toContain(`${BASE}/nba-top-shot/player/v-t-krej-`)
    expect(players).toEqual([`${BASE}/nba-top-shot/player/vit-krejci`])
    expect(teams).toEqual([`${BASE}/nba-top-shot/team/atlanta-hawks`, `${BASE}/nba-top-shot/team/dallas-wings`])
  })

  it("lists only players the player page can RESOLVE (a players row) — a label whose row the minter has not created yet is NOT listed (2026-10-23)", async () => {
    // 2026-10-23 3:27 PM PT: the deployment smoke discovered /nba-top-shot/player/keaton-wagler
    // from this sitemap and got a 404 — his 4 Rookie Debut editions had landed at 3:29 PM, his
    // `players` row was due at the daily 2:50 AM PT minter. Assert the ABSENCE of the 404 URL,
    // with a resolvable control from the same edition rows.
    h.t.editions = ok([
      { id: "r1", external_id: "9:1", collection_id: TS_ID, updated_at: "2026-10-23T22:29:00.000Z", player_name: "Keaton Wagler", set_name: "Rookie Debut", team_name: "Toronto Raptors" },
      { id: "r2", external_id: "9:2", collection_id: TS_ID, updated_at: "2026-10-23T22:29:00.000Z", player_name: "Cameron Boozer", set_name: "Rookie Debut", team_name: "Utah Jazz" },
      { id: "r3", external_id: "9:3", collection_id: TS_ID, updated_at: null, player_name: "Cameron Boozer", set_name: "Rookie Debut", team_name: "Utah Jazz" },
    ])
    h.t.players = ok([{ id: "p5", collection_id: TS_ID, name: "Cameron Boozer" }])
    const s = await buildSitemapSegment(3)
    const players = s.filter((x) => x.url.includes("/player/")).map((x) => x.url)
    expect(players).not.toContain(`${BASE}/nba-top-shot/player/keaton-wagler`)
    expect(players).toEqual([`${BASE}/nba-top-shot/player/cameron-boozer`])
    // The set and team URLs from the same rows are unaffected by the player filter.
    expect(s.map((x) => x.url)).toContain(`${BASE}/nba-top-shot/team/toronto-raptors`)
  })

  it("a players read FAILURE rejects — it must not fall back to listing every label, nor publish no players", async () => {
    h.t.editions = ok([
      { id: "r1", external_id: "9:1", collection_id: TS_ID, updated_at: null, player_name: "Cameron Boozer", set_name: "Rookie Debut", team_name: "Utah Jazz" },
    ])
    h.t.players = err("canceling statement due to statement timeout")
    await expect(buildSitemapSegment(3)).rejects.toThrow(/players read failed/)
  })

  it("pages players past PostgREST's 1,000-row cap — a player on the second page is still listed", async () => {
    const rows = Array.from({ length: 1100 }, (_, i) => ({ id: `p-${String(i).padStart(4, "0")}`, collection_id: TS_ID, name: `Filler ${i}` }))
    rows[1050] = { id: "p-1050", collection_id: TS_ID, name: "Second Page Player" }
    h.t.players = ok(rows)
    h.t.editions = ok([
      { id: "r1", external_id: "9:1", collection_id: TS_ID, updated_at: null, player_name: "Second Page Player", set_name: "Base Set", team_name: "Utah Jazz" },
    ])
    const s = await buildSitemapSegment(3)
    expect(s.filter((x) => x.url.includes("/player/")).map((x) => x.url)).toEqual([`${BASE}/nba-top-shot/player/second-page-player`])
  })

  it("lists a player whose edition label is a registered ALIAS under the canonical slug, never under the URL that 308s (2026-09-25, #139)", async () => {
    // After the Curry and #139 merges 31 alias slugs exist (stephen-curry,
    // patrick-mahomes-ii, jimmy-butler, …). The edition labels keep the source's
    // spelling, so a label-derived sitemap advertised the redirecting URL.
    h.t.editions = ok([
      { id: "a1", external_id: "5:5", collection_id: TS_ID, updated_at: "2026-09-01T00:00:00.000Z", player_name: "Jimmy Butler", set_name: "Base Set", team_name: "Miami Heat" },
      { id: "a2", external_id: "6:6", collection_id: TS_ID, updated_at: "2026-09-20T00:00:00.000Z", player_name: "Jimmy Butler III", set_name: "Base Set", team_name: "Golden State Warriors" },
      { id: "a3", external_id: "7:7", collection_id: TS_ID, updated_at: null, player_name: "Gary Payton", set_name: "Base Set", team_name: "Seattle SuperSonics" },
    ])
    h.t.player_name_aliases = ok([
      { collection_id: TS_ID, alias_slug: "jimmy-butler", players: { name: "Jimmy Butler III" } },
    ])
    // Only the canonical row exists — "Jimmy Butler" is an alias, not a row — so the
    // alias label must be matched through the canonical slug, not dropped.
    h.t.players = ok([
      { id: "p3", collection_id: TS_ID, name: "Jimmy Butler III" },
      { id: "p4", collection_id: TS_ID, name: "Gary Payton" },
    ])
    const s = await buildSitemapSegment(3)
    const players = s.filter((x) => x.url.includes("/player/"))
    const urls = players.map((x) => x.url).sort()
    expect(urls).not.toContain(`${BASE}/nba-top-shot/player/jimmy-butler`)
    expect(urls).toEqual([`${BASE}/nba-top-shot/player/gary-payton`, `${BASE}/nba-top-shot/player/jimmy-butler-iii`])
    // the folded entry keeps the newest lastModified of both labels
    const butler = players.find((x) => x.url.endsWith("/jimmy-butler-iii"))!
    expect((butler.lastModified as Date).toISOString()).toBe("2026-09-20T00:00:00.000Z")
    delete h.t.player_name_aliases
  })

  it("drops a team label that 308s to its franchise's primary page — the historic era is on that page (2026-09-25, batch 62)", async () => {
    h.t.editions = ok([
      { id: "a1", external_id: "5:5", collection_id: AD_ID, updated_at: "2026-09-01T00:00:00.000Z", player_name: "Derek Carr", set_name: "Base", team_name: "Las Vegas Raiders" },
      { id: "a2", external_id: "6:6", collection_id: AD_ID, updated_at: "2026-09-20T00:00:00.000Z", player_name: "Charles Woodson", set_name: "Legends", team_name: "Oakland Raiders" },
      { id: "a3", external_id: "7:7", collection_id: AD_ID, updated_at: null, player_name: "Russell Wilson", set_name: "Base", team_name: "Denver Broncos" },
    ])
    h.r.team_historic_slugs = { data: ["oakland-raiders", "los-angeles-raiders"], error: null }
    const s = await buildSitemapSegment(3)
    const teams = s.filter((x) => x.url.includes("/team/")).map((x) => x.url).sort()
    expect(teams).not.toContain(`${BASE}/nfl-all-day/team/oakland-raiders`)
    expect(teams).toEqual([`${BASE}/nfl-all-day/team/denver-broncos`, `${BASE}/nfl-all-day/team/las-vegas-raiders`])
    delete h.r.team_historic_slugs
  })

  it("a failed historic-team read fails the segment rather than listing redirecting URLs (2026-09-25, batch 62)", async () => {
    h.t.editions = ok([
      { id: "a1", external_id: "5:5", collection_id: AD_ID, updated_at: null, player_name: "Derek Carr", set_name: "Base", team_name: "Las Vegas Raiders" },
    ])
    try {
      h.r.team_historic_slugs = { data: null, error: { message: "canceling statement due to statement timeout" } }
      await expect(buildSitemapSegment(3)).rejects.toThrow(/team_historic_slugs\([a-z-]+\) read failed: canceling statement/)
      // a non-list answer is not an answered-empty either
      h.r.team_historic_slugs = { data: null, error: null }
      await expect(buildSitemapSegment(3)).rejects.toThrow(/returned no list/)
    } finally {
      delete h.r.team_historic_slugs
    }
  })

  it("a failed alias read fails the segment rather than listing redirecting URLs (2026-09-25)", async () => {
    h.t.editions = ok([
      { id: "a1", external_id: "5:5", collection_id: TS_ID, updated_at: null, player_name: "Jimmy Butler", set_name: "Base Set", team_name: "Miami Heat" },
    ])
    h.t.player_name_aliases = { data: null, error: { message: "canceling statement due to statement timeout" } }
    await expect(buildSitemapSegment(3)).rejects.toThrow(/player_name_aliases read failed/)
    delete h.t.player_name_aliases
  })

  it("dedupes entity slugs keeping the most-recent lastModified", async () => {
    h.t.editions = ok([
      { id: "x1", external_id: "1:1", collection_id: TS_ID, updated_at: "2026-06-01T00:00:00.000Z", player_name: null, set_name: "Shared Set", team_name: null },
      { id: "x2", external_id: "2:2", collection_id: TS_ID, updated_at: "2026-07-10T00:00:00.000Z", player_name: null, set_name: "Shared Set", team_name: null },
    ])
    h.t.sets_summary = ok([{ collection_id: TS_ID, set_slug: "a-set" }, { collection_id: TS_ID, set_slug: "shared-set" }])
    const s = await buildSitemapSegment(3)
    const sets = s.filter((x) => x.url.includes("/set/"))
    expect(sets).toHaveLength(1)
    expect((sets[0].lastModified as Date).toISOString()).toBe("2026-07-10T00:00:00.000Z")
  })

  it("emits no /moment/ URL at any population size (the 200-cap block is gone, not merely capped)", async () => {
    h.t.editions = ok(
      Array.from({ length: 250 }, (_, i) => ({
        id: `m${i}`, external_id: `${i}:0`, collection_id: TS_ID, updated_at: null,
        player_name: null, set_name: "A Set", team_name: null,
      }))
    )
    h.t.sets_summary = ok([{ collection_id: TS_ID, set_slug: "a-set" }, { collection_id: TS_ID, set_slug: "shared-set" }])
    const s = await buildSitemapSegment(3)
    expect(s.filter((x) => x.url.includes("/moment/"))).toHaveLength(0)
    // …while the segment still emits SOMETHING for those rows (a walk that
    // found nothing would pass the assertion above vacuously).
    expect(s.length).toBeGreaterThan(0)
  })

  // 2026-10-23: the cross-collection hubs became indexable on 10-22 evening
  // (player hubs; franchise hubs once their Panini panel counts) and the sitemap
  // did not list them. Both readers are set-returning RPCs, PAGED past the
  // 1,000-row clamp; a failed read fails the segment (never a partial list).
  it("lists the indexable player hubs (/players/<slug>) and franchise hubs (/teams/<league>/<slug>), paged past 1,000 rows, with no fabricated lastModified (2026-10-23)", async () => {
    const players = Array.from({ length: 1100 }, (_, i) => ({ slug: `hub-${String(i).padStart(4, "0")}` }))
    players[1050] = { slug: "damian-lillard" }
    h.r.list_indexable_player_hubs = ok(players)
    h.r.list_indexable_franchise_hubs = ok([{ league: "MLB", slug: "tigers" }, { league: "NBA", slug: "blazers" }])
    try {
      const s = await buildSitemapSegment(3)
      const hubs = s.filter((x) => x.url.includes("/players/") || x.url.includes("/teams/"))
      expect(hubs).toHaveLength(1102)
      expect(hubs.map((x) => x.url)).toContain(`${BASE}/players/damian-lillard`)
      expect(hubs.map((x) => x.url)).toContain(`${BASE}/teams/nba/blazers`)
      expect(hubs.map((x) => x.url)).toContain(`${BASE}/teams/mlb/tigers`)
      // the league is lower-cased in the URL (franchiseHubPath), the slug kept
      expect(hubs.some((x) => x.url.includes("/teams/NBA/"))).toBe(false)
      // never "now": a hub's freshness is not carried by this read
      expect(hubs.every((x) => x.lastModified === undefined)).toBe(true)
    } finally {
      delete h.r.list_indexable_player_hubs
      delete h.r.list_indexable_franchise_hubs
    }
  })

  it("a hub-list read FAILURE (either reader) rejects — never a sitemap silently missing the hubs (2026-10-23)", async () => {
    try {
      h.r.list_indexable_player_hubs = err("canceling statement due to statement timeout")
      await expect(buildSitemapSegment(3)).rejects.toThrow(/list_indexable_player_hubs read failed: canceling statement/)
      h.r.list_indexable_player_hubs = ok([])
      h.r.list_indexable_franchise_hubs = { data: null, error: null }
      await expect(buildSitemapSegment(3)).rejects.toThrow(/list_indexable_franchise_hubs returned no list/)
    } finally {
      delete h.r.list_indexable_player_hubs
      delete h.r.list_indexable_franchise_hubs
    }
  })

  it("NO-CHANGE CONTROL: with no indexable hubs the segment still builds, listing none (2026-10-23)", async () => {
    const s = await buildSitemapSegment(3)
    expect(s.filter((x) => x.url.includes("/players/") || x.url.includes("/teams/"))).toHaveLength(0)
  })
})

describe("segment 4 — pack distributions + Pinnacle pins", () => {
  it("maps packs (collection uuid → urlSlug) and pinnacle renders, dropping null ids", async () => {
    h.t.pack_distributions = ok([
      { dist_id: "d1", collection_id: TS_ID, updated_at: null, title: "A Pack", total_minted: 1500 },
      // Null dist_id → filtered out by getPackRows.
      { dist_id: null, collection_id: TS_ID, updated_at: null, title: "A Pack", total_minted: 1500 },
      // 2026-09-07 pruning: a KNOWN tiny distribution (1–49 packs) and an
      // untitled one leave the sitemap; an UNKNOWN mint (0 / null) stays.
      { dist_id: "tiny", collection_id: TS_ID, updated_at: null, title: "Reward Pack", total_minted: 12 },
      { dist_id: "untitled", collection_id: TS_ID, updated_at: null, title: "", total_minted: 5000 },
      { dist_id: "unknown0", collection_id: TS_ID, updated_at: null, title: "Golazos-shaped", total_minted: 0 },
      { dist_id: "unknownnull", collection_id: TS_ID, updated_at: null, title: "No mint field", total_minted: null },
    ])
    h.t.pinnacle_catalog = ok([
      { render_id: "r1", updated_at: "2026-06-01T00:00:00.000Z" },
    ])
    const s = await buildSitemapSegment(4)
    const packs = s.filter((x) => x.url.includes("/pack/dist/"))
    const pins = s.filter((x) => x.url.includes("/pinnacle/moment/"))
    expect(packs.map((x) => x.url)).toEqual([
      `${BASE}/nba-top-shot/pack/dist/d1`,
      `${BASE}/nba-top-shot/pack/dist/unknown0`,
      `${BASE}/nba-top-shot/pack/dist/unknownnull`,
    ])
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

  // 2026-09-27: Disney Pinnacle's set / character / franchise pages, from the
  // same catalog read. Keys are the ones each page RESOLVES (measured live):
  // characters from the TRAIT (not the pin's name), franchises without ™.
  it("lists Pinnacle set / character / franchise pages with the keys the pages resolve", async () => {
    h.t.pack_distributions = ok([])
    h.t.pinnacle_catalog = ok([
      { render_id: "r1", updated_at: "2026-06-01T00:00:00.000Z", set_name: " Lucasfilm Ltd. • Return of the Jedi Vol.1",
        characters: ["Ewok", "Wicket W. Warrick"], franchises: ["Star Wars™"] },
      { render_id: "r2", updated_at: "2026-07-01T00:00:00.000Z", set_name: "Lucasfilm Ltd. • Return of the Jedi Vol.1",
        characters: ["Ewok"], franchises: ["Star Wars™"] },
    ])
    const s = await buildSitemapSegment(4)
    const urls = s.map((x) => x.url)
    expect(urls).toContain(`${BASE}/disney-pinnacle/set/lucasfilm-ltd-return-of-the-jedi-vol-1`)
    expect(urls).toContain(`${BASE}/disney-pinnacle/player/ewok`)
    expect(urls).toContain(`${BASE}/disney-pinnacle/player/wicket-w-warrick`)
    expect(urls).toContain(`${BASE}/disney-pinnacle/team/star-wars`)
    expect(urls.some((u) => u.endsWith("/team/star-wars-"))).toBe(false)
    // One URL per entity, dated by its newest pin.
    expect(urls.filter((u) => u.endsWith("/player/ewok"))).toHaveLength(1)
    const ewok = s.find((x) => x.url.endsWith("/player/ewok"))!
    expect((ewok.lastModified as Date).toISOString()).toBe("2026-07-01T00:00:00.000Z")
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
