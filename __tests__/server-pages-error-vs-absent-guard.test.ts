import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Source guard for the "an error and an absence share a return value" defect, on
// two SERVER pages outside /insights (which has its own directory-driven guard).
//
// Neither page is measured by either coverage gate — `app/**/page.tsx` is outside
// the primary gate's include, and an async server component cannot be rendered by
// the jsdom component gate — so a source property is the only automated check
// available. Both fixes are one `ok` flag deep and trivially reverted by a future
// edit, which is exactly what this pins.
//
// 1. /[collection]/pack/[id] — `fetchLifecycle` returned a bare `null` for BOTH an
//    RPC failure and a genuinely-unknown pack. The caller then rendered
//    NotFoundCard (or redirected to a dist page), so a statement timeout told a
//    visitor that a pack which exists does not — and the card is served at HTTP
//    200, so a crawler reads it as a soft-404 for a real page. Same class the deep
//    audit found on the edition and series routes.
//
// 2. /analytics/wallets — `loadDirectory` returned `[]` on failure, which the page
//    rendered as "No wallet activity to display.": a positive claim about the loan
//    book manufactured from a database error.

function read(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8")
}

describe("server pages distinguish a failed read from an absent record", () => {
  it("pack/[id] does not collapse an RPC error into 'not found'", () => {
    const src = read("app", "(collections)", "[collection]", "pack", "[id]", "page.tsx")

    // The fetch must carry the failure out rather than returning a bare null.
    expect(src, "fetchLifecycle must report ok:false on RPC error").toContain(
      "return { lifecycle: null, ok: false }"
    )
    // ...and an absent record must be a DIFFERENT return value.
    expect(src, "an absent record must be ok:true with a null lifecycle").toContain(
      "return { lifecycle: null, ok: true }"
    )
    // The page must branch on it BEFORE the not-found / dist-redirect path.
    expect(src, "page must destructure ok from fetchLifecycle").toMatch(
      /const \{\s*lifecycle\s*,\s*ok\s*\}\s*=\s*await fetchLifecycle\(/
    )
    expect(src, "a failed read must render UnavailableCard, not NotFoundCard").toContain(
      "<UnavailableCard"
    )
    // The failure branch must come before the not-found branch, or the fix is inert.
    expect(
      src.indexOf("if (!ok) {"),
      "the !ok branch must precede the not-found/redirect branch"
    ).toBeLessThan(src.indexOf("lifecycle.status === \"unknown\""))
    // The copy must not assert non-existence.
    expect(src, "UnavailableCard must not claim the pack is absent").toContain(
      "does <strong>not</strong> mean the pack doesn&rsquo;t exist"
    )
  })

  it("analytics/wallets does not report a failed read as 'no activity'", () => {
    const src = read("app", "(analytics)", "analytics", "wallets", "page.tsx")

    expect(src, "loadDirectory must report ok:false on failure").toContain(
      "return { rows: [], ok: false }"
    )
    expect(src, "page must destructure ok").toMatch(
      /const \{\s*rows\s*,\s*ok\s*\}\s*=\s*await loadDirectory\(\)/
    )
    // The "no activity" copy must be gated on a SUCCESSFUL read.
    expect(src, "the empty-state copy must be gated on ok").toMatch(
      /\{ok\s*\n?\s*\?\s*"No wallet activity to display\./
    )
  })

  // 3. /analytics/sets/[set_id] — a THIRD instance, and the one that proved the
  //    class is not merely cosmetic: `loadSet` returned a bare `null` for both a
  //    missing set and a failed RPC, and the page answered `notFound()`.
  //
  //    This page is PRERENDERED (top-100 sets via generateStaticParams), so the
  //    conflation had two costs, not one. At request time a statement timeout
  //    told a visitor a real set does not exist. At BUILD time it was worse: on
  //    2026-08-13 a connection-pool saturation spell made the RPC block, and
  //    since Next allows each page 60s to export and retries 3x before killing
  //    the whole build, `npm run build` exited 1 and the production deploy went
  //    to ERROR state — the second time a build-time DB read has taken the
  //    production build down (the first was /insights/first-mint).
  it("analytics/sets/[set_id] does not report a failed read as 'set not found'", () => {
    const src = read("app", "(analytics)", "analytics", "sets", "[set_id]", "page.tsx")
    // ⚠ loadSet moved to lib/analytics/sets/detail-fetchers.ts on 2026-08-15, so
    // the FETCHER-side assertions read that file while the PAGE-side ones stay
    // here. Re-pointing rather than deleting: the page-side properties (which
    // branch wins, what the copy says, what the title says) are still page
    // properties, and the extraction is exactly the outcome this guard wanted —
    // the fetcher is now under the primary coverage gate too, with real
    // behavioural tests in __tests__/lib-analytics-sets-detail-fetchers.test.ts.
    const fetcherSrc = read("lib", "analytics", "sets", "detail-fetchers.ts")

    // The read must carry the failure out rather than collapsing to null.
    expect(fetcherSrc, "loadSet must report ok:false on RPC failure").toContain("return { data: null, ok: false }")
    // ...and a genuine "no such set" must be a DIFFERENT value.
    expect(fetcherSrc, "an absent set must be ok:true with null data").toContain("return { data: null, ok: true }")
    expect(src, "page must destructure ok from loadSet").toMatch(
      /const \{\s*data\s*,\s*ok\s*\}\s*=\s*await loadSet\(set_id\)/
    )
    // The failure branch must come BEFORE notFound(), or the fix is inert.
    const okBranch = src.indexOf("if (!ok) return <SetUnavailableCard")
    const notFoundBranch = src.indexOf("if (!data) notFound()")
    expect(okBranch, "the !ok branch must exist").toBeGreaterThan(-1)
    expect(okBranch, "the !ok branch must precede notFound()").toBeLessThan(notFoundBranch)
    // The copy must not assert non-existence.
    expect(src, "the unavailable card must not claim the set is absent").toContain(
      "says nothing about whether the set"
    )
    // generateMetadata must not title a failed read "Set not found" either — the
    // title is what a crawler and a shared link both read.
    expect(src, "metadata must distinguish unavailable from not-found").toContain(
      'ok ? "Set not found — Rip Packs City" : "Set unavailable — Rip Packs City"'
    )
  })

  // The BUILD-safety half of the same fix. Without a bound, a throttled DB does
  // not merely degrade this page — it fails the deploy, and an ERRORed deploy is
  // easy to miss because the next push supersedes it.
  it("analytics/sets/[set_id] bounds its build-time read below Next's export budget", () => {
    // Fetcher-side property — see the re-pointing note above.
    const src = read("lib", "analytics", "sets", "detail-fetchers.ts")

    const m = src.match(/const SET_DETAIL_TIMEOUT_MS = ([\d_]+)/)
    expect(m, "the per-page read budget must exist").toBeTruthy()
    const ms = Number(m![1].replace(/_/g, ""))
    // Comfortably under the 60s Next allows per page, with room for the render
    // itself. A budget at or above that bound protects nothing.
    expect(ms).toBeGreaterThan(0)
    expect(ms).toBeLessThanOrEqual(30_000)

    // A timeout must resolve to the FAILED shape, never the absent one — the
    // whole point is that a slow read and a broken read are equally unservable.
    const timeoutBlock = src.slice(src.indexOf("const timeout = new Promise"))
    expect(timeoutBlock).toContain("ok: false")

    // ⚠ dynamicParams is a PAGE property, not a fetcher one, so it is read from
    // the page even though the bound above lives in lib/. It is what makes the
    // bound safe at all: a page dropped from the prerender set must fall through
    // to ISR, not 404. Bounding the read WITHOUT this would trade a failed build
    // for a baked 404 — a worse outcome, quietly.
    const pageSrc = read("app", "(analytics)", "analytics", "sets", "[set_id]", "page.tsx")
    expect(pageSrc).toContain("export const dynamicParams = true")
  })

  // 4. /moment/[id] — the FOURTH instance, and the highest-stakes one, because
  //    of where it sits rather than what it does. This is the platform's most-
  //    shared URL: every moment link posted into Discord, Twitter or a DM lands
  //    here. `fetchDetail` returned a bare `null` for both "no such moment" and
  //    "the RPC failed", and the page answered `notFound()` — so a statement
  //    timeout told a collector who had just shared the link that their moment
  //    does not exist, and handed any crawler following it a hard 404.
  //
  //    ⚠ The two `ok`s here are NOT the same and must never be merged. The RPC's
  //    payload carries its own `ok` meaning "I looked and there is none" — an
  //    ANSWER, which must still 404. The envelope's `ok` means the read worked.
  it("moment/[id] does not turn a failed read into a 404", () => {
    const src = read("app", "moment", "[id]", "page.tsx")

    expect(src, "page must destructure the transport ok").toMatch(
      /const \{\s*data:\s*raw\s*,\s*ok:\s*detailOk\s*\}\s*=\s*await fetchMomentDetail\(id\)/
    )
    // The transport-failure branch must fire BEFORE the not-found branch.
    const unavailable = src.indexOf("if (!detailOk) return <MomentUnavailableCard")
    const notFoundBranch = src.indexOf("if (!detail || detail.ok === false) {")
    expect(unavailable, "the !detailOk branch must exist").toBeGreaterThan(-1)
    expect(unavailable, "it must precede the notFound() branch").toBeLessThan(notFoundBranch)
    // ...and the RPC's own verdict must STILL 404, or every genuinely-missing
    // moment renders the unavailable card instead — the mirror-image defect.
    expect(notFoundBranch, "payload.ok === false must still notFound()").toBeGreaterThan(-1)
    expect(src.slice(notFoundBranch, notFoundBranch + 120)).toContain("notFound()")

    // The copy must not assert non-existence.
    expect(src, "the card must not claim the moment is absent").toContain(
      "says nothing about whether the moment"
    )
  })

  it("moment/[id] does not let a transient failure de-index a real moment", () => {
    const src = read("app", "moment", "[id]", "page.tsx")

    // generateMetadata must branch on the same transport flag...
    expect(src).toContain('title: "Moment Unavailable — Rip Packs City"')
    // ...and mark that branch noindex,follow. Without it a crawler that hits the
    // page mid-outage can drop a real, linked moment from the index on the
    // strength of a five-minute saturation spell.
    const unavailableMeta = src.indexOf('title: "Moment Unavailable — Rip Packs City"')
    expect(src.slice(unavailableMeta, unavailableMeta + 300)).toContain(
      "robots: { index: false, follow: true }"
    )
    // The not-found copy must remain reachable for a genuine miss.
    expect(src).toContain('title: "Moment Not Found — Rip Packs City"')
  })

  // 5. /[collection]/set/[slug] — the FIFTH instance, and a variant worth naming
  //    separately, because the page had a legitimate FALLBACK and the failed read
  //    quietly took it. `fetchFullTierMix` returned a bare `[]` on a query error,
  //    and empty is exactly the signal the page uses to mean "no full-set count
  //    available for this collection — sample the first page instead". The bar
  //    renders ABSOLUTE COUNTS, so a failed read on a ~3,600-edition set published
  //    "COMMON · 62 · 62.0%" against a true ~2,200, in the same type and colour as
  //    the accurate bar. The function's own comment says it exists so the mix is
  //    "accurate even on sets with > PAGE_SIZE editions" — its failure mode
  //    silently reinstated the sampling it was written to remove.
  //
  //    ⚠ The fallback is KEPT for the case it was written for. Deleting it would
  //    be the mirror-image defect: a collection whose editions are not reachable
  //    by set_name would lose a bar it can legitimately render.
  it("set/[slug] does not sample the first page when the full-set count FAILED", () => {
    const fetcherSrc = read("lib", "set-detail", "tier-mix.ts")
    const src = read("app", "(collections)", "[collection]", "set", "[slug]", "page.tsx")

    // A failed read must be a different value from an empty one...
    expect(fetcherSrc, "a query error must report ok:false").toContain("return { rows: [], ok: false }")
    // ...and an empty result must stay ok:true, or the sample fallback dies.
    expect(fetcherSrc, "an empty-but-successful read must stay ok:true").toContain(
      "return { rows: [], ok: true }",
    )

    // The page must gate the whole bar on that flag. Anything else — including
    // passing `tierMix.rows` straight through — reinstates the defect.
    expect(src, "the bar must be gated on the read having succeeded").toMatch(
      /tierMix\.ok\s*\?\s*buildTierMixRows\(tierMix\.rows,\s*editions\)\s*:\s*\[\]/,
    )
    // ...and the page must not hold its own client for this read any more; the
    // extraction is what put the logic under the primary coverage gate.
    expect(src, "the page must not query the database inline").not.toContain("@/lib/supabase")
  })
})
