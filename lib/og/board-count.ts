// lib/og/board-count.ts
//
// The headline count on an insights OG card.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Six OG cards published a board size in their header. Each derived it from
// `meta.total_rows`, which is the CAPPED PAGE LENGTH rather than a total (see
// lib/insights/board-meta.ts), and three of them read it off the SAME `limit=3`
// request they used to render the top-3 rows. Measured 2026-08-15:
//
//   /api/og/insights/top-sales           "3 sales this week"        — true 30,592
//   /api/og/insights/serial-premiums     "3 editions tracked"
//   /api/og/insights/underpriced-serials "3 live deals"
//   /api/og/insights/squeeze             "200 editions squeezed 50%+" — true 1,352
//   /api/og/insights/trophies            "500 grails ranked"          — true   842
//
// An OG card is a static PNG that is edge-cached and then shown in other
// people's timelines, so "3 sales this week" for a market that did 30,592 is
// both the most wrong and the least visible number on the platform — nobody
// looking at the site ever sees it.
//
// ── WHAT THIS DOES ─────────────────────────────────────────────────────────
// One count request at the route's OWN MAXIMUM limit, reading the honest
// `returned_rows` + `truncated` pair. The result is a FLOOR, not a census: these
// boards are bigger than any single page, and the fix here is to say so ("200+")
// rather than to add a `count: exact` query to an anonymous endpoint on a
// disk-IO-throttled instance.
//
// ⚠ A floor is still a claim. `maxLimit` MUST be the route's real clamp ceiling
// — pass a larger number and the API silently clamps it, `truncated` still comes
// back true, and the card advertises a floor lower than the one we actually
// established. Grep the route's `Math.min(...)` rather than guessing.

import { boardCountFloor } from "@/lib/insights/board-meta"
import { ogFetch } from "./og-fetch"

export type BoardCount = {
  /** Rows the count request actually returned. A FLOOR when `truncated`. */
  count: number
  /** True when the count request filled its cap, so more rows exist. */
  truncated: boolean
  /**
   * The row objects this request read, unparsed and untyped.
   *
   * ⚠ Handed back because they were ALREADY FETCHED AND PARSED — this costs no
   * extra request. It exists so a card can derive a second fact from the same
   * read (today: lib/og/board-freshness.ts computes the spine age from
   * `last_seen_at`) instead of firing a duplicate query or, worse, deriving it
   * from the 3-row hero slice, which is a different and much smaller population.
   * Callers that only want the count ignore it; nothing here reads it.
   *
   * ⚠ OPTIONAL, and the omission is SAFE BY DIRECTION: a `BoardCount` built by
   * hand carries no rows, so an age derived from it comes back `null` — which
   * boardLivenessLabel renders as NO liveness claim rather than a false one.
   */
  rows?: unknown[]
}

/**
 * Fetch a board's headline count. Returns `null` when the read failed — callers
 * must render their "Public · No signup" fallback rather than a zero, since a
 * failed read is not a board with nothing in it.
 */
export async function fetchBoardCount(
  origin: string,
  pathAndQuery: string,
  maxLimit: number,
): Promise<BoardCount | null> {
  try {
    const sep = pathAndQuery.includes("?") ? "&" : "?"
    const r = await ogFetch(`${origin}${pathAndQuery}${sep}limit=${maxLimit}`, { cache: "no-store" })
    if (!r.ok) return null
    const j = await r.json()
    const meta = j?.meta
    // `returned_rows` is the honest name; `total_rows` is the deprecated alias
    // kept for older responses. They carry the same value.
    const count = Number(meta?.returned_rows ?? meta?.total_rows ?? 0)
    if (!Number.isFinite(count) || count < 0) return null
    // Older responses predate `truncated`. Deriving it from the cap is the safe
    // direction: it can only ADD a "+", never remove one.
    const truncated = typeof meta?.truncated === "boolean" ? meta.truncated : count >= maxLimit
    return { count, truncated, rows: Array.isArray(j?.rows) ? (j.rows as unknown[]) : [] }
  } catch {
    return null
  }
}

/**
 * Render the header label, e.g. `"1,352 editions squeezed 50%+"` or
 * `"200+ sales this week"`. Returns the shared no-data fallback when the count
 * could not be established or is zero — a card must never print "0 sales this
 * week" off a failed read.
 */
export function boardCountLabel(c: BoardCount | null, noun: string): string {
  if (!c || c.count <= 0) return "Public · No signup"
  return `${boardCountFloor(c.count, c.truncated)} ${noun}`
}
