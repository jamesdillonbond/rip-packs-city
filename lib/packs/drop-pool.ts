// lib/packs/drop-pool.ts
//
// Which collections carry a per-distribution drop pool (`pack_drop_pool`) — the
// table behind the rip simulator, the Grails view (pack_grail_metrics_mv), the
// pack page's top pulls and "What drives the remaining EV".
//
// Measured 2026-10-19: Top Shot 2,121 pool dists, All Day 3,147, Golazos 211,
// Disney Pinnacle 0. Pinnacle EV is priced per DROP from its render pool (#157)
// and no table holds that pool, so every pool-derived surface would be EMPTY
// there — and an empty Grails grid says "No grail-bearing packs matched. Try
// lowering the filters", a claim about the market that no filter can change.
// Dependency-free so client and server code share one list.

const DROP_POOL_COLLECTIONS: ReadonlySet<string> = new Set(["nba-top-shot", "nfl-all-day", "laliga-golazos"])

/** True when pool-derived pack surfaces (simulator, grails, EV contributors) can answer for this collection. */
export function collectionHasDropPool(slug: string): boolean {
  return DROP_POOL_COLLECTIONS.has(slug)
}
