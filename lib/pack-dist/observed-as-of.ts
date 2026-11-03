// lib/pack-dist/observed-as-of.ts
//
// Opens we watched on chain UP TO a payload's own stamp — the floor an Atlas
// tier-count payload must be compared against.
//
// WHY (2026-11-02). atlasTierCounts drops a payload claiming fewer packs opened
// than we watched open. Callers passed the ALL-TIME observed count
// (pack_table_rows.observed_packs_opened), while the Atlas payload is a snapshot
// up to ~2 days old. On any pack still being opened, today's count runs past the
// snapshot and the payload read as "refuted": measured 11-02 ~10:40 AM PT, 32 Top
// Shot payloads were dropped, 31 of them packs ON SALE, and 21 of the 32 were
// consistent once opens were counted to the snapshot's own stamp — every live
// Series 9 pack page had lost its tier bars, odds and chase line, and the Chase
// left board had dropped them. The DB-side check (refresh_pack_supply_counter_
// checks) already counts `sealed_at <= stamp` (`observed_by_tier`); this is the
// same rule for the Atlas path. The 11 still refuted at their own stamp stay
// dropped — that is a genuine contradiction, not lag.
//
// pack_rips.sealed_at is the OPEN time (the column name predates the meaning).
//
// ⚠ CONFIRMED OPENS ONLY (2026-11-02, topshot_confirmed_opens_as_of). A rip whose drop
// Dapper's own index did NOT confirm got its dist from the pool-vote INFERENCE, and on
// 11-02 595 AJ Dybantsa Tip-Off (8911) rips sat under other drops that way — enough to
// "refute" Dapper's correct counts on 8 drops (identity-confirmed opens equalled Atlas's
// opened count exactly on every one). A guess must never overrule a primary source, so the
// floor counts only opens whose identity row names the same dist. Fewer opens = a lower
// floor = still a valid lower bound. Migration 20261102201245.
//
// ⚠ AND THE CHAIN (2026-11-02, 20261103022129). Dapper's index froze ~10-29 (#218), so a drop minted
// after it (8911) has no identity rows and its floor read 0 — no check at all. An open now also counts
// when the on-chain Minted event names the same drop (pack_nft_mints.dist_id): a second PRIMARY source,
// never a guess. 8911 went 0 -> 701 against Atlas's 702 opened; no other floor moved.

import { boundedRead } from "@/lib/api/bounded-read"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

/** Opens observed for a Top Shot dist with sealed_at <= stamp, or null when unknown. */
export async function observedOpensAsOf(db: Db, distId: string, stampIso: string | null | undefined): Promise<number | null> {
  if (typeof stampIso !== "string" || !Number.isFinite(Date.parse(stampIso))) return null
  const { data, error } = await boundedRead(
    db.rpc("topshot_confirmed_opens_as_of", { p_dist_id: distId, p_at: stampIso }),
    "pack-dist/observed-as-of",
  )
  const n = Array.isArray(data) ? data[0] : data
  if (error || typeof n !== "number" || !Number.isFinite(n)) return null
  return n
}

export interface AtlasFloorRow {
  dist_id: string
  summary_fetched_at: string | null
  unopened_count: number | string | null
  total_pack_count: number | string | null
}

/**
 * For the rows the ALL-TIME count refutes (opened per Atlas < observed), replace
 * the floor with the count observed up to the row's own stamp. Rows the all-time
 * count already admits keep it (it can only be larger, so admitting is safe). A
 * failed as-of read keeps the all-time count — conservative: unknown never admits.
 */
export async function asOfObservedFloors(
  db: Db,
  rows: readonly AtlasFloorRow[],
  observedAll: ReadonlyMap<string, number | string | null | undefined>,
  maxQueries = 64,
): Promise<Map<string, number | string | null>> {
  const out = new Map<string, number | string | null>()
  const recheck: AtlasFloorRow[] = []
  for (const r of rows) {
    const all = observedAll.get(r.dist_id) ?? null
    out.set(r.dist_id, all)
    const total = Number(r.total_pack_count)
    const unopened = Number(r.unopened_count)
    const obs = Number(all ?? 0)
    if (Number.isFinite(total) && Number.isFinite(unopened) && Number.isFinite(obs) && total - unopened < obs) recheck.push(r)
  }
  const capped = recheck.slice(0, maxQueries)
  const asOf = await Promise.all(capped.map((r) => observedOpensAsOf(db, r.dist_id, r.summary_fetched_at)))
  capped.forEach((r, i) => {
    if (asOf[i] != null) out.set(r.dist_id, asOf[i])
  })
  return out
}
