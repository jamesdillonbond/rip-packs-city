import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
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

/** Cards that render a board list and therefore carry the empty/failed states. */
function boardCards(): string[] {
  return readdirSync(INSIGHTS_OG)
    .filter((d) => {
      const p = join(INSIGHTS_OG, d, "route.tsx")
      try {
        if (!statSync(p).isFile()) return false
      } catch {
        return false
      }
      return readFileSync(p, "utf8").includes("boardEmptyCopy(")
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

  it("no card still hardcodes the impossible 'Loading…' claim", () => {
    // The literal, swept across the WHOLE directory rather than just the cards
    // already converted — so reintroducing it anywhere reds this.
    const offenders = readdirSync(INSIGHTS_OG)
      .map((d) => ({ d, p: join(INSIGHTS_OG, d, "route.tsx") }))
      .filter(({ p }) => {
        try {
          return statSync(p).isFile()
        } catch {
          return false
        }
      })
      .filter(({ p }) => /Loading the live/.test(readFileSync(p, "utf8")))
      .map(({ d }) => d)
    expect(offenders).toEqual([])
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
