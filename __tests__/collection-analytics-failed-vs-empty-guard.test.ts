import { describe, it, expect } from "vitest"
import { pageSource } from "./helpers/page-source"

// Source guard for the failed-vs-empty split on the per-collection Analytics tab.
//
// ── WHY A SOURCE GUARD AND NOT A RENDER TEST ────────────────────────────────
// `app/(collections)/[collection]/analytics/page.tsx` is a `"use client"`
// `page.tsx`: the component gate's include is `app/**/*Client.tsx`, which does
// not match it, and the primary gate does not look at `app/**/page.tsx` at all.
// So this 1,700-line file is measured by NEITHER gate, and a source property is
// the only automated check available — the same reasoning that produced
// server-pages-error-vs-absent-guard.test.ts for the server side.
//
// The durable fix is to split the client body into a `*Client.tsx` (that glob IS
// gated) and then drive these branches for real; `client-page-gate-ratchet`
// tracks that backlog. Until then this pins the behaviour so it cannot silently
// regress back.
//
// ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
// Five sections fetched like this:
//
//     .then((r) => (r.ok ? r.json() : null))
//     .then((j) => { if (!cancelled && j) setData(j) })
//     .catch(() => {})
//
// A 503 statement timeout, a network blip and a genuinely empty result all land
// in the same place: `data` keeps its initial value and the section renders its
// EMPTY state — "No live listings.", "No FMV coverage yet.", "No data." Each of
// those is a positive claim about the MARKET manufactured from OUR outage.
//
// ⚠ The evidence this was drift and not a design choice: the market-analytics
// section in the SAME FILE already carried a `marketFailed` flag with a comment
// explaining exactly this distinction. It was understood, and applied to one
// section out of six.

// The page AS A UNIT — shell plus any sibling `*Client.tsx`. This tab is still a
// single `page.tsx` today, so this reads identically; it is written this way so
// the `*Client.tsx` conversion (which reddened four sibling guards on 2026-08-16
// by moving their subject, not by changing behaviour) lands here as a no-op.
const SRC = pageSource("app", "(collections)", "[collection]", "analytics")

/** The components that fetch their own section data and must track failure. */
const SECTIONS = [
  "OrderBookCard",
  "FmvHealthCard",
  "PackEvCard",
  "WhaleLeaderboard",
] as const

/** Source with `//` comment lines removed. */
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n")
}

/**
 * Body of a top-level `function Name(` up to the next top-level `function `.
 *
 * ⚠ Comments are STRIPPED, and that is not tidiness — the first draft of the
 * ordering assertion below failed against correct code because the fix is
 * documented in prose that QUOTES the old empty-state copy ("No data."), so the
 * search found the comment rather than the JSX. `pack-dist-contents-not-streamed`
 * carries the same note for the same reason; a guard that reads its own
 * explanation as evidence is worse than no guard.
 */
function componentBody(name: string): string {
  const start = SRC.indexOf(`function ${name}(`)
  expect(start, `${name} must exist`).toBeGreaterThan(-1)
  const next = SRC.indexOf("\nfunction ", start + 1)
  return stripComments(SRC.slice(start, next === -1 ? undefined : next))
}

describe("collection analytics — a failed section read is not an empty market", () => {
  it("the pre-existing market-analytics flag is still there (the pattern being followed)", () => {
    // If this ever disappears, the four below are imitating something that no
    // longer exists and the reviewer should be told.
    expect(SRC).toContain("setMarketFailed(true)")
    expect(SRC).toContain("marketFailed")
  })

  it.each(SECTIONS.map((s) => [s]))("%s tracks a failed read separately from an empty one", (name) => {
    const body = componentBody(name)

    expect(body, "must declare a failure flag").toContain("const [failed, setFailed] = useState(false)")
    // Reset on each run, or a recovered section keeps showing the failure.
    expect(body, "must clear the flag when the fetch restarts").toContain("setFailed(false)")
    // Set on BOTH the non-2xx path and the thrown path. supabase/fetch surface
    // those differently and covering only one leaves half the class live.
    expect(body, "must set the flag on a null body").toContain("setFailed(true)")
    expect(body, "must set the flag from .catch").toMatch(
      /\.catch\(\(\)\s*=>\s*\{\s*if \(!cancelled\) setFailed\(true\)\s*\}\)/,
    )
    // The empty-swallowing shape must be gone.
    expect(body, "the bare swallow must not come back").not.toMatch(/\.catch\(\(\)\s*=>\s*\{\s*\}\)/)
  })

  it.each([
    ["OrderBookCard", "No live listings.", "Couldn&apos;t load the order book."],
    ["FmvHealthCard", "No FMV coverage yet.", "Couldn&apos;t load FMV health."],
    ["PackEvCard", "Pack analytics not yet available", "Couldn&apos;t load pack analytics."],
    ["WhaleLeaderboard", "No data.", "Couldn&apos;t load this leaderboard."],
  ])("%s renders DIFFERENT copy for failed vs empty, failure first", (name, emptyCopy, failCopy) => {
    const body = componentBody(name)

    expect(body, "the empty-state copy must survive — an empty market is a real answer").toContain(emptyCopy)
    expect(body, "a distinct failure copy must exist").toContain(failCopy)
    // Ordering is what makes the fix non-inert: the `failed` branch has to be
    // evaluated BEFORE the emptiness test, or a failed read still reports empty.
    expect(
      body.indexOf(failCopy),
      "the failed branch must precede the empty branch",
    ).toBeLessThan(body.indexOf(emptyCopy))
  })

  it("the liquidity heatmap section is covered too", () => {
    // It is an arrow-assigned component rather than a `function` declaration, so
    // it is checked by copy rather than through componentBody.
    expect(SRC).toContain("Couldn&apos;t load the liquidity heatmap.")
    expect(SRC).toContain("No liquidity data for this collection.")
    expect(SRC.indexOf("Couldn&apos;t load the liquidity heatmap.")).toBeLessThan(
      SRC.indexOf("No liquidity data for this collection."),
    )
  })

  it("the leaderboard requires BOTH legs, not `?? []` per leg", () => {
    // `setBuyers(b?.rows ?? [])` renders "No data." — a claim that nobody traded
    // — whenever one of the two parallel fetches fails.
    const body = componentBody("WhaleLeaderboard")
    expect(body).toContain("if (!b?.rows || !s?.rows) { setFailed(true); return }")
    expect(body, "the per-leg empty coalesce must be gone").not.toContain("?.rows as LeaderboardRow[]) ?? []")
  })

  it("exactly ONE bare swallow remains, and it is the readiness probe", () => {
    // A whole-file sweep, so a SEVENTH section added later with the old shape
    // reds this even though it appears in no list above.
    //
    // ⚠ The survivor is deliberate and CATEGORICALLY different. The `/api/ready`
    // probe only decides whether to show a THIN-VOLUME CAVEAT. Failing closed
    // omits a warning; it does not assert anything. Converting it would mean
    // either showing a caveat we could not substantiate — a false claim of its
    // own — or adding a failure state with nothing to render. The five sections
    // above are the opposite: each one manufactures a positive claim about the
    // market from a read that never completed.
    //
    // Pinned by COUNT AND IDENTITY rather than allowlisted by name alone, so a
    // second one cannot quietly join it under the same exemption.
    const lines = SRC.split("\n")
    const swallows = lines
      .map((l, i) => [l, i] as const)
      .filter(([l]) => /\.catch\(\(\)\s*=>\s*\{\s*\}\)/.test(l))
    expect(
      swallows.length,
      `bare .catch(() => {}) sites:\n${swallows.map(([l, i]) => `  ${i + 1}: ${l.trim()}`).join("\n")}`,
    ).toBe(1)
    // ...and it really is the readiness probe.
    //
    // ⚠ ANCHOR ON THE NEAREST `fetch(` ABOVE, not on a fixed 10-line window.
    // The window version broke on 2026-08-23 for a reason that had nothing to
    // do with what it guards: a COMMENT was added above the swallow explaining
    // the thin_volume change, which pushed the `fetch(` out of view and the
    // guard reported that the surviving swallow was no longer the readiness
    // probe. It still was. A proximity guard measured in LINES is really
    // measuring how much you documented, and documenting more must not look
    // like a regression. Walking back to the nearest fetch is exact, and it
    // still fails if a DIFFERENT fetch's swallow ever becomes the survivor.
    const [, lineIdx] = swallows[0]
    let fetchIdx = -1
    for (let i = lineIdx; i >= 0; i--) {
      if (/\bfetch\s*\(/.test(lines[i])) { fetchIdx = i; break }
    }
    expect(fetchIdx, "no fetch( found above the surviving swallow").toBeGreaterThanOrEqual(0)
    expect(lines[fetchIdx], "the surviving swallow must belong to the /api/ready probe").toContain(
      'fetch("/api/ready"',
    )
  })

  // ── The BLOCK-form swallow, which the census above could not see ───────────
  //
  // ⚠ THE CENSUS ABOVE MATCHES `.catch(() => {})` — THE ARROW FORM ONLY. The
  // player search used the statement form:
  //
  //     try { ... } catch { /* swallow */ } finally { setPlayerLoading(false) }
  //
  // so it sat outside that sweep BY CONSTRUCTION, however often the guard ran
  // green. This is the same shape this repo keeps re-finding — the anon
  // driver-message guard scoped to the anon wall, insights-gate-include-
  // completeness walking only INSIDS_DIR, the error-vs-absent guard naming the
  // wrong `analytics/wallets` page. A guard's own predicate decides its blast
  // radius. When you add one, ask what spelling it is silent about.
  it("no BLOCK-form swallow hides a failed fetch either", () => {
    // ⚠ COMMENTS STRIPPED FIRST, and this one bit immediately: the fix for the
    // player search is documented in prose that QUOTES the old
    // `catch { /* swallow */ }` verbatim, so the first run of this census
    // reported the comment explaining the fix as the defect. Fourth instance of
    // that trap in this repo, and the second in this very file — see
    // componentBody() above, which carries the same note.
    const STRIPPED = stripComments(SRC)
    const blockSwallows = [...STRIPPED.matchAll(/catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\*[^*]*\*\/)?\s*\}/g)]
      .map((m) => STRIPPED.slice(0, m.index ?? 0).split("\n").length)
      // The router.replace() guard is not a fetch — a failed history update has
      // nothing to render and asserts nothing.
      .filter((ln) => {
        const ctx = STRIPPED.split("\n").slice(Math.max(0, ln - 6), ln).join("\n")
        return !ctx.includes("router.replace")
      })
    expect(
      blockSwallows,
      "a try/catch around a fetch must set a failure flag, not swallow — otherwise " +
        "the section renders an empty state that makes a claim about the market."
    ).toEqual([])
  })

  it("a failed PLAYER SEARCH does not claim the player has no activity", () => {
    // Two defects lived here, and the second is the worse one:
    //   1. A failed search rendered pickEmpty() — "Quiet on the court for now."
    //      — a claim about THAT PLAYER, manufactured from our own outage.
    //   2. setPlayerResults was called only on `!q` or `res.ok`, so a failed
    //      search LEFT THE PREVIOUS PLAYER'S ROWS ON SCREEN: search Lillard, get
    //      rows; search Curry, have it fail, and Lillard's numbers stayed under
    //      "Curry" in the input. One player's market data labelled as another's,
    //      with nothing on screen suggesting a problem.
    expect(SRC, "must track search failure separately from emptiness").toContain("playerFailed")
    expect(SRC, "a non-ok response must set the failure flag").toMatch(
      /} else \{\s*setPlayerFailed\(true\)\s*\}/
    )
    expect(SRC, "a thrown fetch must set it too").toMatch(/catch \{ setPlayerFailed\(true\) \}/)
    expect(
      SRC,
      "the flag must be cleared when a new query starts, or a recovered search stays red"
    ).toContain("setPlayerFailed(false)")
    expect(
      SRC,
      "the previous player's rows must be dropped before the new request — they " +
        "answer a question the user is no longer asking"
    ).toMatch(/setPlayerLoading\(true\)[\s\S]{0,300}?setPlayerResults\(null\)/)

    // And the copy must distinguish the two. The failure branch has to precede
    // the empty branch, or an empty result set renders the outage message.
    const failIdx = SRC.indexOf("Couldn&apos;t load player results")
    const emptyIdx = SRC.indexOf("{pickEmpty()}")
    expect(failIdx, "a distinct failure message must exist").toBeGreaterThan(-1)
    expect(
      failIdx,
      "the playerFailed branch must be checked BEFORE the empty branch"
    ).toBeLessThan(emptyIdx)

    // ⚠ Both directions. A genuinely empty result is an honest answer and must
    // keep rendering as one — a fix that turned every empty search into
    // "couldn't load" would just move the dishonesty.
    expect(SRC, "a genuinely empty search must still say so").toContain("{pickEmpty()}")
  })
})
