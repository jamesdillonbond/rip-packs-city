import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, sep } from "node:path"
import { NextRequest } from "next/server"
import { installOgCapture, resetOgCapture, ogText, type OgCapture } from "./helpers/og-capture"
import { boardEmptyCopy } from "@/lib/og/board-empty-copy"

// Directory-driven guard for the /insights OG cards' empty-vs-unavailable state.
//
// ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
// Fifteen cards printed `Loading the live board…` whenever they had no rows. An
// OG card is a static, edge-cached PNG: by the time that line renders the fetch
// has already finished, nothing is loading, and nothing ever will be. A card
// generated during a brief outage kept telling every social feed the board was
// "loading" long after it recovered.
//
// It was also the SAME line for both an empty board and a failed read — the
// conflation this repo has now fixed at the API layer (lib/api-error.ts), the
// server-page layer (lib/insights/board-status.ts), the client layer
// (lib/analytics/fetch-json.ts) and the concierge prompt. This is the OG layer,
// and it was the last one still saying the two out loud in one voice.
//
// ── WHY DIRECTORY-DRIVEN ────────────────────────────────────────────────────
// The defect spread by copy-paste across fifteen near-identical files, which is
// exactly how the 23505 batch-insert bug reached five sales indexers. Enumerating
// the directory means a SIXTEENTH card added tomorrow is covered without anyone
// remembering to add it here — the property the api-route-tsx-test-completeness
// and component-gate-include-completeness guards are both built on.
//
// Each card is driven both ways and must make two DISTINCT claims:
//   empty + ok    → "nothing qualifying" (a claim about the MARKET — true)
//   fetch failed  → "couldn't load"      (a claim about US — also true)

const INSIGHTS_OG = join(process.cwd(), "app", "api", "og", "insights")
const ALL_OG = join(process.cwd(), "app", "api", "og")

/**
 * `//`-comment lines removed.
 *
 * ⚠ Required, not tidiness. This sweep's first run reported exactly one
 * offender: the comment in `og/fast-break/route.tsx` DOCUMENTING the fix, which
 * quotes the old copy verbatim. That is the THIRD time in this session a source
 * check has read its own explanation as evidence (the analytics guard, an
 * ad-hoc verification script, now this). Any check that greps source for user
 * copy must strip comments — including the one you are about to write.
 */
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .join("\n")
}

/** Every `route.tsx` under app/api/og, at any depth. */
function allOgRoutes(dir: string = ALL_OG, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) allOgRoutes(full, out)
    // Normalised to forward slashes: every consumer below matches on "/og/..."
    // literals, and join() yields backslashes on Windows -- which made the
    // not-vacuous check unsatisfiable there (guard green in CI, dead locally).
    // Normalised to forward slashes via path.sep: every consumer below matches
    // on "/og/..." literals, while join() yields backslashes on Windows -- which
    // made the not-vacuous check below unsatisfiable there, so this guard was
    // green in CI and structurally dead on the primary dev machine.
    else if (entry === "route.tsx") out.push(full.split(sep).join("/"))
  }
  return out
}

/**
 * Cards that render a board list and therefore carry the empty/failed states.
 *
 * 🚨 `stripComments` here is LOAD-BEARING, and its absence was a live defect
 * found on 2026-08-27. This selector used the RAW source, so a card that merely
 * MENTIONED `boardEmptyCopy(` in a comment was enrolled in the population — and
 * then failed every fetch-driven assertion below, because mentioning a helper
 * does not make a card fetch-shaped. `/api/og/insights/candy-mlb` hit exactly
 * that: it reads `supabaseAdmin` directly (deliberately — a self-fetch is 302'd
 * to /login while the surface is launch-gated), and a comment EXPLAINING why it
 * cannot adopt the helper enrolled it in the guard for the helper.
 *
 * ⭐ This file already warned about precisely this, one function up — *"Any
 * check that greps source for user copy must strip comments — including the one
 * you are about to write."* That warning was written for the `loading`-claim
 * sweep and not applied to the selector sitting directly beneath it. A guard's
 * POPULATION is as comment-sensitive as its assertions, and it is the half
 * nobody re-checks, because a wrong population still reports a number.
 */
function boardCards(): string[] {
  return readdirSync(INSIGHTS_OG)
    .filter((d) => {
      const p = join(INSIGHTS_OG, d, "route.tsx")
      try {
        if (!statSync(p).isFile()) return false
      } catch {
        return false
      }
      return stripComments(readFileSync(p, "utf8")).includes("boardEmptyCopy(")
    })
    .sort()
}

const capture: { c: OgCapture | null } = { c: null }

function mockFetch(mode: "empty" | "fail") {
  globalThis.fetch = vi.fn(async () => {
    if (mode === "fail") return new Response("upstream is down", { status: 503 })
    // Only the EMPTY-but-successful shape is needed; see the note on the deleted
    // third case for why no rows fixture is invented here.
    return new Response(JSON.stringify({ rows: [], data: [], meta: { total_rows: 0 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof globalThis.fetch
}

async function render(slug: string) {
  const mod = await import(`@/app/api/og/insights/${slug}/route`)
  await mod.GET(new NextRequest(`https://www.rippackscity.com/api/og/insights/${slug}`))
  return ogText(capture.c!.element())
}

beforeEach(() => {
  resetOgCapture()
  capture.c = installOgCapture()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  resetOgCapture()
})

describe("insights OG cards distinguish an empty board from an unreadable one", () => {
  const cards = boardCards()

  it("finds the card family (the guard is not vacuously passing)", () => {
    // If the enumerator ever returns nothing, every it.each below silently
    // vanishes and this file reports green while testing zero cards.
    expect(cards.length).toBeGreaterThanOrEqual(15)
  })

  it("NO card anywhere under app/api/og hardcodes an impossible 'loading' claim", () => {
    // ⚠ SCOPE — this sweep walks the WHOLE og tree, not just og/insights, and
    // that widening is itself a finding. The first version of this guard walked
    // `INSIGHTS_OG`, so it was silent by construction about
    // `app/api/og/fast-break`, which carried "Tonight's slate is still loading."
    // for weeks after the 15 insights cards were fixed. Same lesson this repo
    // keeps relearning (the anon driver-message guard, the server-page guard's
    // 2-of-79 list, insights-gate-include-completeness) — a guard that derives
    // its inputs from a narrow predicate is fixed to that predicate's scope.
    // Here it was MY OWN guard.
    //
    // An OG card is a static, edge-cached PNG. By the time any string renders
    // the fetch has finished, so no card may claim to be loading, whatever
    // directory it lives in.
    const offenders = allOgRoutes()
      .filter((p) => /still loading|Loading the live|Loading…/i.test(stripComments(readFileSync(p, "utf8"))))
      .map((p) => p.replace(process.cwd().split(sep).join("/") + "/", ""))
    expect(offenders, `cards claiming to be loading:\n${offenders.join("\n")}`).toEqual([])
  })

  it("the tree sweep is not vacuously passing", () => {
    // If the walk ever returns nothing the assertion above passes for free.
    const all = allOgRoutes()
    expect(all.length).toBeGreaterThanOrEqual(40)
    expect(all.some((p) => p.includes("/og/fast-break/"))).toBe(true)
    expect(all.some((p) => p.includes("/og/insights/"))).toBe(true)
  })

  it.each(boardCards().map((c) => [c]))(
    "%s — a read that FAILED says so, and does not claim the board is empty",
    async (slug) => {
      mockFetch("fail")
      const text = await render(slug)
      expect(text).toContain("Couldn't load the live")
      expect(text).not.toContain("Nothing qualifying")
      expect(text).not.toContain("Loading the live")
    },
  )

  it.each(boardCards().map((c) => [c]))(
    "%s — a read that SUCCEEDED with zero rows makes the opposite claim",
    async (slug) => {
      // The positive mirror. Without it, a card hardwired to "couldn't load"
      // would pass every failure case above while lying in the common case.
      mockFetch("empty")
      const text = await render(slug)
      expect(text).toContain("Nothing qualifying on the")
      expect(text).not.toContain("Couldn't load")
    },
  )

  // ⚠ A THIRD behavioural case — "with rows, neither empty line appears" — was
  // written and then DELETED rather than tuned to green, and the reason is worth
  // more than the case would have been.
  //
  // It needs a fixture matching each card's real row shape, and the fifteen cards
  // read fifteen different ones. A single generic fixture satisfied ten and left
  // five rendering the empty state — so "passing" would have meant my invented
  // shape happened to fit, and "failing" said nothing about the product. That is
  // the impossible-fixture trap this repo has already hit twice (a test running
  // on a `costBasisLabel` the vocabulary never emits): a green test whose input
  // real data never produces asserts nothing at all.
  //
  // The rows-render path is already covered where it belongs — per-card, against
  // real shapes, by api-og-cards-render-sweep and the per-card data-branch suites.
  // What is unique to THIS file is the two states that were previously one, and
  // they are shape-independent.
  //
  // Instead, the same property is asserted structurally: the empty copy must sit
  // inside a rows-empty branch, so it is unreachable whenever rows exist.
  it.each(boardCards().map((c) => [c]))(
    "%s — the empty copy is reachable only when there are no rows",
    (slug) => {
      const src = readFileSync(join(INSIGHTS_OG, slug, "route.tsx"), "utf8")
      const call = src.indexOf("boardEmptyCopy(fetched")
      expect(call).toBeGreaterThan(-1)
      // ⚠ Asserted spelling-INDEPENDENTLY, on purpose. The obvious check —
      // "a `.length === 0` precedes it" — is what I wrote first, and `market`
      // reds it: that card's emptiness test is `heads.every(h => h.median == null)`,
      // which is just as correct. Enumerating emptiness spellings is the brittle
      // path that eventually gets a real card excluded to make a build pass.
      // What is universal is the SHAPE: the copy sits in the first arm of a
      // ternary whose second arm renders the rows.
      const before = src.slice(0, call)
      expect(before, "empty copy must be the first arm of a conditional").toMatch(/\? \([\s\S]{0,400}$/)
      expect(src.slice(call), "...whose alternative renders the rows").toMatch(/^[\s\S]{0,400}?\) : \(/)
      // And `fetched` must be set INSIDE an ok branch, never at the top of the
      // try — otherwise a failed read would report itself as an empty board.
      expect(src).toMatch(/if \(r\d?\.ok\) \{\n\s+fetched = true/)
      expect(src).not.toMatch(/let fetched = true/)
    },
  )
})

describe("boardEmptyCopy", () => {
  it("makes a claim about the MARKET when the read succeeded", () => {
    expect(boardEmptyCopy(true, "board")).toBe("Nothing qualifying on the board right now.")
  })

  it("makes a claim about US when it did not", () => {
    expect(boardEmptyCopy(false, "cohort")).toBe(
      "Couldn't load the live cohort — open the page for current data.",
    )
  })

  it("defaults the noun to 'board'", () => {
    expect(boardEmptyCopy(true)).toContain("the board")
  })

  it("never implies the card will update itself", () => {
    // A card is generated once and cached. Any wording that suggests a retry or
    // a pending state is the defect this module replaced.
    for (const copy of [boardEmptyCopy(true), boardEmptyCopy(false)]) {
      expect(copy).not.toMatch(/loading|refreshing|updating|one moment|please wait/i)
    }
  })
})
