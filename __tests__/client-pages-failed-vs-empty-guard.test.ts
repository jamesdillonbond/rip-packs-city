import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pageSource } from "./helpers/page-source"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// Source guard for the failed-vs-empty split on two more `"use client"` pages.
//
// Sibling of collection-analytics-failed-vs-empty-guard (same tab family, its own
// file) and of server-pages-error-vs-absent-guard (the server-side equivalent).
// All three exist for the same structural reason: `"use client"` `page.tsx` files
// are measured by NEITHER coverage gate — the component gate's include is
// `app/**/*Client.tsx`, and the primary gate does not look at `app/**/page.tsx` —
// so a source property is the only automated check available. The durable fix is
// the `*Client.tsx` split tracked by `client-page-gate-ratchet`.
//
// ── THE TWO SITES ───────────────────────────────────────────────────────────
//
// 1. /dashboard — the Hero-Moment picker rendered "No owned moments found." on a
//    failed `/api/profile/top-moments` read. That is the sharpest instance of
//    this class found so far, because the claim is about the READER'S OWN
//    COLLECTION: an outage told a collector they own nothing.
//
// 2. /[collection]/sniper — the relative-deals panel rendered "No relative deals
//    right now. Benchmark data may be too thin." A bare empty state would be bad
//    enough; this one DIAGNOSES a cause that is not the cause, sending the reader
//    to look at benchmark coverage when the actual problem was our read. Same
//    shape as the "try a longer time range or lower min FMV floor" copy fixed on
//    2026-08-12 — advice to fix a filter that was never the problem.
//
// ⚠ Both empty-state strings are KEPT. An empty result is a real answer and must
// still say so; what changed is that it is no longer reachable from a failure.

function read(...parts: string[]): string {
  // A `page.tsx` request reads the page AS A UNIT — the shell plus any sibling
  // `*Client.tsx` — because the `*Client.tsx` conversion moves the logic these
  // assertions grep for between the two files with no behaviour change. Doing it
  // in the helper rather than at 14 call sites means the next conversion is a
  // no-op here instead of a red build that invites loosening the assertion.
  // See __tests__/helpers/page-source.ts for why that repair is the real risk.
  if (parts[parts.length - 1] === "page.tsx") return pageSource(...parts.slice(0, -1))
  return readFileSync(join(process.cwd(), ...parts), "utf8")
}

/**
 * `//`-comment LINES removed, block comments deliberately LEFT IN PLACE.
 *
 * ⚠ Not a weaker `stripComments` — a DIFFERENT normalisation, and the difference
 * is load-bearing. The /alerts site asserts
 * `not.toMatch(/catch \{\s*\/\* ignore \*\/\s*\}/)`, which needs the block comment
 * PRESENT to mean anything; running the shared stripper there would leave that
 * assertion passing for the wrong reason — vacuous, and silently so.
 *
 * Sites that want BOTH kinds gone import the shared stripper instead. Renamed
 * from `stripComments` on 2026-08-22 so the two can never be confused at a call
 * site, which is exactly how a guard ends up reading a blanked file.
 */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n")
}

describe("client pages — a failed read is not an empty result", () => {
  it("dashboard hero-picker distinguishes a failed moments read from owning nothing", () => {
    const src = stripLineComments(read("app", "dashboard", "page.tsx"))

    expect(src, "must track the failure").toContain("const [loadFailed, setLoadFailed] = useState(false)")
    // Reset per run, or a recovered picker stays stuck on the failure copy.
    expect(src, "must clear on re-fetch").toContain("setLoadFailed(false)")
    // Set on BOTH the null-body path and the thrown path.
    expect(src).toContain("if (!d?.moments) { setLoadFailed(true); setMoments([]); return; }")
    expect(src).toMatch(/\.catch\(\(\)\s*=>\s*\{\s*if \(!cancelled\) \{ setLoadFailed\(true\); setMoments\(\[\]\); \}\s*\}\)/)

    // The empty-state copy survives — owning nothing is a real answer.
    expect(src).toContain("No owned moments found.")
    // ...and the failure copy explicitly disclaims any statement about ownership.
    expect(src).toContain("This says nothing about what you own")
    // Ordering is what makes the fix non-inert.
    expect(
      src.indexOf("This says nothing about what you own"),
      "the failed branch must precede the empty branch",
    ).toBeLessThan(src.indexOf("No owned moments found."))
  })

  it("sniper relative-deals does not blame the benchmark data for a failed read", () => {
    const src = stripLineComments(read("app", "(collections)", "[collection]", "sniper", "page.tsx"))

    expect(src, "must track the failure").toContain(
      "const [relativeFailed, setRelativeFailed] = useState(false)",
    )
    expect(src, "must clear on re-fetch").toContain("setRelativeFailed(false)")
    expect(src).toContain("if (!Array.isArray(rel?.deals)) { setRelativeFailed(true); setRelativeDeals([]); }")
    // The catch leg must set it too — a thrown fetch is the same outcome.
    const catchBlock = src.slice(src.indexOf("} catch {", src.indexOf("setRelativeFailed(true)")))
    expect(catchBlock.slice(0, 200)).toContain("setRelativeFailed(true)")

    // The diagnosis copy survives for the case where it is actually true...
    expect(src).toContain("Benchmark data may be too thin.")
    // ...and the failure copy explicitly disclaims it.
    expect(src).toContain("This says nothing about the benchmark data")
    expect(
      src.indexOf("This says nothing about the benchmark data"),
      "the failed branch must precede the empty branch",
    ).toBeLessThan(src.indexOf("Benchmark data may be too thin."))
  })

  // ── SITE 3: /alerts (added 2026-08-15) ────────────────────────────────────
  //
  // Found by sweeping client-page empty-state copy rather than by a report. Its
  // `load()` ran three fetches under one Promise.all, guarded each with
  // `if (res.ok)`, and on a !ok response simply left state at its initial `[]` —
  // with a bare `catch { /* ignore */ }` swallowing a thrown fetch entirely.
  //
  // EVERY claim on this page is about the reader's OWN account, which makes it
  // the sharpest instance of this class after the dashboard hero-picker:
  //
  //   • "No alerts yet. Create one above."  — invites a DUPLICATE of an alert
  //     the collector already has.
  //   • "No watched editions yet."
  //   • the channel list rendered every channel as "not linked" with a Link
  //     button, telling someone whose Telegram IS linked that it is not.
  //
  // Per-leg rather than one flag on purpose: the three endpoints fail
  // independently, and a single flag would blank all three sections whenever any
  // one of them broke.
  describe("/alerts — three independent legs, three independent failures", () => {
    const src = stripLineComments(read("app", "alerts", "page.tsx"))

    it("tracks failure per leg and clears it on re-fetch", () => {
      expect(src).toContain(
        "const [failed, setFailed] = useState({ channels: false, subs: false, fmv: false })",
      )
      // Reset at the top of load(), or a recovered page stays stuck on the
      // failure copy.
      expect(src).toContain("setFailed({ channels: false, subs: false, fmv: false })")
    })

    it("sets the flag on every !ok leg", () => {
      expect(src).toContain('setFailed((f) => ({ ...f, channels: true }))')
      expect(src).toContain('setFailed((f) => ({ ...f, subs: true }))')
      expect(src).toContain('setFailed((f) => ({ ...f, fmv: true }))')
    })

    it("a thrown fetch fails ALL three legs", () => {
      // One Promise.all — if it throws, no leg's state was populated, so trusting
      // any of them would be inventing an answer for two sections as well as one.
      expect(src).toContain("setFailed({ channels: true, subs: true, fmv: true })")
      expect(src, "the catch must not silently swallow").not.toMatch(
        /catch \{\s*\/\* ignore \*\/\s*\}/,
      )
    })

    it("the empty-state copy SURVIVES — owning nothing is still a real answer", () => {
      expect(src).toContain("No alerts yet. Create one above.")
      expect(src).toContain("No watched editions yet.")
    })

    it("the failure branch precedes the empty branch in both lists", () => {
      // Ordering is what makes the fix non-inert.
      expect(src.indexOf("failed.subs ?")).toBeGreaterThan(-1)
      expect(src.indexOf("failed.subs ?")).toBeLessThan(src.indexOf("No alerts yet."))
      expect(src.indexOf("failed.fmv ?")).toBeGreaterThan(-1)
      expect(src.indexOf("failed.fmv ?")).toBeLessThan(src.indexOf("No watched editions yet."))
    })

    it("the channel list carries a notice, since 'not linked' is itself the false claim", () => {
      // This leg has no empty state to guard — the false claim IS the per-channel
      // status, so the disclaimer has to sit above the list.
      expect(src).toContain("failed.channels &&")
      expect(src.indexOf("failed.channels &&")).toBeLessThan(src.indexOf("not linked"))
    })

    it("no failure message diagnoses a cause it cannot know", () => {
      for (const marker of [
        "Couldn&apos;t load your alerts just now",
        "Couldn&apos;t load your watched editions just now",
        "Couldn&apos;t load your channel status just now",
      ]) {
        const i = src.indexOf(marker)
        expect(i, `${marker} must exist`).toBeGreaterThan(-1)
        expect(src.slice(i, i + 240)).toMatch(/says nothing about/)
      }
    })
  })

  // ── SITE 4: /panini-blockchain/sniper (added 2026-08-15) ──────────────────
  //
  // Found by the same empty-state-copy sweep, and it is the first site in this
  // family whose render ladder was ALREADY correct: `loading : error : empty` in
  // the right order, with a real error card. What made it dishonest is the panel
  // ABOVE that ladder.
  //
  // `data` holds the PREVIOUS payload after a failed refresh (the route serves a
  // stale in-process cache on upstream failure, so the client's `error` fires only
  // when there is no cache at all — a fresh lambda plus an OpenSea outage). The
  // header consulted `data` and not `error`, so it published:
  //
  //   • a live GREEN PULSING dot, and
  //   • "Floor: 0.0500 ETH · 12 listings"
  //
  // directly above a card reading "Failed to load listings." On a SNIPER page the
  // floor is the number a collector buys against, which makes this the same defect
  // as /insights/pack-reality — the error state consulted at one of several claim
  // sites — on the panel where it costs the most.
  //
  // ⚠ The fix is per PANEL, not per page. A page with an honest error branch
  // somewhere is not an honest page.
  describe("/panini-blockchain/sniper — the header is a claim site too", () => {
    const path = ["app", "(collections)", "panini-blockchain", "sniper", "page.tsx"] as const

    // ⚠ Block comments are stripped HERE rather than in the shared `stripComments`
    // above, and the distinction is load-bearing in both directions.
    //
    // Needed here: this page documents the fix by quoting the copy it replaced, so
    // a scan that reads `{/* … */}` finds the decaying string it exists to forbid
    // and reds on the explanation. That is the recurring repo trap — a guard that
    // greps source for user copy must strip comments, including the one you are
    // writing — met for the third time.
    //
    // NOT hoisted into `stripComments`: the /alerts site asserts
    // `not.toMatch(/catch \{\s*\/\* ignore \*\/\s*\}/)`, which needs the block
    // comment PRESENT to be meaningful. Stripping it globally would leave that
    // assertion passing for the wrong reason — vacuous, and silently so.
    const src = stripComments(read(...path))

    it("the liveness dot knows about the error state", () => {
      // A green pulsing dot asserts "this feed is live". During an outage it is
      // the most confident thing on the page and it was the least informed.
      expect(src).toMatch(/background:\s*error\s*\n?\s*\?\s*"var\(--rpc-danger\)"/)
      expect(src).toContain('animation: error || paused ? "none" : "pulse 2s infinite"')
    })

    it("the floor/count panel branches on error BEFORE it branches on data", () => {
      const errBranch = src.indexOf("{error ? (")
      const dataBranch = src.indexOf(") : data ? (")
      expect(errBranch, "the header must consult `error`").toBeGreaterThan(-1)
      expect(dataBranch).toBeGreaterThan(errBranch)
      // Ordering is what makes the fix non-inert: `data &&` first would render the
      // stale numbers again regardless of what the error arm says.
      expect(errBranch).toBeLessThan(src.indexOf("Floor: <span"))
    })

    it("the failure copy withholds the figure instead of restating a stale one", () => {
      const i = src.indexOf("Floor unavailable")
      expect(i, "failure copy must exist").toBeGreaterThan(-1)
      const copy = src.slice(i, i + 200)
      // It must not diagnose a cause it cannot know — the /[collection]/sniper
      // lesson, where the replacement copy blamed the benchmark data.
      expect(copy).not.toMatch(/too thin|not indexed|no coverage|try a (longer|different)|lower your/i)
      // ...and must not quietly publish a number anyway.
      expect(copy).not.toMatch(/ETH|\d+ listing/)
    })

    it("the count renders through the floor helper, by CALL form", () => {
      // Matching the call form rather than the bare identifier on purpose: a page
      // that keeps the import while hand-rolling `{data.count} listings` satisfies
      // a plain `includes("boardCountFloor")` and slips straight through.
      expect(src).toContain("boardCountFloor(data.count, data.truncated)")
      // The raw page length must not be interpolated as a total anywhere.
      expect(src).not.toMatch(/\{data\.count\} listing/)
    })

    it("the empty state SURVIVES — an empty book is a real answer", () => {
      // Reachable only when the read succeeded, so it is allowed to make a claim
      // about the market.
      expect(src).toContain("No bridged Panini cards are listed on OpenSea right now.")
      expect(src).toContain("No listings match your current filters.")
    })

    it("the empty state no longer dates itself", () => {
      // The old copy read "The Ethereum bridge just opened on March 30, 2026" —
      // written at launch, and describing a months-old event as breaking news ever
      // since. Same class as the hardcoded coverage percentages CLAUDE.md warns
      // about, in prose rather than in a number.
      expect(src).not.toMatch(/just opened on/i)
      expect(src).not.toMatch(/March 30, 2026/)
    })
  })

  // ── SITE 5: /[collection]/profile/[username] (added 2026-08-15) ───────────
  //
  // Found by CENSUS rather than by hand-picking: of the 18 `"use client"`
  // page.tsx files that both fetch and carry claim-copy, this one had the worst
  // bare-swallow density — 9 catch blocks, 8 of them `catch {}` / `.catch(() =>
  // {})`. It is a PUBLIC page about a named collector, which is what makes the
  // claims expensive.
  //
  // Four sites, three legs:
  //
  //   • the trophy read → three empty slabs, i.e. "this collector pinned
  //     nothing", plus "· 0 / 3 TROPHY MOMENTS" in the headline.
  //   • the sniper read → "No live deals available right now." (a MARKET claim).
  //   • the sparkline's own read → "No FMV history yet for this wallet."
  //
  // ⚠ THE USEFUL NEGATIVE: the wallet-derived stats were ALREADY SAFE and are
  // deliberately left alone. `totalFmv` / `totalMoments` / `totalBadges` each
  // reduce to 0 on a failed read, but every render site gates on `> 0` and emits
  // an em-dash, so no false $0 was ever published. That safety is a property of
  // the CURRENT call sites rather than of the data, so it is pinned below — a
  // later refactor that renders one of them unconditionally would reintroduce
  // exactly the false-zero this page never had.
  describe("/[collection]/profile/[username] — three legs, three failures", () => {
    const path = ["app", "(collections)", "[collection]", "profile", "[username]", "page.tsx"] as const
    // Block comments stripped locally, same reason as site 4: this page explains
    // each fix by quoting the copy it guards.
    const src = stripComments(read(...path))

    it("tracks failure per leg and clears it on re-fetch", () => {
      expect(src).toContain("const [failed, setFailed] = useState({ trophies: false, sniper: false })")
      // Two independent resets — the two legs live in different effects, so one
      // shared reset would leave whichever effect did not re-run stuck.
      expect(src).toContain("setFailed(function(f) { return { ...f, trophies: false }; })")
      expect(src).toContain("setFailed(function(f) { return { ...f, sniper: false }; })")
    })

    it("sets each flag on BOTH the null-body path and the thrown path", () => {
      for (const leg of ["trophies", "sniper"]) {
        const setter = `setFailed(function(f) { return { ...f, ${leg}: true }; })`
        // Two occurrences: the `if (!data)` guard and the `.catch`. One alone
        // leaves half the failure modes rendering as an answer.
        const n = src.split(setter).length - 1
        expect(n, `${leg} must flag on both the null body and the catch`).toBeGreaterThanOrEqual(2)
      }
      // ⚠ Deliberately NOT asserting "no bare swallow remains on this page".
      // Three legs still swallow — `bio`, `saved-wallets`, and the avatar-change
      // POST — and that is correct, not unfinished: none of them backs a claim.
      // A missing tagline or avatar renders as absence, and every wallet-derived
      // stat is `> 0`-gated (pinned below). A blanket assertion here would have
      // described work this change did not do, and the first version of this
      // test did exactly that — it failed against the finished page.
    })

    it("the sparkline card distinguishes a failed read from a wallet with no history", () => {
      expect(src).toContain("const [loadFailed, setLoadFailed] = useState(false)")
      expect(src).toContain("setLoadFailed(false)")
      expect(src).toContain("if (!data) { setLoadFailed(true); return; }")
      expect(src).toContain(".catch(function() { setLoadFailed(true); })")
    })

    it("every failure branch precedes its empty branch", () => {
      // Ordering is the whole fix: a failed read leaves each list empty, so an
      // emptiness test placed first swallows the failure silently.
      expect(src.indexOf("loadFailed ?")).toBeLessThan(src.indexOf("points.length === 0 ?"))
      expect(src.indexOf("failed.sniper ?")).toBeLessThan(src.indexOf("sniperDeals.length === 0 ?"))
      expect(src.indexOf("failed.trophies ?")).toBeGreaterThan(-1)
      expect(src.indexOf("failed.trophies ?")).toBeLessThan(src.indexOf("trophies.map("))
    })

    it("the empty-state copy SURVIVES — an empty case is still a real answer", () => {
      expect(src).toContain("No FMV history yet for this wallet.")
      expect(src).toContain("No live deals available right now.")
    })

    it("withholds the trophy count on failure instead of publishing 0 / 3", () => {
      expect(src).toContain("failed.trophies\n            ? collectorLabel")
      // ...and still publishes it on the healthy path.
      expect(src).toContain('" / 3 TROPHY MOMENTS"')
    })

    it("names the collection from the registry, not a hardcoded literal", () => {
      // Separate class from the honesty sweep, found alongside it: the label was
      // the literal "NBA TOP SHOT COLLECTOR" on a route that serves all five
      // published collections, so every All Day / Golazos / UFC / Pinnacle
      // profile announced the wrong game.
      expect(src).toContain("getCollection(collection)?.label")
      expect(src, "the hardcoded literal must not come back").not.toContain(
        '"NBA TOP SHOT COLLECTOR"',
      )
    })

    it("the wallet-derived stats stay gated on > 0, so a failed read cannot print $0", () => {
      // The negative result from this sweep, pinned. Each of these reduces to 0
      // when the saved-wallets read fails; the `> 0` gate is the only thing
      // between that and a public profile claiming a collector holds nothing.
      for (const stat of ["totalFmv", "totalMoments", "totalBadges"]) {
        expect(src, `${stat} must not be rendered unconditionally`).toMatch(
          new RegExp(`${stat} > 0 \\?`),
        )
      }
    })

    it("no failure message diagnoses a cause it cannot know", () => {
      for (const marker of [
        "Couldn&apos;t load this trophy case just now.",
        "Couldn&apos;t load live deals just now.",
        "Couldn&apos;t load FMV history just now.",
      ]) {
        const i = src.indexOf(marker)
        expect(i, `${marker} must exist`).toBeGreaterThan(-1)
        expect(src.slice(i, i + 260)).not.toMatch(
          /too thin|not indexed|no coverage|try a (longer|different)|lower your/i,
        )
      }
    })
  })

  // ── SITE 6: /[collection]/sniper depth panel (added 2026-08-15) ───────────
  //
  // The same page as site 2, a DIFFERENT panel — which is the point. Fixing the
  // relative-deals panel did not make the page honest, and the census still
  // ranked this file top by bare-swallow density afterwards.
  //
  // The expand-a-deal depth panel has TWO legs and only ONE reported failure.
  // The floor leg already rendered "Could not load floor data"; the listings leg
  // swallowed both of its exits — a bare `return` on `!res.ok` (the LIKELIER
  // failure: a 5xx response, not a thrown fetch) and a bare `.catch(() => {})` —
  // leaving depthDeals at [] so the panel rendered "No other listings for this
  // edition."
  //
  // So the panel was HALF-HONEST: an explicit floor error sat directly above a
  // fabricated statement about supply, which reads as verified precisely because
  // the neighbouring error proves the panel *can* report failure. On the sniper
  // surface that claim is what tells a collector the listing in front of them is
  // the only one.
  describe("/[collection]/sniper listing suggestions — the empty copy is a CONCLUSION", () => {
    // ⚠ Not an empty state: "No listing suggestions found. Your moments are
    // priced at or below current market asks." is a specific analytical claim
    // about the reader's own portfolio, and it is actionable in the direction
    // of INACTION — it tells them not to re-list. Three failure paths used to
    // produce it: a non-2xx snapshot read, a thrown fetch, and the deals feed
    // not having loaded.
    const src = stripLineComments(
      read("app", "(collections)", "[collection]", "sniper", "page.tsx"),
    )

    it("classifies through the shared state machine rather than inline", () => {
      // The arithmetic and the four states live in lib/, where the primary gate
      // measures them — this page is 1,790 lines that neither gate sees.
      expect(src).toContain("suggestionsState({")
      expect(src).toContain("buildListingSuggestions(owned, data.deals)")
    })

    it("BOTH exits classify — the non-ok body and the thrown fetch", () => {
      // The `.catch` used to only stop the spinner, leaving the conclusion on
      // screen after a network failure.
      expect(src).toContain('setSuggestionsState("read-failed")')
      const catchBlock = src.slice(src.indexOf("setSuggestionsLoading(true);"))
      expect(catchBlock).toMatch(/\.catch\(\(\) => \{[\s\S]{0,200}setSuggestionsState\("read-failed"\)/)
    })

    it("both failure branches precede the conclusion", () => {
      const readFailed = src.indexOf('suggestionsState_ === "read-failed" ?')
      const noMarket = src.indexOf('suggestionsState_ === "no-market" ?')
      const conclusion = src.indexOf("Your moments are priced at or below current market asks")
      expect(readFailed, "a read-failed branch must exist").toBeGreaterThan(-1)
      expect(noMarket, "a no-market branch must exist").toBeGreaterThan(-1)
      expect(readFailed).toBeLessThan(conclusion)
      expect(noMarket).toBeLessThan(conclusion)
      // ...and the conclusion must REMAIN reachable: when both sides loaded it
      // is true and useful, and routing it into a failure notice would hide a
      // real answer behind a false apology.
      expect(conclusion, "the honest conclusion must survive").toBeGreaterThan(-1)
    })

    it("the failure copy does not make a claim about the reader's pricing", () => {
      expect(src).toContain("This says\n              nothing about how your Moments are priced")
    })
  })

  describe("/[collection]/sniper depth panel — both legs report failure", () => {
    const src = stripComments(
      read("app", "(collections)", "[collection]", "sniper", "page.tsx"),
    )

    it("tracks the listings leg's failure and clears it per expand", () => {
      expect(src).toContain(
        "const [depthListingsError, setDepthListingsError] = useState<string | null>(null)",
      )
      expect(src).toContain("setDepthListingsError(null)")
    })

    it("sets it on BOTH exits — the !res.ok return and the catch", () => {
      expect(src).toContain(
        'if (!res.ok) { setDepthListingsError("Could not load other listings"); return; }',
      )
      expect(src).toContain('.catch(() => setDepthListingsError("Could not load other listings"))')
    })

    it("the failure branch precedes the empty branch", () => {
      const fail = src.indexOf("depthListingsError ? (")
      const empty = src.indexOf("depthDeals.length === 0 ? (")
      expect(fail).toBeGreaterThan(-1)
      expect(fail).toBeLessThan(empty)
    })

    it("the empty-state copy SURVIVES — a sole listing is a real answer", () => {
      expect(src).toContain("No other listings for this edition.")
    })

    it("the sibling floor leg still reports its own failure", () => {
      // Guards the guard against a 'simplification' that unifies the two legs
      // onto one flag: they fail independently, and a floor outage must not
      // suppress listings that loaded fine.
      expect(src).toContain('setDepthFloorError("Could not load floor data")')
      expect(src).toContain("depthFloorError ? (")
    })
  })

  // ── SITE 7: /dashboard, two MORE sites (added 2026-08-15) ─────────────────
  //
  // The same file as site 1, two panels the hero-picker fix did not reach — the
  // recurring lesson of this sweep: a page is not "made honest" by fixing the
  // component that failed.
  //
  // 1. `{email ?? "Not signed in"}`. /dashboard is auth-gated by proxy.ts, so a
  //    reader seeing this page IS signed in. `email` goes null for two very
  //    different reasons — a genuinely absent session, or /api/profile/me
  //    failing — and the render collapsed them, telling a collector they were
  //    not signed in ON THE ONE PAGE THAT PROVES THEY ARE.
  //
  // 2. The wallet-verification poll had no `res.ok` check. On a non-2xx the
  //    envelope still parses, `d.ok` is undefined so the success branch is
  //    skipped, and the hint rendered in a position that reads as a
  //    VERIFICATION RESULT. This is the only self-serve verification path and it
  //    awards credits, so "we could not check" must not wear the same words as
  //    "we checked and found nothing" — a collector who believes the second
  //    re-lists at a different price, or gives up.
  describe("/dashboard — the account panels", () => {
    const src = stripComments(read("app", "dashboard", "page.tsx"))

    it("distinguishes a failed /api/profile/me from an absent session", () => {
      expect(src).toContain("const [meFailed, setMeFailed] = useState(false)")
      expect(src).toContain("setMeFailed(!meRes.ok)")
      expect(src).toContain('email ?? (meFailed ? "Account details unavailable" : "Not signed in")')
    })

    it('the "Not signed in" copy SURVIVES for the case where it is true', () => {
      // An expired session is a real answer and must still say so.
      expect(src).toContain('"Not signed in"')
    })

    it("the verification poll checks the status before reading the body", () => {
      // ⚠ An earlier version compared `src.indexOf("if (!res.ok) {")` against
      // `src.indexOf("const d = await res.json()")`. Both strings occur more
      // than once in this 2,519-line file, so indexOf compared the WRONG
      // occurrences and the assertion was VACUOUS — moving the guard after the
      // parse did not red it. Caught by mutation, not by review.
      //
      // Pinned as a CONTIGUOUS sequence instead: the guard, then the parse, with
      // nothing between. That cannot be satisfied by a coincidental pair
      // elsewhere in the file.
      const guardThenParse =
        'if (!res.ok) {\n' +
        '        setCheckHint("Couldn\'t check just now — this says nothing about your listing. Try again shortly.");\n' +
        "        return;\n" +
        "      }\n" +
        "      const d = await res.json();"
      expect(src).toContain(guardThenParse)
    })

    it("the no-match hint SURVIVES — a genuine miss is a real answer", () => {
      expect(src).toContain('"No matching listing found yet."')
    })

    it("neither dashboard failure message diagnoses a cause it cannot know", () => {
      for (const marker of ["Account details unavailable", "Couldn't check just now"]) {
        const i = src.indexOf(marker)
        expect(i, `${marker} must exist`).toBeGreaterThan(-1)
        expect(src.slice(i, i + 220)).not.toMatch(
          /too thin|not indexed|no coverage|wrong price|re-?list|lower your/i,
        )
      }
    })
  })

  it("neither failure message diagnoses a cause it cannot know", () => {
    // The defect these replaced was not just silence — it was a CONFIDENT WRONG
    // EXPLANATION. A replacement that guesses a different wrong cause would be
    // the same mistake wearing new copy.
    const dash = read("app", "dashboard", "page.tsx")
    const sniper = read("app", "(collections)", "[collection]", "sniper", "page.tsx")
    for (const [name, src, marker] of [
      ["dashboard", dash, "Couldn&apos;t load your moments."],
      ["sniper", sniper, "Couldn&apos;t load relative deals."],
    ] as const) {
      const i = src.indexOf(marker)
      expect(i, `${name} failure copy must exist`).toBeGreaterThan(-1)
      const copy = src.slice(i, i + 260)
      expect(copy, `${name} must not blame the data`).not.toMatch(
        /too thin|not indexed|no coverage|try a (longer|different)|lower your/i,
      )
    }
  })

  // ── /dashboard/alerts — the sibling /alerts was fixed and this was not ─────
  //
  // ⚠ Both defects here are the "page contradicts itself" shape, not merely a
  // misleading empty state: the error banner renders DIRECTLY ABOVE each of
  // them, so an outage produced an error message and a confident claim beneath
  // it on the same screen.
  //
  //   1. `load()` sets `alerts` to [] on a failed read, and the empty branch
  //      rendered the WELCOME card — "No alerts yet" plus a pitch to create
  //      your first one. A collector with a dozen live alerts, on a 503, was
  //      invited to create a DUPLICATE of one they already have. Exactly the
  //      defect /alerts was fixed for; this page was not swept at the time.
  //   2. `runSearch()` sets `matches` to [] on a failed search, and "No
  //      matches." is a claim that the moment they typed DOES NOT EXIST in the
  //      catalog — which would send someone away believing the platform does
  //      not carry their moment.
  //
  // Both are gated on `!err` rather than on the array, because the array cannot
  // distinguish the two outcomes and `err` can.
  describe("/dashboard/alerts — a failed read is not an empty account", () => {
    const src = stripComments(read("app", "dashboard", "alerts", "page.tsx"))

    it("the welcome card is gated on the read having SUCCEEDED", () => {
      expect(
        src,
        "an outage must not render the 'No alerts yet' onboarding card",
      ).toContain("{ownerKey && !err && alerts && alerts.length === 0 && (")
    })

    it("the search empty state is gated too", () => {
      expect(
        src,
        "a failed search must not claim the moment is absent from the catalog",
      ).toContain("{matches && !err && matches.length === 0 && (")
    })

    it("BOTH directions: a genuinely empty account still gets the welcome card", () => {
      // The copy must survive. A fix that blanked every empty state would only
      // move the dishonesty — and this card is the page's onboarding path.
      expect(src).toContain("No alerts yet")
      expect(src).toContain("No matches.")
    })

    it("failure is still tracked and cleared on re-fetch — in BOTH loaders", () => {
      // `!err` is only meaningful while err is set on failure and reset on a new
      // attempt; without the reset a recovered page stays permanently blank.
      //
      // ⚠ A bare `toContain("setErr(null)")` is NOT enough, and a mutation
      // proved it: this file has TWO loaders (load() for the alert list,
      // runSearch() for the moment picker) and each resets its own err, so
      // deleting the reset from load() left the other occurrence satisfying the
      // assertion. Both are pinned by their ANCHORING statement instead.
      expect(src, "load() must clear err before re-fetching").toMatch(
        /setLoading\(true\);\s*setErr\(null\);/,
      )
      expect(src, "runSearch() must clear err before re-searching").toMatch(
        /setSearching\(true\);\s*setErr\(null\);/,
      )
      expect(src).toMatch(/setErr\(j\?\.error \?\? `HTTP \$\{res\.status\}`\)/)
    })
  })

  // ── /admin/rewards — only 401 was checked ─────────────────────────────────
  //
  // ⚠ `load()` checked `res.status === 401` and NOTHING ELSE, so any other
  // non-2xx fell straight through to `data.pending ?? []` and emptied every
  // list. A 500 therefore rendered "Nothing waiting to ship." — and `pending` is
  // the queue of PHYSICAL redemptions a collector has ALREADY SPENT CREDITS ON.
  // An operator reading that during an outage concludes there is nothing to
  // fulfil, and someone's order silently never ships. Admin surface, but the
  // consequence lands on a user.
  //
  // ⚠ THE MEASUREMENT THAT FOUND IT IS WORTH MORE THAN THE FIX, because my first
  // three attempts at it were all wrong. "35 client pages fetch without
  // fetchJson" is not a defect list: 32 of 37 already track failure. Narrowing
  // to "no failure state" gave 4, then 5, then — once the pattern also matched
  // `setErr(` and redirect-based handling — TWO:
  //   • /dashboard/alerts   (fixed: the welcome card + "No matches.")
  //   • /admin/rewards      (this one)
  // Everything else was already correct, including three pages I opened
  // expecting defects. `auth/confirm` redirects to /login?error=session_failed
  // on every real failure and its /api/profile/touch warn is deliberately
  // fire-and-forget — a failed last_active_at stamp must not block a sign-in.
  // Do not re-derive this list from a grep for `setError(`.
  describe("/admin/rewards — a failed load is not an empty ship queue", () => {
    const src = stripComments(read("app", "admin", "rewards", "page.tsx"))

    it("checks res.ok, not just 401", () => {
      expect(
        src,
        "any non-2xx must be caught — 401 alone lets a 500 empty every list",
      ).toMatch(/if \(!res\.ok\) \{\s*setLoadFailed\(true\);/)
    })

    it("tracks the failure separately and clears it on re-load", () => {
      expect(src).toContain("const [loadFailed, setLoadFailed] = useState(false)")
      // Reset at the top of load(), or a recovered page stays stuck on the copy.
      expect(src).toMatch(/setLoading\(true\);\s*setLoadFailed\(false\);/)
      // And the thrown path must set it too, not only the non-ok path.
      expect(src).toMatch(/\} catch \{\s*setLoadFailed\(true\);/)
    })

    it("the ship queue reports a failed read instead of claiming it is clear", () => {
      expect(src).toContain("{loadFailed ? (")
      expect(src).toMatch(/Couldn&apos;t load redemptions/)
      // Ordering: the failure branch must precede the emptiness test.
      expect(src.indexOf("Couldn&apos;t load redemptions")).toBeLessThan(
        src.indexOf("Nothing waiting to ship."),
      )
    })

    it("BOTH directions: a genuinely empty queue still says so", () => {
      // A fix that blanked every empty state would only move the dishonesty —
      // and "Nothing waiting to ship." is the correct, useful answer on a clear
      // queue, which is most days.
      expect(src).toContain("Nothing waiting to ship.")
      expect(src).toContain("No participants yet.")
    })
  })

  // ⚠⚠ THE SIBLING PAGE WAS MISSED FOR MONTHS, WHICH IS THE POINT OF THIS BLOCK.
  // The /admin/rewards fix above was correct and is pinned — and the USER-FACING
  // /rewards page carried the IDENTICAL shape the whole time: `load()` checked
  // `res.status === 401` and nothing else, so any other non-2xx fell through to
  // `data.x ?? []` and rendered a confident set of zeros. Fixing one copy and
  // never grepping for the other is this repo's most-repeated lesson.
  //
  // ⚠ It also had a SECOND, server-side half the admin page did not: the route
  // returned `redemptions: redemptions.data ?? []` at HTTP 200, and supabase-js
  // RETURNS errors rather than throwing — so a failed read became an empty array
  // that no client check could detect. The comment directly BELOW that line, on
  // `referralCount`, already explained the trap in full. Three lines apart.
  describe("/rewards — a failed load is not an empty account", () => {
    const src = stripComments(read("app", "rewards", "page.tsx"))
    const route = stripComments(read("app", "api", "rewards", "summary", "route.ts"))

    it("checks res.ok, not just 401", () => {
      expect(
        src,
        "401 alone lets a 500 render 0 points, no referrals and an empty history",
      ).toMatch(/if \(!res\.ok\) \{\s*setLoadFailed\(true\);/)
    })

    it("tracks the failure separately, resets it on re-load, and covers the thrown path", () => {
      expect(src).toContain("const [loadFailed, setLoadFailed] = useState(false)")
      expect(src).toMatch(/async \(\) => \{\s*setLoadFailed\(false\);/)
      expect(src).toMatch(/\} catch \{\s*setLoadFailed\(true\);/)
    })

    it("the page reports a failed read instead of rendering an empty account", () => {
      expect(src).toContain("loadFailed ? (")
      expect(src).toMatch(/Couldn&apos;t load your rewards/)
    })

    it("the ROUTE carries the redemptions read failure instead of coercing it to []", () => {
      // `?? []` on a supabase read that RETURNS its error is a fabricated empty.
      expect(route).toContain("redemptions: redemptions.error ? null : (redemptions.data ?? [])")
      expect(route).not.toMatch(/redemptions: redemptions\.data \?\? \[\],/)
    })

    it("and the client distinguishes that null from a genuinely empty history", () => {
      expect(src).toContain("const [redemptionsFailed, setRedemptionsFailed] = useState(false)")
      expect(src).toContain("setRedemptionsFailed(data.redemptions === null)")
      // Ordering: the failure branch must precede the emptiness test.
      expect(src.indexOf("{redemptionsFailed ? (")).toBeGreaterThan(-1)
      expect(src.indexOf("{redemptionsFailed ? (")).toBeLessThan(src.indexOf("Nothing redeemed yet."))
    })

    it("BOTH directions: a genuinely empty history still says so", () => {
      // The correct answer for a collector who has redeemed nothing, which is
      // most of them — a fix that deleted this would only move the dishonesty.
      expect(src).toContain("Nothing redeemed yet.")
    })
  })
})
