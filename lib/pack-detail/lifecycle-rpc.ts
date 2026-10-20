// lib/pack-detail/lifecycle-rpc.ts
//
// Which RPC answers a single pack's lifecycle, per collection. Dependency-free so
// the OG card route can share it with the page (lib/pack-detail/lifecycle.ts).
//
// ⛔ PACK NFT IDS ARE PER-CONTRACT, NOT GLOBAL (measured 2026-10-19: 2,294 Golazos
// pack ids are also the ids of DIFFERENT All Day rips — no shared tx, opener or
// time). get_pack_lifecycle is keyed on the id alone and reads pack_purchases /
// pack_rips, so every caller must (1) read the collection's own RPC and (2) refuse
// a payload filed under another collection (`isFiledUnderAnotherCollection`).

/**
 * Collections whose single-pack lifecycle lives in their OWN pack tables.
 * 2026-10-19: Golazos (golazos_pack_opens / _open_pulls / _sales_history) and
 * Disney Pinnacle (pinnacle_pack_opens).
 */
const NATIVE_LIFECYCLE_RPC: Record<string, string> = {
  "06248cc4-b85f-47cd-af67-1855d14acd75": "get_golazos_pack_lifecycle",
  // 2026-10-19: Disney Pinnacle (pinnacle_pack_opens; pulls named by the pricing lane's ladder).
  "7dd9dd11-e8b6-45c4-ac99-71331f959714": "get_pinnacle_pack_lifecycle",
}

/** The RPC that answers a single pack's lifecycle for this collection. */
export function lifecycleRpcFor(collectionUuid: string | null | undefined): string {
  return (collectionUuid && NATIVE_LIFECYCLE_RPC[collectionUuid]) || "get_pack_lifecycle"
}

/** True when a lifecycle payload names a collection other than the one asked about. */
export function isFiledUnderAnotherCollection(data: unknown, collectionUuid: string | null | undefined): boolean {
  if (!collectionUuid || !data || typeof data !== "object") return false
  const filedUnder = (data as { collection_id?: unknown }).collection_id
  return typeof filedUnder === "string" && filedUnder !== collectionUuid
}
