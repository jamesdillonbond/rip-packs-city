import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

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

const SRC = readFileSync(
  join(process.cwd(), "app", "(collections)", "[collection]", "analytics", "page.tsx"),
  "utf8",
)

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
    // ...and it really is the readiness probe: the fetch is within a few lines above.
    const [, lineIdx] = swallows[0]
    const context = lines.slice(Math.max(0, lineIdx - 10), lineIdx).join("\n")
    expect(context, "the surviving swallow must be the /api/ready probe").toContain('fetch("/api/ready"')
  })
})
