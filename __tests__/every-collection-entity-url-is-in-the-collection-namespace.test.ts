import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { publishedCollections } from "@/lib/collections"
import { editionHref, pinnacleRenderHref } from "@/lib/entity-href"

/**
 * ONE NAMESPACE FOR EVERY COLLECTION'S ENTITY PAGES.
 *
 * ── THE DECISION THIS PINS (2026-09-20) ─────────────────────────────────────
 * Every published collection's entity detail pages live under
 * `/<collection-url-slug>/<entity>/<key>`. Disney Pinnacle was the exception:
 * its canonical per-render page sat at `/pinnacle/moment/<render_id>` — outside
 * `(collections)`, under a slug that is not the collection's URL slug, using a
 * noun the page never used for itself — while the house-shaped URL existed and
 * 308'd AWAY to it. It now renders at `/disney-pinnacle/edition/<render_id>`.
 *
 * ── WHY IT IS WORTH A GUARD RATHER THAN A COMMENT ───────────────────────────
 * The cost of that divergence was never cosmetic. Every place the house pattern
 * "obviously" applied, Pinnacle was quietly outside it, and each one shipped as
 * a defect: `/api/sets-db` answered `{totalSets: 0}` because Pinnacle is not in
 * `editions`/`sets`; `/api/pinnacle-set-progress` shipped behind the auth wall
 * because Pinnacle's backends are bespoke and the allowlist is hand-kept;
 * `get_set_detail` returns NULL for every Pinnacle slug so its set links had to
 * be suppressed. A reader who assumes the convention holds is right four times
 * out of five, which is the worst possible hit rate.
 *
 * ⚠ WHAT THIS DOES NOT CLAIM. It does not say Pinnacle's DATA model should be
 * merged into `editions`/`sets` — it should not, and CLAUDE.md records that
 * separation as deliberate. Pinnacle is render-keyed and stays render-keyed.
 * This is about the URL and the vocabulary the reader sees, nothing below it.
 *
 * ⚠ AND IT IS SOURCE-LEVEL. It cannot prove a URL resolves — only that nothing
 * in the tree still BUILDS the retired one.
 */

const ROOT = process.cwd()
const RETIRED = "/pinnacle/moment/"

/** The one route allowed to name the retired URL: its own redirect stub. */
const REDIRECT_STUB = path.join("app", "pinnacle", "moment", "[id]", "page.tsx")

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const SOURCES = [
  ...walk(path.join(ROOT, "app")),
  ...walk(path.join(ROOT, "lib")),
  ...walk(path.join(ROOT, "components")),
]

describe("every published collection's entity URLs live in its own namespace", () => {
  it("is not vacuous — the walk found the tree", () => {
    expect(SOURCES.length).toBeGreaterThan(300)
  })

  it("editionHref puts every published collection under its own URL slug", () => {
    for (const c of publishedCollections()) {
      const href = editionHref(c.id, "EXT-1", "ID-1")
      expect(
        href.startsWith(`/${c.id}/edition/`),
        `${c.id} builds "${href}" — an entity URL outside /${c.id}/`,
      ).toBe(true)
    }
  })

  it("Pinnacle's render href is the collection-namespaced edition URL", () => {
    expect(pinnacleRenderHref("OEV1-TOYS-BUZZ-S4B")).toBe(
      "/disney-pinnacle/edition/OEV1-TOYS-BUZZ-S4B",
    )
  })

  it("nothing but its own redirect stub still BUILDS the retired /pinnacle/moment/ URL", () => {
    const offenders: string[] = []
    for (const f of SOURCES) {
      const rel = path.relative(ROOT, f)
      if (rel === REDIRECT_STUB) continue
      // Comments may discuss the retired URL — the history is worth keeping.
      // Only real source counts.
      const src = stripComments(readFileSync(f, "utf8"))
      if (src.includes(RETIRED)) offenders.push(rel)
    }
    expect(
      offenders,
      `these still build the retired Pinnacle URL, which now only redirects:\n` +
        offenders.map((o) => `  ${o}`).join("\n") +
        `\nUse editionHref("disney-pinnacle", …) or pinnacleRenderHref().`,
    ).toEqual([])
  })

  it("the move did not smuggle Pinnacle onto the segment's ISR cache", () => {
    // 🚨 The segment exports `revalidate = 600`; the route Pinnacle moved from
    // had no segment config and rendered per request. Without `connection()`,
    // moving the URL would ALSO have put a page whose failed-read branch renders
    // "this pin didn't load" behind a ten-minute cache — CLAUDE.md's "ISR caches
    // a failed read" trap, introduced as a side effect of a rename.
    // ⚠ Pinned at the source because there is no way to observe it from a unit
    // test, and it is invisible in review: the caching change is in a file the
    // diff does not touch.
    const route = stripComments(
      readFileSync(
        path.join(ROOT, "app", "(collections)", "[collection]", "edition", "[slug]", "page.tsx"),
        "utf8",
      ),
    ).replace(/\s+/g, " ")
    expect(route, "the segment no longer declares revalidate — re-read this arm").toContain(
      "export const revalidate",
    )
    expect(
      route,
      "the Pinnacle branch must await connection() before rendering, or it inherits the segment's ISR window",
    ).toMatch(/isPinnacleUrlSlug\(collection\)\) \{ await connection\(\)/)
  })

  it("the redirect stub still exists and is permanent — its URLs must not be thrown away", () => {
    // ⛔ The retired route carried real traffic (125 visitors / 173 pageviews in
    // the 30 days to 2026-09-20) and ~2,600 sitemap URLs. Deleting it 404s all
    // of them; a 308 transfers their signals. This arm exists because "nothing
    // links to it any more" is exactly the argument that would delete it.
    const stub = readFileSync(path.join(ROOT, REDIRECT_STUB), "utf8")
    expect(stub).toContain("permanentRedirect")
    expect(stub).toContain("/disney-pinnacle/edition/")
  })
})
