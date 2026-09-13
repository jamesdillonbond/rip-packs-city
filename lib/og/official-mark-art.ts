// lib/og/official-mark-art.ts
//
// Swap the RPC fallback glyphs on a card's badge rows for OFFICIAL platform art
// where it exists, in ONE deduped, bounded, memoized pass per render.
//
// ── THE COST ARGUMENT, RE-DERIVED RATHER THAN INHERITED ─────────────────────
// `lib/badges/glyphs.ts` justified inventing geometry like this: "six Moments
// × up to four badges is up to 24 image fetches" on a path where a social
// crawler holds the connection open. That number is the right thing to worry
// about and the wrong way to count it — it counts MARKS, and what a render
// pays for is DISTINCT URLs:
//
//   * Top Shot's special serials cost ZERO — the paths are inline in the repo
//     (lib/badges/official-art.ts), so the most-shared platform's marks never
//     reach this module at all.
//   * Edition badges repeat HARD across a case. Trevor's own six Moments carry
//     six badge titles of which "Rookie Year" appears twice — and across a
//     whole card the distinct set is bounded by 17, the total number of badges
//     with art in the product (9 Top Shot + 8 All Day), not by 24.
//   * They are SAME-ORIGIN 1.7–6.1 KB SVGs behind /api/badge-image, which
//     serves `max-age=86400, stale-while-revalidate=604800`. They are edge
//     cached for a day.
//   * And they are memoized here for the life of the lambda, so a warm
//     instance pays nothing.
//
// ⚠ WHAT THIS DOES NOT CLAIM. The FIRST render on a cold lambda in a cold PoP
// does pay real fetches — measured cold-render medians were ~5.8s (profile)
// and 4.04s (trophy case) on 2026-09-12, and repeat fetches from different
// egress IPs all returned MISS, so the edge cache looks per-PoP and X's
// crawler probably pays cold. These fetches are bounded (see BUDGET below) and
// they fail SOFT to the glyph that would otherwise have been drawn, so the
// worst case is the card we render today, a little later. That is the trade
// being made, stated so the next person can re-measure it rather than inherit
// it the way this module inherited "24 fetches".
//
// ⚠ AND THE FALLBACK IS NEVER AN EMPTY SLOT. Every TrophyMark carries a
// zero-network `uri` before this module runs. A failed official fetch costs
// the badge's LOOK, never the badge — a Moment that earned something must
// never render as a Moment that earned nothing (the mirror of #80, and the
// reason `trophyMarks` refuses to drop an unrecognised badge).

import { ogImageDataUri } from "@/lib/og/img-data"
import type { TrophyMark } from "@/lib/og/trophy-marks"

/**
 * Per-URL budget for one official badge SVG.
 *
 * ⚠ A DECORATION BUDGET — `lib/og/og-fetch.ts` bounds a card's DATA at 10s
 * because the card cannot render without it; this bounds a 3 KB SVG that has a
 * drawable local substitute already in hand.
 *
 * 🚨 IT WAS 2.5s FOR ONE HOUR AND THAT NUMBER WAS MEASURED WRONG. Sized by
 * analogy to the jersey-number read ("the other read whose failure costs a
 * glyph"), which is a read of OUR OWN DATABASE. This is not that: it waits on
 * `/api/badge-image`, a PROXY that on an edge-cache MISS must itself fetch
 * Dapper's CDN — and that route bounds its own upstream at
 * `UPSTREAM_TIMEOUT_MS = 8_000`. A client budget below the bound of the thing
 * it is waiting on can only ever truncate a request the proxy would have
 * served.
 *
 * ⭐ MEASURED IN PRODUCTION, 2026-09-13, and the instrument was this module's
 * own warning line. First live render of the trophy-case card after deploy:
 * **all 6 `/api/badge-image` requests returned 200 with `cache=MISS`, and 4 of
 * the 6 marks still fell back to RPC glyphs.** The proxy served every one; this
 * client gave up first. Nothing was broken — the budget was simply shorter than
 * a cold CDN round trip.
 *
 * 4s matches `lib/badges/server-art.ts`'s `BADGE_ART_TIMEOUT_MS`, the repo's
 * existing sized precedent for "badge art", and — because the fetches run
 * CONCURRENTLY in one `Promise.all` — it bounds the whole pass, not each URL.
 * So the worst case this can add to a card is 4s once, not 4s per badge.
 * ⚠ A DATED SAMPLE, and one that has already been wrong once: the warning below
 * now carries elapsed ms and the failing URLs so the NEXT person re-derives
 * this from production rather than from an analogy.
 */
export const OFFICIAL_ART_BUDGET_MS = 4_000

/**
 * Bytes accepted for one badge. The largest measured official SVG is
 * `perfect-serial` at 8,020 B (2026-09-12); 64 KB leaves two orders of room
 * for a redesign while still refusing anything that is not a badge-sized
 * asset. It exists because these URLs resolve through a PROXY — if
 * /api/badge-image ever passes through an upstream error page, this is what
 * stops it being base64'd onto a card.
 */
const MAX_BADGE_BYTES = 64 * 1024

/**
 * Module-scope memo, keyed by URL. Lives as long as the lambda instance.
 *
 * ⚠ Stores the PROMISE, not the result, so N marks on one card needing the
 * same URL share ONE in-flight fetch rather than racing N of them. That is the
 * dedupe doing its job — a Map of settled values would still let a single
 * render fire six identical requests before the first one lands.
 *
 * 🚨 A MISS IS NOT CACHED, AND THE OPPOSITE WAS SHIPPED FIRST. This memo
 * originally kept failures too, reasoned as "a badge whose art is failing
 * should cost a warm instance one attempt, not one per card". That is wrong
 * here, and wrong in the way that hides itself:
 *
 *   * the thing being waited on is edge-cached for 24h
 *     (`max-age=86400, stale-while-revalidate=604800`), so a failure is almost
 *     always a COLD-CACHE failure — and the very act of failing warms it;
 *   * so the retry that a cached miss forbids is exactly the one that would
 *     have succeeded, instantly;
 *   * and the cost of being wrong is unbounded in the wrong direction: ONE slow
 *     cold start poisons every card that lambda serves for the rest of its
 *     life, drawing RPC glyphs on every share while the asset sits warm at the
 *     edge. It degrades to a good-looking badge, so nothing looks broken.
 *
 * Successes are kept for the instance's life (the asset is immutable); a miss
 * is dropped the moment it settles, so the next render re-asks and gets the now
 * -warm edge copy. The in-flight promise is still shared while it is pending,
 * which is what the dedupe actually needs.
 */
const memo = new Map<string, Promise<string | null>>()

function fetchOfficial(url: string): Promise<string | null> {
  const hit = memo.get(url)
  if (hit) return hit
  const p = ogImageDataUri(url, {
    timeoutMs: OFFICIAL_ART_BUDGET_MS,
    maxBytes: MAX_BADGE_BYTES,
    // ⛔ NOT THROUGH `/_next/image`. These are 20px glyphs under a 64 KB cap;
    // the optimizer's 640px derivative would be LARGER than the original (sharp
    // enlarges by default), so it would buy a transformation, an extra round
    // trip inside a 4s decoration budget, and a worse chance of clearing the
    // cap. The optimizer leg exists for 2880px card art — see lib/og/img-data.ts.
    optimize: false,
  })
    .catch(() => null)
    .then((art) => {
      if (!art) memo.delete(url)
      return art
    })
  memo.set(url, p)
  return p
}

/** Test seam — the memo is process-global and would leak between cases. */
export function __resetOfficialArtMemo(): void {
  memo.clear()
}

/**
 * Replace every mark's `uri` with its official art where the fetch succeeds.
 *
 * Takes ALL of a card's rows at once (an array per Moment) rather than one row
 * at a time, because the dedupe is only worth anything ACROSS Moments — six
 * Top Shot Moments in a case share one badge vocabulary, and resolving them
 * per-tile would fetch "Rookie Year" as many times as it appears.
 *
 * Returns new arrays; the inputs are not mutated.
 */
export async function withOfficialArt(rows: TrophyMark[][]): Promise<TrophyMark[][]> {
  const urls = Array.from(
    new Set(
      rows.flat().map((m) => m.officialUrl).filter((u): u is string => !!u),
    ),
  )
  if (urls.length === 0) return rows

  const startedAt = Date.now()
  const resolved = new Map<string, string | null>()
  await Promise.all(
    urls.map(async (u) => {
      resolved.set(u, await fetchOfficial(u))
    }),
  )
  const elapsedMs = Date.now() - startedAt

  let missing = 0
  const out = rows.map((marks) =>
    marks.map((m) => {
      if (!m.officialUrl) return m
      const art = resolved.get(m.officialUrl) ?? null
      if (!art) {
        missing += 1
        return m
      }
      return { ...m, uri: art }
    }),
  )

  if (missing > 0) {
    // ⚠ SAID OUT LOUD. The degraded state here is INVISIBLE — an RPC glyph is
    // a perfectly good-looking badge, so a card that quietly stopped drawing
    // official art would look exactly like a card that never tried. Without
    // this line the only way to notice is to compare a rendered PNG against a
    // PDF of the same six Moments, which is how the defect that prompted this
    // whole change was found in the first place.
    //
    // ⭐ AND IT CARRIES THE NUMBERS, because the first version did not and that
    // cost a round trip. "unavailable for 4 mark(s)" said something was wrong
    // and nothing about WHY — the elapsed time against the budget is the whole
    // diagnosis (at the budget = truncated by us; far under it = the proxy
    // actually said no), and the URL names which asset. This line is the
    // instrument that found the 2.5s misjudgement; it should be able to find
    // the next one without a redeploy.
    console.warn(
      `[og/official-art] official art unavailable for ${missing} mark(s) after ${elapsedMs}ms ` +
        `(budget ${OFFICIAL_ART_BUDGET_MS}ms, ${urls.length} distinct url(s)); RPC glyphs drawn instead: ` +
        urls.filter((u) => !resolved.get(u)).join(" | "),
    )
  }
  return out
}
