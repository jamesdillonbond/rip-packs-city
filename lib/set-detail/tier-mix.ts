// lib/set-detail/tier-mix.ts
//
// The full-set TIER MIX bar on /[collection]/set/[slug].
//
// ⚠ WHY THIS WAS WORTH EXTRACTING, and it is not the coverage number. The
// fetcher lived in a `page.tsx` — measured by neither coverage gate — and it
// returned a bare `[]` on a query ERROR, which the page could not tell apart
// from "this collection has no set_name index, fall back to the first-page
// sample". So a failed read silently rendered a tier bar computed from the
// first PAGE_SIZE (100) editions of a set that may hold thousands, printed as
// ABSOLUTE COUNTS with no provenance: a ~3,600-edition Base Set showed
// "COMMON · 62 · 62.0%" where the truth is ~2,200, in exactly the same type,
// colour and layout as the accurate bar. The page's own comment says the
// function exists so the bar is "accurate even on sets with > PAGE_SIZE
// editions, instead of being sampled from the first 100" — a failed read
// silently reinstated the sampling it was written to remove.
//
// The failure-renders-as-data class, met one layer below the page's other
// reads: `fetchDetail` already throws on error and `fetchEditions` is marked
// structural, so this was the one read on the page that could fail quietly.

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"

/**
 * Wall-clock budget for the WHOLE paged sweep, not per page.
 *
 * ⚠ Per-page would be the wrong shape here and the arithmetic says why: the loop
 * runs up to `MAX_ROWS / PAGE` = 60 iterations, so a 5s per-page budget would
 * bound this read at five MINUTES — a ceiling far above the ~30s a document has,
 * i.e. no bound at all in practice. One deadline shared across the loop is what
 * the caller actually needs.
 *
 * ⚠ And a read that is merely SLOW errors nowhere: supabase-js resolves
 * `{ data, error }` only when the query finishes, so without this the set page
 * hangs on a streaming shell that Vercel logs as a 200.
 */
const TIER_MIX_TIMEOUT_MS = 6_000


/** PostgREST caps a read at 1,000 rows, so the mix is paged. */
export const PAGE = 1000
/** Hard ceiling on paging, so a mis-scoped query cannot walk the table forever. */
export const MAX_ROWS = 60000

export interface TierCount {
  tier: string
  n: number
}

export interface TierMixResult {
  rows: TierCount[]
  /**
   * ⚠ false ONLY when the read failed. A set that legitimately returns no rows
   * is `ok: true` with an empty `rows` — the caller's documented fallback to the
   * first-page sample is correct for THAT case and wrong for a failure, which is
   * the entire distinction this field exists to carry.
   */
  ok: boolean
}

/**
 * Count editions per tier across every spelling of a set's name.
 *
 * Scoped identically to `get_set_editions` / `get_set_detail`
 * (thumbnail-bearing editions only) so the mix reconciles with the EDITIONS
 * stat and the grid — without it the ~6.4k inert UUID-fossil Top Shot editions
 * inflate the mix (Item 9, 2026-06-26 audit).
 *
 * The client is DEFAULTED rather than passed in, so the page can drop its
 * `@/lib/supabase` import — the property the server-page data-access ratchet
 * keys on. Tests inject `db`.
 */
export async function fetchFullTierMix(
  collectionId: string,
  setNames: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
): Promise<TierMixResult> {
  const names = Array.from(new Set(setNames.filter(Boolean)))
  // ⚠ ok:true — asking about no sets is not a failed read, and reporting it as
  // one would hide the bar on a page whose detail row carries no set name.
  if (names.length === 0) return { rows: [], ok: true }

  const counts = new Map<string, number>()
  const deadline = Date.now() + TIER_MIX_TIMEOUT_MS
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    let data: unknown
    let error: { message: string } | null = null
    try {
      ;({ data, error } = await withBoardBudget<{
        data: unknown
        error: { message: string } | null
      }>(
        Promise.resolve(
          db
            .from("editions")
            .select("tier")
            .eq("collection_id", collectionId)
            .in("set_name", names)
            .not("thumbnail_url", "is", null)
            // ⚠ ORDERED: paging an unordered read can repeat or skip rows between
            // pages, so the counts would be over a set that never existed.
            .order("id", { ascending: true })
            .range(from, from + PAGE - 1),
        ),
        "tier-mix",
        Math.max(1, deadline - Date.now()),
        "set/",
      ))
    } catch (e) {
      // ⚠ Falls into the SAME discard-the-partials branch as an error, and for
      // the same reason spelled out below: a truncated mix is not a smaller
      // answer, it is a WRONG one. Running out of budget mid-sweep is exactly
      // the case where the temptation to keep what we have is strongest and the
      // percentages would still sum to 100.
      console.error("[set] tier mix bound", e instanceof Error ? e.message : e)
      return { rows: [], ok: false }
    }
    if (error) {
      console.error("[set] tier mix error", error.message)
      // ⚠ Discard the partial counts. A truncated mix is not a smaller answer,
      // it is a WRONG one — the percentages would still sum to 100 and read as
      // complete.
      return { rows: [], ok: false }
    }
    const rows = (data ?? []) as Array<{ tier: string | null }>
    for (const row of rows) {
      const t = (row.tier ?? "UNKNOWN").toUpperCase()
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    if (rows.length < PAGE) break
  }
  return { rows: Array.from(counts.entries()).map(([tier, n]) => ({ tier, n })), ok: true }
}

export interface TierMixRow extends TierCount {
  pct: number
}

/**
 * Build the rendered tier rows, largest first.
 *
 * `sample` is the first-page editions list, used ONLY when the full-set read
 * succeeded and genuinely returned nothing — the documented fallback for a
 * collection whose editions are not reachable by set_name. A FAILED read must
 * never reach here; the caller withholds the section instead.
 */
export function buildTierMixRows(
  full: TierCount[],
  sample: Array<{ tier?: string | null }>,
): TierMixRow[] {
  const base =
    full.length > 0
      ? full
      : (() => {
          const m = new Map<string, number>()
          for (const e of sample) {
            const t = (e.tier ?? "UNKNOWN").toUpperCase()
            m.set(t, (m.get(t) ?? 0) + 1)
          }
          return Array.from(m.entries()).map(([tier, n]) => ({ tier, n }))
        })()
  const total = base.reduce((s, r) => s + r.n, 0)
  return base
    .map((r) => ({ tier: r.tier, n: r.n, pct: total > 0 ? (r.n / total) * 100 : 0 }))
    .sort((a, b) => b.n - a.n)
}
