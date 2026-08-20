import { vi, describe, it, expect, beforeEach } from "vitest"

// BAN, BOTH DIRECTIONS: every URL lib/sitemap-data.ts emits must be anon-fetchable
// per proxy.ts `isPublicPath`, and every anon-public self-canonical feature tab
// must be emitted.
//
// ── WHY THIS FILE EXISTS: THE MIRROR WAS PROSE ─────────────────────────────
// lib/sitemap-data.ts opened with "The public surface is defined by proxy.ts
// `isPublicPath`; this file mirrors it." Nothing checked that. A mirror asserted
// in a comment is a CURATED LIST with no instrument — and it drifted:
//
//   • 2026-05-31: the header said only /<collection>/overview was anon-public.
//     TRUE at the time.
//   • 2026-07-17: proxy.ts un-gated the read-only feature tabs for anonymous
//     visitors (GET/HEAD, 5 published slugs). The header was never touched.
//   • 2026-08-20: measured — 28 URLs anon-200, robots-allowed, self-canonical,
//     each carrying bespoke per-tab SEO copy, and NONE of them in the sitemap.
//
// ⚠ The drift is silent in the direction that matters. A sitemap listing a GATED
// URL shows up in Search Console as "Page with redirect", so someone eventually
// sees it. A sitemap OMITTING a public URL produces no signal anywhere — the
// pages simply are not advertised, and the file's own comment reads as proof
// they should not be. So the "is everything listed public?" arm is not enough;
// the "is every public tab listed?" arm is the one that would have caught this.
//
// ⚠ The tab set is DERIVED on both sides — `pages` ∩ PUBLIC_TAB_PAGES here,
// the same intersection in the builder — never restated. Restating it would
// pin the two together while letting both drift away from proxy.ts, which is
// the failure this file exists to prevent, so the `isPublicPath` cross-check
// below is what actually anchors them.

const h = vi.hoisted(() => ({ t: {} as Record<string, { data: any; error: any }> }))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const b: any = { _t: table }
      for (const m of ["select", "eq", "order", "limit", "in", "is", "gte", "lt", "not", "ilike"]) b[m] = () => b
      b.range = (from: number, to: number) => { b._range = [from, to]; return b }
      b.then = (resolve: any) => {
        const res = h.t[b._t] ?? { data: [], error: null }
        if (res.error || !Array.isArray(res.data)) return resolve(res)
        return resolve({
          data: b._range ? res.data.slice(b._range[0], b._range[1] + 1) : res.data.slice(0, 1000),
          error: null,
        })
      }
      return b
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}))

import { buildSitemapSegment, SITEMAP_SEGMENT_IDS } from "@/lib/sitemap-data"
import { publishedCollections } from "@/lib/collections"
import { PUBLIC_TAB_PAGES } from "@/lib/seo"
import { isPublicPath } from "@/proxy"

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const AD = "dee28451-5d62-409e-a1ad-a83f763ac070"
const PIN = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
const ok = (d: any) => ({ data: d, error: null })

beforeEach(() => {
  // Every table returns at least one row so all 5 segments emit real URLs —
  // an empty DB would make the sweep pass over almost nothing.
  h.t = {
    editions: ok([
      { external_id: "73:2785", collection_id: TS, player_name: "Damian Lillard", set_name: "Base Set", team_name: "Portland Trail Blazers", updated_at: null },
      { external_id: "12:34", collection_id: AD, player_name: "Justin Jefferson", set_name: "Base", team_name: "Minnesota Vikings", updated_at: null },
    ]),
    collection_series: ok([{ display_label: "Series 3", collection_id: TS }]),
    profile_bio: ok([{ username: "trevor", updated_at: null }]),
    pack_distributions: ok([{ id: "p1", collection_id: TS, updated_at: null, distribution_id: "d1" }]),
    pinnacle_catalog: ok([{ edition_key: "k1", collection_id: PIN, updated_at: null }]),
  }
})

async function allSitemapPaths(): Promise<string[]> {
  const out: string[] = []
  for (const id of SITEMAP_SEGMENT_IDS) {
    for (const e of await buildSitemapSegment(id)) out.push(new URL(e.url).pathname)
  }
  return out
}

// The tabs that SHOULD be advertised, derived the same way the builder derives
// them but assembled independently here from the registry.
function expectedTabPaths(): string[] {
  const out: string[] = []
  for (const c of publishedCollections()) {
    for (const p of c.pages ?? []) {
      if (p !== "overview" && PUBLIC_TAB_PAGES.includes(p)) out.push(`/${c.id}/${p}`)
    }
  }
  return out
}

describe("every sitemap URL is anon-public, and every anon-public tab is in the sitemap", () => {
  it("the sweep sees a real population (not vacuously passing)", async () => {
    // ⚠ Asserts on the ENUMERATOR, never on the violation count — a not-vacuous
    // check has to be satisfiable at a population of ZERO violations, which is
    // where both arms below now sit. Measured 2026-08-20: 88 paths from the
    // fixtures above, 28 of them feature tabs.
    //
    // ⚠ The floors are deliberately FAR under those numbers, and that is a
    // correction of my first draft: I set them just below the measured values,
    // which made this arm red whenever the tab arm did. One arm, one job — this
    // one answers "can the walker still see anything at all", and the arms below
    // answer "is what it sees correct". A floor tuned tight enough to duplicate
    // them just doubles the noise on every real regression.
    const paths = await allSitemapPaths()
    expect(paths.length).toBeGreaterThan(40)
    expect(expectedTabPaths().length).toBeGreaterThan(15)
  })

  it("the instrument can distinguish gated from public (control, both directions)", () => {
    // ⚠ Without this the whole file could pass because `isPublicPath` returns
    // true for everything (a bad import, a refactor that inverts a branch). A
    // NULL result needs a positive control and a POSITIVE needs a no-change one,
    // so both are pinned.
    //
    // ⚠ AND A NOTE ON WHAT THIS PREDICATE ACTUALLY MEANS, because I misread it
    // while writing these controls: `isPublicPath` is "the proxy does not 302
    // this to /login", NOT "an anonymous reader can see the content".
    // `/admin/**` and `/api/admin/**` return TRUE here on purpose — they carry
    // their own RPC_ADMIN_TOKEN bearer check at the handler (proxy.ts:351-362).
    // That is exactly the right predicate for a SITEMAP arm, whose whole
    // question is "does Googlebot get a redirect", so the arm below is sound —
    // but do not lift this check into an argument that everything listed is
    // anon-READABLE. (/admin is robots-disallowed anyway and never reaches the
    // sitemap.)
    for (const p of ["/analytics/sales", "/dashboard", "/profile/edit", "/nba-top-shot/badges", "/panini-blockchain/sniper"]) {
      expect(isPublicPath(p, "GET"), `${p} must read as GATED`).toBe(false)
    }
    for (const p of ["/", "/pricing", "/insights/squeeze", "/nba-top-shot/overview"]) {
      expect(isPublicPath(p, "GET"), `${p} must read as PUBLIC`).toBe(true)
    }
  })

  it("no sitemap URL is auth-gated (would burn crawl budget as a /login redirect)", async () => {
    const gated = (await allSitemapPaths()).filter((p) => !isPublicPath(p, "GET"))
    expect(
      [...new Set(gated)],
      "these sitemap URLs 302 to /login for an anonymous Googlebot",
    ).toEqual([])
  })

  it("no anon-public self-canonical feature tab is missing from the sitemap", async () => {
    // The arm that would have caught the 2026-07-17 drift. Omission produces no
    // Search Console signal at all, so only a check can see it.
    const listed = new Set(await allSitemapPaths())
    const missing = expectedTabPaths().filter((p) => !listed.has(p))
    expect(
      missing,
      "these tabs are anon-public and indexable but the sitemap does not advertise them",
    ).toEqual([])
  })

  it("excludes the tabs that canonicalise away from themselves", async () => {
    // pack-sniper / challenges / hot-floors have no PAGE_META entry, so they
    // never call pageMetadata and emit `canonical=/<collection>` — pointing at
    // the collection root. Verified live 2026-08-20 on /nba-top-shot/challenges.
    // Listing them would ask Google to index a self-declared duplicate.
    const listed = new Set(await allSitemapPaths())
    for (const tab of ["pack-sniper", "challenges", "hot-floors"]) {
      expect(PUBLIC_TAB_PAGES, `${tab} must have no PAGE_META entry`).not.toContain(tab)
      expect(listed.has(`/nba-top-shot/${tab}`), `/nba-top-shot/${tab} must not be listed`).toBe(false)
    }
    // ...and the control in the other direction: a tab that DOES self-canonicalise
    // is listed, so the exclusion above is a decision and not an accident of the
    // builder emitting no tabs at all.
    expect(listed.has("/nba-top-shot/sniper")).toBe(true)
  })
})
