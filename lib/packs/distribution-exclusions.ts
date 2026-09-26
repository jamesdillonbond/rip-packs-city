// lib/packs/distribution-exclusions.ts
//
// Which pack distributions are Dapper-internal and so stay OFF the public packs
// board and the pack sitemap.
//
// WHY (2026-09-25). 33 All Day distributions are Dapper's own plumbing —
// "NFL Pack Hold – Genesis", "Pack Test 2", "Do Not Use", "Series 7 removal" —
// and sat on the board and in the sitemap. Trevor: "Leave all the packs out
// there if they're legitimate." Legitimacy is decided by EVIDENCE, never a
// title pattern: an excluded dist has no published art AND no rip, purchase or
// sale (migration 20260926023037). "Wideout Wonders Trade In Reward" has no
// art either but 553 rips — it stays.
//
// THE READ IS THE VIEW, NEVER THE TABLE. `v_pack_distribution_exclusions_active`
// re-derives "no rip, purchase or sale" on every read, so a dist that Dapper
// later releases reappears on its own. Reading the table directly would turn a
// dated judgement into a permanent one.
//
// FAILS OPEN. A failed or slow read returns NO exclusions (every pack shown)
// with ok=false. Hiding a legitimate pack because a side read failed would be
// the worse error; briefly listing an internal dist is cosmetic.

import { boundedRead } from "@/lib/api/bounded-read"

export const PACK_EXCLUSIONS_VIEW = "v_pack_distribution_exclusions_active"
const READ_TIMEOUT_MS = 3_000

export interface PackExclusions {
  ok: boolean
  error: string | null
  /** collection_id → excluded dist_ids. Empty on a failed read (fail open). */
  byCollection: Map<string, Set<string>>
}

export function isExcluded(ex: PackExclusions, collectionId: string | null | undefined, distId: string | null | undefined): boolean {
  if (!collectionId || !distId) return false
  return ex.byCollection.get(collectionId)?.has(String(distId)) ?? false
}

export async function readPackExclusions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  collectionIds?: string[],
): Promise<PackExclusions> {
  const out: PackExclusions = { ok: true, error: null, byCollection: new Map() }
  try {
    let q = db.from(PACK_EXCLUSIONS_VIEW).select("collection_id, dist_id")
    if (collectionIds && collectionIds.length > 0) q = q.in("collection_id", collectionIds)
    // The population is tens of rows; the cap only bounds a runaway table.
    const { data, error } = await boundedRead(q.limit(1000), "packs/distribution-exclusions", READ_TIMEOUT_MS)
    if (error) {
      out.ok = false
      out.error = typeof error?.message === "string" ? error.message : String(error)
      return out
    }
    for (const r of (data ?? []) as Array<{ collection_id: string | null; dist_id: string | null }>) {
      if (!r.collection_id || r.dist_id == null) continue
      let set = out.byCollection.get(r.collection_id)
      if (!set) out.byCollection.set(r.collection_id, (set = new Set()))
      set.add(String(r.dist_id))
    }
  } catch (e) {
    out.ok = false
    out.error = e instanceof Error ? e.message : String(e)
    out.byCollection = new Map()
  }
  if (!out.ok) console.warn("[pack-exclusions] read failed, showing every pack:", out.error)
  return out
}
