import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

import { boardRowMeta, boardRowMetaComplete, boardCountFloor } from "@/lib/insights/board-meta"
import { fetchBoardCount, boardCountLabel } from "@/lib/og/board-count"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// The headline count on an insights OG card must never be a PAGE LENGTH.
//
// ── THE DEFECT THIS PINS (measured live 2026-08-15) ────────────────────────
// Every /api/public/insights/** route published `meta.total_rows: data?.length`
// — the length of the CAPPED page, under a name that means the opposite. Six OG
// cards read it as a board total, and three read it off the SAME `limit=3`
// request they used to render their top-3 rows:
//
//   card                  published            true value
//   top-sales             "3 sales this week"      30,592
//   serial-premiums       "3 editions tracked"          —
//   underpriced-serials   "3 live deals"                —
//   squeeze               "200 editions squeezed"    1,352
//   trophies              "500 grails ranked"          842
//
// An OG card is a static, edge-cached PNG that is only ever seen in someone
// else's timeline, so these were simultaneously the most wrong and the least
// observable numbers on the platform.
//
// Two layers are pinned here: the arithmetic (`boardRowMeta` / `boardCountFloor`
// / `boardCountLabel`) and — because the arithmetic being right does not stop a
// future card wiring itself to the page again — a SOURCE guard over the whole
// og/insights tree.

const ROOT = process.cwd()
const OG_INSIGHTS = path.join(ROOT, "app", "api", "og", "insights")

/*
 * ⚠ MIGRATED 2026-08-22 to the ONE shared stripper (scripts/lib/strip-comments.mjs).
 * The local copy stripped BLOCK comments before LINE comments, so an ordinary
 * line comment mentioning a glob path opened a block comment running to the next
 * close-comment anywhere in the file, blanking real source this guard then
 * reported as clean (103,590 chars across 49 product files). The shared version
 * blanks rather than deletes, so offsets and line numbers survive.
 * Do not re-inline a local copy.
 */

function ogRoutes(): { name: string; src: string }[] {
  const out: { name: string; src: string }[] = []
  for (const entry of readdirSync(OG_INSIGHTS)) {
    const f = path.join(OG_INSIGHTS, entry, "route.tsx")
    try {
      if (statSync(f).isFile()) out.push({ name: entry, src: readFileSync(f, "utf8") })
    } catch {
      /* not a card dir */
    }
  }
  return out
}

describe("boardRowMeta — total_rows is disclosed as a page length", () => {
  it("marks a filled page as truncated", () => {
    expect(boardRowMeta(200, 200)).toEqual({ total_rows: 200, returned_rows: 200, truncated: true })
  })

  it("does NOT mark a short page as truncated", () => {
    expect(boardRowMeta(90, 100)).toEqual({ total_rows: 90, returned_rows: 90, truncated: false })
  })

  it("treats an over-length page as truncated (>= not ===)", () => {
    // A page can only meet or fall short of its cap; calling an over-length read
    // complete is the wrong direction to be wrong.
    expect(boardRowMeta(201, 200).truncated).toBe(true)
  })

  it("keeps total_rows for backward compatibility rather than removing it", () => {
    // The concierge's fetchPublicInsight and external consumers still read it.
    // Dropping the field would break them; the fix is the honest sibling fields.
    expect(boardRowMeta(5, 100)).toHaveProperty("total_rows", 5)
  })

  it("a null/undefined row count is 0, not NaN", () => {
    expect(boardRowMeta(null, 100).returned_rows).toBe(0)
    expect(boardRowMeta(undefined, 100).returned_rows).toBe(0)
  })

  it("a paged read is never truncated, even at a round number", () => {
    expect(boardRowMetaComplete(200).truncated).toBe(false)
  })
})

describe("boardCountFloor — the '+' is the claim", () => {
  it("renders a plain count when the read was complete", () => {
    expect(boardCountFloor(1352, false)).toBe("1,352")
  })

  it("renders a FLOOR when the read was capped", () => {
    expect(boardCountFloor(200, true)).toBe("200+")
  })
})

describe("boardCountLabel — a failed read never becomes a number", () => {
  it("falls back rather than printing a zero when the count could not be read", () => {
    // A failed read is not a board with nothing in it. This is the same
    // failed-read-renders-as-an-answer class the OG empty-copy helper exists for.
    expect(boardCountLabel(null, "sales this week")).toBe("Public · No signup")
  })

  it("falls back on a genuine zero too (a card must not say '0 sales this week')", () => {
    expect(boardCountLabel({ count: 0, truncated: false }, "sales this week")).toBe(
      "Public · No signup",
    )
  })

  it("labels a complete count exactly", () => {
    expect(boardCountLabel({ count: 842, truncated: false }, "grails ranked")).toBe(
      "842 grails ranked",
    )
  })

  it("labels a capped count as a floor", () => {
    expect(boardCountLabel({ count: 500, truncated: true }, "grails ranked")).toBe(
      "500+ grails ranked",
    )
  })
})

describe("fetchBoardCount", () => {
  const origin = "https://example.test"

  function mockFetch(impl: (url: string) => Response | Promise<Response>) {
    globalThis.fetch = ((url: any) => Promise.resolve(impl(String(url)))) as any
  }

  it("requests the route's MAX limit, not the display page size", async () => {
    let seen = ""
    mockFetch((url) => {
      seen = url
      return new Response(JSON.stringify({ meta: { returned_rows: 200, truncated: true } }), {
        status: 200,
      })
    })
    await fetchBoardCount(origin, "/api/public/insights/top-sales?window=7d", 200)
    // The whole defect was reading the count off a limit=3 request.
    expect(seen).toContain("limit=200")
    expect(seen).not.toContain("limit=3")
  })

  it("appends limit with & when the path already has a query string", async () => {
    let seen = ""
    mockFetch((url) => {
      seen = url
      return new Response(JSON.stringify({ meta: { returned_rows: 1 } }), { status: 200 })
    })
    await fetchBoardCount(origin, "/api/public/insights/x?sort=fmv", 100)
    expect(seen).toBe("https://example.test/api/public/insights/x?sort=fmv&limit=100")
  })

  it("uses ? when the path has no query string", async () => {
    let seen = ""
    mockFetch((url) => {
      seen = url
      return new Response(JSON.stringify({ meta: { returned_rows: 1 } }), { status: 200 })
    })
    await fetchBoardCount(origin, "/api/public/insights/x", 100)
    expect(seen).toBe("https://example.test/api/public/insights/x?limit=100")
  })

  it("prefers returned_rows over the deprecated total_rows alias", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ meta: { returned_rows: 7, total_rows: 999 } }), { status: 200 }),
    )
    expect((await fetchBoardCount(origin, "/x", 100))?.count).toBe(7)
  })

  it("derives truncated from the cap when the API predates the field", async () => {
    // Older responses carry only total_rows. Deriving can only ADD a '+', which
    // is the safe direction.
    mockFetch(() => new Response(JSON.stringify({ meta: { total_rows: 100 } }), { status: 200 }))
    const c = await fetchBoardCount(origin, "/x", 100)
    // ⚠ toMatchObject, not toEqual. This test is about the DERIVATION of
    // `truncated`, and a whole-shape equality made it fail the day
    // `fetchBoardCount` started handing back the rows it had already parsed
    // (lib/og/board-freshness.ts needs them) — a red on an assertion that was
    // never about the shape. Pin the property, not the spelling.
    expect(c).toMatchObject({ count: 100, truncated: true })
  })

  it("returns null on a non-ok response — NOT a zero", async () => {
    mockFetch(() => new Response("nope", { status: 503 }))
    expect(await fetchBoardCount(origin, "/x", 100)).toBeNull()
  })

  it("returns null when fetch throws", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("network"))) as any
    expect(await fetchBoardCount(origin, "/x", 100)).toBeNull()
  })

  it("returns null on a malformed count rather than publishing NaN", async () => {
    mockFetch(
      () => new Response(JSON.stringify({ meta: { returned_rows: "lots" } }), { status: 200 }),
    )
    expect(await fetchBoardCount(origin, "/x", 100)).toBeNull()
  })
})

describe("SOURCE guard — no insights OG card derives its headline count from a page", () => {
  const routes = ogRoutes()

  it("is not vacuous: it found the card tree", () => {
    expect(routes.length).toBeGreaterThan(15)
    expect(routes.map((r) => r.name)).toContain("top-sales")
    expect(routes.map((r) => r.name)).toContain("squeeze")
  })

  it("no card reads meta.total_rows directly — that field is a page length", () => {
    const offenders = routes
      .filter((r) => /meta\?\.total_rows|meta\.total_rows/.test(stripComments(r.src)))
      .map((r) => r.name)
    expect(
      offenders,
      `These cards read the capped page length as a board total. Use fetchBoardCount(origin, path, <route max limit>) instead:\n  ${offenders.join("\n  ")}`,
    ).toEqual([])
  })

  // ⚠ A BROADER SHAPE RULE WAS TRIED AND REJECTED, and the reason is worth
  // keeping. "Any card interpolating a `count > 0 ? …` into its header must use
  // boardCountLabel" flags four cards whose counts are perfectly sound, because
  // the defect is not "publishes a count" — it is "publishes a count derived
  // from a CAPPED page". Verified individually 2026-08-15:
  //
  //   pack-drops      meta.total_drops   — fetchScoredDrops takes NO limit
  //   pack-sniper     stats.positiveEv   — counted over all listings BEFORE the
  //                                        deals.slice(0, limit)
  //   set-completers  rows.reduce(...)   — that route has no limit at all
  //   rookies         cohort_stats.rookie_count — a real cohort aggregate
  //
  // Forcing those through boardCountLabel would REPLACE four exact counts with
  // floors — making accurate cards less accurate to satisfy a guard. Whether a
  // count is page-derived is not decidable from the card's own source, so the
  // rule below pins the six cards that DO take a capped count, and the
  // total_rows rule above is what catches the general case.
  it("the six count-taking cards route their headline through boardCountLabel", () => {
    const COUNT_CARDS = [
      "top-sales",
      "serial-premiums",
      "underpriced-serials",
      "set-squeeze",
      "trophies",
      "squeeze",
    ]
    const missing = COUNT_CARDS.filter((name) => {
      const r = routes.find((x) => x.name === name)
      if (!r) return true
      const src = stripComments(r.src)
      // ⚠ Match the CALL forms `boardCountLabel(` / `fetchBoardCount(`, not the
      // bare identifiers. Mutation-checked: a card that keeps the import while
      // hand-rolling `${count.count} sales this week` in its JSX satisfies a
      // plain `includes("boardCountLabel")` and slips straight through.
      return !/\bboardCountLabel\(/.test(src) || !/\bfetchBoardCount\(/.test(src)
    })
    expect(
      missing,
      `These cards take a capped board count and must render it via boardCountLabel(fetchBoardCount(...)):\n  ${missing.join("\n  ")}`,
    ).toEqual([])
  })

  it("no card asks for a headline count at the display page size", () => {
    const offenders = routes
      .filter((r) => /fetchBoardCount\([^)]*,\s*[1-9]\s*\)/.test(stripComments(r.src)))
      .map((r) => r.name)
    expect(
      offenders,
      `fetchBoardCount called with a single-digit limit — that reproduces the "3 sales this week" defect:\n  ${offenders.join("\n  ")}`,
    ).toEqual([])
  })
})
