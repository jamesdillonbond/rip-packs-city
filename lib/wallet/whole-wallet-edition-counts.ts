// lib/wallet/whole-wallet-edition-counts.ts
//
// "You hold N of this edition" for the binder / wallet search, counted over the
// WHOLE wallet, not the loaded page (2026-11-08; 11-07 review item: a collector
// with 5 copies split across pages read "You hold 2").
//
// How, and why it is safe to mix two sources:
//   1. The page's moments → their edition key from wallet_moments_cache. A
//      moment's edition never changes, so a cached key is a FACT, however old
//      the cache row is.
//   2. Every cached moment of those keys in this wallet, kept ONLY when the
//      chain's owned-id list (the route's `ids`) still contains it — a cache row
//      for a moment the wallet sold is ignored, so staleness cannot inflate it.
//   A moment the cache has not walked yet is simply not counted, so the result
//   can only UNDER-count; the caller takes max(page count, this), which can
//   never be worse than the page count it replaces.
//
// Returns null on any read failure (the caller keeps its page counts) — a
// failed read must not become a count.

const PAGE = 1000
/** Runaway guard: 20 pages × 1,000 rows of ONE page's editions in one wallet. */
const MAX_PAGES = 20

export type WholeWalletCounts = Map<string, number> // momentId -> copies owned of its edition

export async function wholeWalletEditionCounts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  walletAddr: string,
  collectionId: string,
  pageMomentIds: string[],
  ownedIds: Iterable<string | number>,
): Promise<WholeWalletCounts | null> {
  if (pageMomentIds.length === 0) return new Map()
  try {
    const keyRes = await db
      .from("wallet_moments_cache")
      .select("moment_id, edition_key")
      .eq("wallet_address", walletAddr)
      .eq("collection_id", collectionId)
      .in("moment_id", pageMomentIds)
    if (keyRes.error || !Array.isArray(keyRes.data)) return null
    const keyByMoment = new Map<string, string>()
    for (const r of keyRes.data as Array<{ moment_id: unknown; edition_key: unknown }>) {
      if (typeof r.edition_key === "string" && r.edition_key) keyByMoment.set(String(r.moment_id), r.edition_key)
    }
    const keys = [...new Set(keyByMoment.values())]
    if (keys.length === 0) return new Map()

    const owned = new Set<string>()
    for (const id of ownedIds) owned.add(String(id))

    const perKey = new Map<string, number>()
    let complete = false
    for (let page = 0; page < MAX_PAGES; page++) {
      const from = page * PAGE
      const res = await db
        .from("wallet_moments_cache")
        .select("moment_id, edition_key")
        .eq("wallet_address", walletAddr)
        .eq("collection_id", collectionId)
        .in("edition_key", keys)
        .order("moment_id", { ascending: true })
        .range(from, from + PAGE - 1)
      if (res.error || !Array.isArray(res.data)) return null
      const rows = res.data as Array<{ moment_id: unknown; edition_key: unknown }>
      for (const r of rows) {
        if (typeof r.edition_key !== "string" || !owned.has(String(r.moment_id))) continue
        perKey.set(r.edition_key, (perKey.get(r.edition_key) ?? 0) + 1)
      }
      if (rows.length < PAGE) { complete = true; break }
    }
    // A capped walk is a PREFIX: its counts are still lower bounds (max() with the
    // page count keeps them honest), so they are used — but say so in the log.
    if (!complete) console.warn(`[whole-wallet-edition-counts] ${MAX_PAGES * PAGE}-row ceiling reached; counts are lower bounds`)

    const out: WholeWalletCounts = new Map()
    for (const [momentId, key] of keyByMoment) out.set(momentId, perKey.get(key) ?? 0)
    return out
  } catch {
    return null
  }
}
