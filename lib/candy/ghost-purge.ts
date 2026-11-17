// lib/candy/ghost-purge.ts
//
// Scoped Candy ghost-row purge (2026-11-08). A "ghost" is a wallet_moments_cache row for a
// card under its PREVIOUS owner, left behind when the census wrote the card under its new
// owner. purge_candy_wmc_ghost_rows() finds them by window-ranking every Candy row (~1.4M
// since the collections census) and hit its 120 s statement_timeout on the 7:57 PM PT
// census run. A ghost can only appear where a row was just written for a moment, so a
// caller that knows those moments passes them here and only they are ranked
// (purge_candy_wmc_ghost_rows_for, served by idx_wmc_moment_collection_cover).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

const CHUNK = 2000

export async function purgeCandyGhostsFor(
  db: Db,
  momentIds: Iterable<string>,
): Promise<{ purged: number; error: string | null }> {
  const ids = [...new Set(momentIds)]
  let purged = 0
  for (let i = 0; i < ids.length; i += CHUNK) {
    try {
      const { data, error } = await db.rpc("purge_candy_wmc_ghost_rows_for", { p_moment_ids: ids.slice(i, i + CHUNK) })
      if (error) return { purged, error: error.message ?? String(error) }
      purged += typeof data === "number" ? data : Number(data ?? 0)
    } catch (e) {
      return { purged, error: e instanceof Error ? e.message : String(e) }
    }
  }
  return { purged, error: null }
}
