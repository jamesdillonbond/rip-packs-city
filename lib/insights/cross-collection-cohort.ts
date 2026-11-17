// lib/insights/cross-collection-cohort.ts
//
// The cohort SIZE, for the /insights/cross-collection route's metadata.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// The route's `layout.tsx` hardcoded "143 wallets hold 3+ Flow collections" in
// its description, its openGraph description and its twitter description, while
// the board three lines into the client rendered the LIVE `stats.cohort_size`.
// The cohort is a growing population: 143 at some unknown past date, 179 on
// 2026-08-17, 220 on 2026-08-26. So the indexed SEO claim was ~35% low and the
// page disagreed with its own metadata.
//
// It lives in `lib/` rather than inline in the layout for two reasons, and the
// second is the load-bearing one:
//   1. `__tests__/server-page-data-access-ratchet.test.ts` holds non-page server
//      files at ZERO inline DB readers — a layout that imports `@/lib/supabase`
//      re-opens the hole that ratchet exists to keep shut.
//   2. Neither coverage gate measures `app/**/layout.tsx`, and `lib/**` is in
//      the primary gate. The honesty branch below is exactly the kind of code
//      this repo keeps finding broken in unmeasured files.
//
// ── WHY AN EXACT COUNT IS SAFE HERE, given lib/insights/board-meta.ts ──────
// ⚠ `board-meta.ts` deliberately REFUSES `{ count: "exact" }` on the public
// board routes: those are views over hot tables on a 2 GB IO-throttled instance,
// and a full count per anonymous request would worsen the saturation that
// already fails board warms. **That reasoning does not transfer to this call**,
// on two measured differences: the target is a small materialised table (220
// rows on 2026-08-26, not a view over `sales`/`wmc`), and it is read from
// `generateMetadata()` on a route with `revalidate = 1800`, so it runs at most
// twice an hour per region rather than once per request. If either of those
// stops being true, drop the number from the copy rather than keeping the count.

import { supabaseAdmin } from "@/lib/supabase"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

/**
 * How many wallets are in the cross-collection cohort.
 *
 * Returns `null` — never `0` — when the count cannot be read.
 *
 * ⚠ THE NULL IS THE WHOLE CONTRACT. supabase-js RESOLVES a query error rather
 * than throwing, so a failed read arrives as `{ count: null, error }`. `?? 0`
 * on that publishes "0 wallets hold 3+ Flow collections" into an indexed
 * description off a read that never happened — CLAUDE.md's named
 * fabricated-number shape, applied to SEO. A caller that gets `null` must drop
 * the number from its sentence, not substitute one.
 *
 * `{ count: null, error: null }` is treated as unreadable too: the discriminator
 * is "did we get a number", never "was there an error object".
 */
export async function readCrossCollectionCohortSize(db: Db = supabaseAdmin): Promise<number | null> {
  try {
    const { count, error } = await db
      .from("cross_collection_cohort_mat")
      .select("wallet_address", { count: "exact", head: true })
    if (error) return null
    return typeof count === "number" ? count : null
  } catch {
    // A transport failure or an abort THROWS rather than resolving. Same answer:
    // we do not know the size, so nobody downstream may claim one.
    return null
  }
}
