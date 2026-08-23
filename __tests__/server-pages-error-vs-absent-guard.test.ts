import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

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

/**
 * Blank out comments, preserving offsets so `indexOf` ordering still holds.
 *
 * ⚠ REQUIRED, not tidiness. This file asserts on user-visible COPY, and the
 * fixes it guards are documented by comments that QUOTE that copy to explain
 * themselves — so an ordering check reads the comment's occurrence, not the
 * render's. It bit immediately: the my-teams case below failed against correct
 * code because the comment above the failure branch quotes "Follow a team to
 * build your hub". At least the fifth instance of this trap in this repo, and
 * the second where the offending comment was written in the same commit as the
 * guard. Any check that greps source for a string must strip comments first —
 * including the one you are writing now.
 */
/*
 * ⚠ MIGRATED 2026-08-22 to the ONE shared stripper (scripts/lib/strip-comments.mjs).
 * The local copy stripped BLOCK comments before LINE comments, so an ordinary
 * line comment mentioning a glob path opened a block comment running to the next
 * close-comment anywhere in the file, blanking real source this guard then
 * reported as clean (103,590 chars across 49 product files). The shared version
 * blanks rather than deletes, so offsets and line numbers survive.
 * Do not re-inline a local copy.
 */

describe("server pages distinguish a failed read from an absent record", () => {
  // ⚠ THE READS MOVED, SO THIS CHECK MOVED WITH THEM (2026-08-22). `fetchLifecycle`
  // and `isKnownDistId` were extracted into `lib/pack-detail/lifecycle.ts` so they
  // could be BOUNDED and TESTED. Split deliberately, same as the wallets case
  // below: the PRODUCERS' contracts are checked in the module, the CONSUMER's
  // branching in the page — checking only the module would let a page that
  // stopped consulting `ok` pass, and that is the half a reader sees.
  it("pack/[id] does not collapse an RPC error into 'not found'", () => {
    const lib = read("lib", "pack-detail", "lifecycle.ts")
    const src = read("app", "(collections)", "[collection]", "pack", "[id]", "page.tsx")

    // The fetch must carry the failure out rather than returning a bare null.
    expect(lib, "fetchLifecycle must report ok:false on RPC error").toContain(
      "return { lifecycle: null, ok: false }"
    )
    // ...and an absent record must be a DIFFERENT return value.
    expect(lib, "an absent record must be ok:true with a null lifecycle").toContain(
      "return { lifecycle: null, ok: true }"
    )
    // ⚠ NEW 2026-08-22: the dist probe had the SAME defect one line below the
    // lifecycle read and was left behind — it returned a bare `false` on error,
    // which the page reads as "not a distribution" and answers with NotFoundCard.
    expect(lib, "the dist probe must report ok:false on error").toContain(
      "return { known: false, ok: false }"
    )
    expect(src, "the page must render UnavailableCard on a failed probe").toMatch(
      /const \{\s*known: isDist\s*,\s*ok: probeOk\s*\}\s*=\s*await isKnownDistId\(/
    )
    expect(src, "a failed probe must not fall through to NotFoundCard").toMatch(
      /if \(!probeOk\) \{/
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

  // ⚠ THE READ MOVED, SO THIS CHECK MOVED WITH IT (2026-08-22). `loadDirectory`
  // was extracted from the page into `lib/analytics/wallet-directory.ts` and
  // renamed `loadWalletDirectory`, so it could be BOUNDED (a read that merely
  // hangs throws nothing, so the page's own try/catch could not reach the
  // `ok: false` branch) and TESTED (`app/**/page.tsx` is measured by neither
  // coverage gate).
  //
  // ⚠ The property is unchanged and is now pinned in BOTH places on purpose: the
  // producer's contract in the module, and the CONSUMER's gating in the page.
  // Checking only the module would let a page that stopped consulting `ok` pass,
  // which is the half of this defect that actually reaches a reader.
  it("analytics/wallets does not report a failed read as 'no activity'", () => {
    const lib = read("lib", "analytics", "wallet-directory.ts")
    const src = read("app", "(analytics)", "analytics", "wallets", "page.tsx")

    expect(lib, "loadWalletDirectory must report ok:false on failure").toContain(
      "return { rows: [], ok: false }"
    )
    expect(src, "page must destructure ok").toMatch(
      /const \{\s*rows\s*,\s*ok\s*\}\s*=\s*await loadWalletDirectory\(\)/
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
    //
    // ⚠ MATCHED BY PREFIX, NOT BY THE WHOLE STRING. This assertion used to pin
    // 'title: "Moment Unavailable — Rip Packs City"' verbatim and went red on
    // 2026-08-23 when the brand suffix was stripped from every metadata title so
    // the root '%s | Rip Packs City' template could append it exactly once
    // (deep-audit R31). Nothing it guards changed. That is the documented trap:
    // pin the PROPERTY — a distinct unavailable branch, marked noindex — not the
    // spelling, which is owned by a different rule entirely.
    const UNAVAILABLE = 'title: "Moment Unavailable'
    const NOT_FOUND = 'title: "Moment Not Found'
    expect(src).toContain(UNAVAILABLE)
    // ...and mark that branch noindex,follow. Without it a crawler that hits the
    // page mid-outage can drop a real, linked moment from the index on the
    // strength of a five-minute saturation spell.
    const unavailableMeta = src.indexOf(UNAVAILABLE)
    expect(src.slice(unavailableMeta, unavailableMeta + 300)).toContain(
      "robots: { index: false, follow: true }"
    )
    // The not-found copy must remain reachable for a genuine miss, and must be a
    // DIFFERENT branch — one string doing both jobs is the defect this file exists
    // for, and a prefix match would otherwise let them collapse into each other.
    expect(src).toContain(NOT_FOUND)
    expect(src.indexOf(NOT_FOUND)).not.toBe(src.indexOf(UNAVAILABLE))
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
  // 6. /[collection]/edition/[slug] — the SERVER-SEEDED half of a component that
  //    already knew better. FmvHistoryChart has distinguished "the fetch failed"
  //    from "too few sales to chart" since it was written — but only for the
  //    CLIENT fetch. The 30-day view, which the page opens on, is server-seeded
  //    and short-circuits that fetch, so a failed server read arrived as `[]`
  //    with no provenance and rendered the too-few-sales verdict. Highest-traffic
  //    public page in the product.
  //
  //    ⚠ Pins the WIRING, which is the half a component test cannot see: mutation
  //    showed that deleting `initialFailed` from this call site left every one of
  //    the component's own tests passing.
  it("edition/[slug] tells the FMV chart whether the SEED read failed", () => {
    const src = read("app", "(collections)", "[collection]", "edition", "[slug]", "page.tsx")

    // The history fetcher must report ok — a bare list cannot carry the failure.
    expect(src, "the history fetch must be three-state").toMatch(
      /rows: HistoryRow\[\]; ok: boolean/,
    )
    // ...and the page must hand that state to the chart, derived from the read
    // rather than hardcoded. `initialFailed={false}` would pass a presence check.
    const at = src.indexOf("<FmvHistoryChart")
    expect(at, "the edition page must render FmvHistoryChart").toBeGreaterThan(-1)
    const call = src.slice(at, at + 400)
    expect(call, "the chart must be told whether the seed failed").toContain("initialFailed=")
    expect(call, "initialFailed must be DERIVED from the history read, not a literal").toMatch(
      /initialFailed=\{!\w+\.ok\}/,
    )
  })

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
    //
    // ⚠ PINS THE PROPERTY, NOT THE SPELLING. This used to require the literal
    // `tierMix.ok ? buildTierMixRows(...)`, and it went red on 2026-08-23 for a
    // change that STRENGTHENED the gate: `tierMix.ok && editionsOk ? …`, added
    // because the sample leg reads the editions page and that read can now fail
    // on its own. A guard that fails correct code is the shape this repo keeps
    // recording — so the condition is now parsed rather than matched: exactly one
    // call, on the true branch of a gate that names `tierMix.ok`, ANDed with
    // whatever else the page needs, with `[]` on the false branch.
    const calls = [...src.matchAll(/buildTierMixRows\(/g)]
    expect(calls.length, "expected exactly one buildTierMixRows call to reason about").toBe(1)
    const at = calls[0].index!
    const gate = src.slice(Math.max(0, at - 120), at)
    expect(gate, "buildTierMixRows must sit on the true branch of a ternary").toMatch(/\?\s*$/)
    const condition = gate.replace(/\?\s*$/, "")
    expect(condition, "the gate must name tierMix.ok").toContain("tierMix.ok")
    // ⚠ `||` would let a falsy `tierMix.ok` through — a weakening that reads
    // identically to a strengthening at a glance.
    expect(condition, "the gate must not be widened with ||").not.toContain("||")
    expect(
      src.slice(at, at + 140),
      "the false branch must be [] — anything else keeps rendering a bar",
    ).toMatch(/buildTierMixRows\(tierMix\.rows,\s*editions\)\s*:\s*\[\]/)
    // ...and the page must not hold its own client for this read any more; the
    // extraction is what put the logic under the primary coverage gate.
    expect(src, "the page must not query the database inline").not.toContain("@/lib/supabase")
  })

  // 6. /my-teams — the SIXTH instance, and the one where both false claims are
  //    about the READER'S OWN ACCOUNT, which is the worst version of this class:
  //    the reader is the only person who knows the claim is wrong, and has no
  //    way to tell that we know it too.
  //
  //    `fetchFanTeams` returned `[]` on error and the page renders zero teams as
  //    "Follow a team to build your hub" with two suggested teams — so a
  //    collector who follows six was told they follow none and invited to start
  //    over. `fetchBoundWallet` returned `null` on error and the page renders a
  //    null wallet as "Add a wallet address … on your profile" — told to add the
  //    wallet they already added.
  //
  //    ⚠ Behind sign-in, which is exactly why no sweep had reached it: the anon
  //    driver-message guard derives its file set from `isPublicPath`, so
  //    everything past the auth wall is outside it BY CONSTRUCTION.
  it("my-teams does not report a failed read as 'you follow no teams'", () => {
    const src = read("app", "my-teams", "page.tsx")
    const fetcherSrc = read("lib", "fan-teams", "fetchers.ts")

    expect(fetcherSrc, "a failed follow read must be ok:false").toContain(
      "return { teams: [], ok: false }",
    )
    expect(fetcherSrc, "an empty follow list must stay ok:true").toContain(
      "return { teams: Array.isArray(data) ? (data as FanTeam[]) : [], ok: true }",
    )
    expect(src, "page must destructure the follow read's ok").toMatch(
      /const \{\s*teams\s*,\s*ok:\s*teamsOk\s*\}\s*=\s*await fetchFanTeams\(/,
    )
    // ⚠ The failure branch must precede the follow prompt, or the fix is inert
    // — measured over the COMMENT-STRIPPED source, because the comment above
    // that branch quotes the prompt copy to explain itself.
    const code = stripComments(src)
    const failure = code.indexOf("if (!teamsOk) {")
    const prompt = code.indexOf("Follow a team to build your hub")
    expect(failure, "the !teamsOk branch must exist").toBeGreaterThan(-1)
    expect(failure, "it must precede the empty-state prompt").toBeLessThan(prompt)
    // ...and the follow prompt must remain reachable for a genuinely new account.
    expect(src).toContain("if (teams.length === 0)")
    // The copy must not assert anything about which teams they follow.
    expect(src, "the failure card must not claim they follow nothing").toContain(
      "says nothing about which teams you follow",
    )
  })

  it("my-teams does not tell a collector to add the wallet they already added", () => {
    const src = read("app", "my-teams", "page.tsx")
    const fetcherSrc = read("lib", "fan-teams", "fetchers.ts")

    expect(fetcherSrc, "a failed wallet read must be ok:false").toContain(
      "return { wallet: null, ok: false }",
    )
    // The prompt must be gated on the read having SUCCEEDED — an omitted prompt
    // understates, which is the safe direction; asserting it is a false claim
    // about the reader's own profile.
    expect(src, "the add-a-wallet prompt must be gated on walletOk").toMatch(
      /\{walletOk\s*&&\s*!wallet\s*&&\s*\(/,
    )
  })

  // 7-8. /fast-break and /road-to-the-ring — the same defect, COPY-PASTED. Both
  //    read the user's pinned Top Shot wallet with an identical eight-line query
  //    that never destructured `error`, so a failed read rendered
  //    ConnectWalletCard: "connect a Top Shot wallet", shown to a collector who
  //    has pinned one. Fast Break carries two more of the same shape — a failed
  //    run read renders "No active Fast Break run … we'll surface the next run
  //    here as soon as Top Shot opens it" DURING a live run (a false claim with
  //    a guarantee attached), and a failed slate read renders as a quiet night.
  //
  //    ⚠ The gate ladder is what makes these testable as ORDER rather than as
  //    copy: each failure branch must sit ABOVE the absent-branch it would
  //    otherwise fall into, or the flag exists and changes nothing.
  it.each([
    ["fast-break", ["app", "(collections)", "[collection]", "fast-break", "page.tsx"]],
    ["road-to-the-ring", ["app", "(collections)", "[collection]", "road-to-the-ring", "page.tsx"]],
  ] as const)("%s does not tell a collector to connect the wallet they pinned", (_name, parts) => {
    const code = stripComments(read(...parts))

    expect(code, "the page must read the wallet through the shared fetcher").toContain(
      "fetchPinnedWallet(user.id, NBA_TOP_SHOT_UUID)",
    )
    const failure = code.indexOf("!walletOk ?")
    const connect = code.indexOf("<ConnectWalletCard />")
    expect(failure, "a !walletOk branch must exist").toBeGreaterThan(-1)
    expect(failure, "it must precede the connect-wallet card").toBeLessThan(connect)
    // ...and the connect card must stay reachable for someone who really has
    // pinned nothing, or the fix strands them with no way forward.
    expect(connect, "the connect card must remain reachable").toBeGreaterThan(-1)
  })

  it("fast-break does not report a failed run read as 'no active run'", () => {
    const fetcherSrc = read("lib", "fast-break", "page-data.ts")
    const code = stripComments(read("app", "(collections)", "[collection]", "fast-break", "page.tsx"))

    expect(fetcherSrc, "a failed run read must be ok:false").toContain("return { run: null, ok: false }")
    expect(fetcherSrc, "genuinely between runs must stay ok:true").toContain(
      "return { run: (data as ActiveRun | null) ?? null, ok: true }",
    )
    // The failure branch must precede NoRunCard, whose copy promises we would
    // surface a run if there were one.
    const failure = code.indexOf("!runOk ?")
    const noRun = code.indexOf("<NoRunCard />")
    expect(failure, "a !runOk branch must exist").toBeGreaterThan(-1)
    expect(failure, "it must precede NoRunCard").toBeLessThan(noRun)
    expect(noRun, "NoRunCard must remain reachable between runs").toBeGreaterThan(-1)
    // The SUBTITLE makes the same claim in the header and must be gated too —
    // it renders above the gate ladder, so fixing only the card leaves
    // "No active run" on screen during a live run.
    expect(code, "the subtitle must not assert 'No active run' on a failed read").toMatch(
      /runOk\s*\n?\s*\?\s*"No active run"/,
    )
  })

  it("the legacy /edition/[id] redirect does not 404 a real edition on a failed read", () => {
    // This route exists to catch LEGACY inbound links — old shares and anything
    // a crawler already indexed — so `if (error || !data) notFound()` handed a
    // hard 404 for an edition that exists, to the audience least likely to
    // retry. Throwing renders the retryable error boundary; a genuine miss
    // still 404s.
    const code = stripComments(read("app", "edition", "[id]", "page.tsx"))
    const fetcherSrc = read("lib", "edition", "legacy-redirect.ts")

    expect(fetcherSrc, "a failed lookup must be ok:false").toContain("return { target: null, ok: false }")
    expect(fetcherSrc, "a genuine miss must stay ok:true").toContain("return { target: null, ok: true }")
    const thrown = code.indexOf('if (!ok) throw new Error("edition redirect unavailable")')
    const notFoundCall = code.indexOf("if (!target) notFound()")
    expect(thrown, "a failed read must throw, not notFound()").toBeGreaterThan(-1)
    expect(thrown, "the throw must precede the not-found branch").toBeLessThan(notFoundCall)
    expect(notFoundCall, "a genuine miss must still 404").toBeGreaterThan(-1)
    expect(code, "error must no longer be folded into the notFound condition").not.toContain(
      "if (error || !data",
    )
  })
})
