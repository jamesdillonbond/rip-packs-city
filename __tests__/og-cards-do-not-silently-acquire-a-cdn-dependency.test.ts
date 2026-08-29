import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

/**
 * AN EMOJI IN AN OG CARD IS A THIRD-PARTY CDN DEPENDENCY, AND NOTHING SAID SO.
 *
 * `next/og` resolves every emoji at RENDER time by fetching an SVG from a CDN.
 * Measured 2026-08-29 by closing the render sweep's network passthrough — three
 * requests escaped to
 * `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/{1f3af,1f3b4,1f4e6}.svg`
 * (🎯 🎴 📦) from `og/deal`, `og/collection`, `og/pack` and `og/pack/lifecycle`.
 *
 * ⛔ THERE IS NO CENTRAL FIX. `ImageResponseOptions` exposes exactly one knob,
 * `emoji?: EmojiType`, and every preset (`twemoji`, `openmoji`, `blobmoji`,
 * `noto`) is a remote URL. There is no `loadAdditionalAsset` hook on the public
 * API, so the dependency cannot be moved to local assets without leaving
 * `ImageResponse`. That is why this is a GUARD and not a fix.
 *
 * Why it matters here specifically: an OG card is what a crawler waits on, and
 * X gives up on a slow image — a card that renders too late is a link with no
 * preview. None of these routes sets an explicit `maxDuration`. The sibling
 * incident is on record: the brand-font fetch, also unbounded, hung one CI test
 * to 60,000 ms against an 83 ms local render.
 *
 * ⚠ WHAT THIS GUARD IS AND IS NOT. It is not a ban — six cards already do it and
 * removing their emoji is a design call, not a cleanup. It makes ADDING a
 * seventh a visible decision instead of a silent one. The recorded set is
 * therefore allowed to shrink freely; it may only GROW deliberately.
 *
 * ⚠ It is also NOT a claim that only these six reach the CDN. `og/collection`
 * renders `collection?.icon ?? "🎴"`, so a collection whose icon is an emoji
 * reaches it through DATA, which no source scan can see. Two of the six
 * (`insights/serial-premiums`, `profile/[username]`) did not appear in the
 * sweep's escapes at all, because their emoji sit on branches its fixtures do
 * not take — so the render sweep is a LOWER BOUND and this scan is a different
 * lower bound. Neither is a census.
 */

const OG_DIR = path.join(process.cwd(), "app/api/og")

// Deliberately the same class the probe observed, not "every codepoint that
// might be emoji": the point is to catch a pictograph someone drops into a
// card, not to litigate Unicode.
const EMOJI =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}]/u

/**
 * Routes known to render a hardcoded emoji as of 2026-08-29, each therefore
 * fetching from cdn.jsdelivr.net on every uncached render.
 */
const RECORDED = new Set([
  "collection",
  "deal",
  "insights/serial-premiums",
  "pack",
  "pack/lifecycle",
  "profile/[username]",
])

function ogRoutes(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) ogRoutes(p, out)
    else if (/^route\.(tsx?|jsx?)$/.test(entry.name)) out.push(p)
  }
  return out
}

/**
 * Comments stripped: an emoji in prose is documentation, not a render.
 *
 * ⚠ The SHARED stripper, never a local copy — `guards-use-the-shared-comment-
 * stripper` is a ratchet and it caught the first version of this file. And
 * because using it is not itself proof that it stripped (it has been blind
 * three times), the "comments do not count as a render" case below is a control
 * on the stripping, not a formality.
 */
function renderedSource(file: string): string {
  return stripComments(readFileSync(file, "utf8"))
}

function slugOf(file: string): string {
  return path
    .relative(OG_DIR, file)
    .replace(/\/route\.(tsx?|jsx?)$/, "")
    .replace(/\\/g, "/")
}

describe("OG cards do not silently acquire a CDN dependency", () => {
  const routes = ogRoutes(OG_DIR)

  it("inspected a non-empty set of OG routes (the guard cannot pass vacuously)", () => {
    expect(routes.length).toBeGreaterThan(20)
  })

  it("every route that renders an emoji is recorded as doing so", () => {
    const found = routes.filter((r) => EMOJI.test(renderedSource(r))).map(slugOf).sort()
    const unrecorded = found.filter((s) => !RECORDED.has(s))
    expect(
      unrecorded,
      "These OG routes render an emoji, which makes next/og fetch an SVG from " +
        "cdn.jsdelivr.net at render time — on the path a social crawler is waiting on, " +
        "with no local fallback available through ImageResponse's public API. " +
        "If that is intended, add the route to RECORDED in this file and say why.",
    ).toEqual([])
  })

  it("the recorded set does not name a route that no longer renders one", () => {
    // Keeps the list from rotting into a description of the past — the failure
    // mode that makes a curated list worse than no list.
    const found = new Set(routes.filter((r) => EMOJI.test(renderedSource(r))).map(slugOf))
    const stale = [...RECORDED].filter((s) => !found.has(s)).sort()
    expect(stale, "recorded as emoji-bearing but no longer is — delete these entries").toEqual([])
  })

  it("comments do not count as a render", () => {
    // The guard would otherwise fire on its own explanatory prose, which is how
    // several guards in this repo have reddened on the text documenting them.
    const withCommentEmoji = routes.filter((r) => {
      const raw = readFileSync(r, "utf8")
      return EMOJI.test(raw) && !EMOJI.test(renderedSource(r))
    })
    for (const r of withCommentEmoji) expect(RECORDED.has(slugOf(r))).toBe(false)
  })
})
