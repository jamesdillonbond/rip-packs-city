// _shared/pack-supply-parse.ts
//
// Canonical, unit-tested pure primitives for the two pack-supply backfill edge
// functions (backfill-topshot-pack-supply, backfill-allday-pack-supply). These
// fns write pack_drop_pool.drop_weight / allday_pack_supply — the numbers pack-EV
// and hit-probability are computed from — so a parse bug FABRICATES pack value.
//
// The edge fns keep their logic INLINE (they are not redeployed just to import
// this), so these copies are mirrors: they encode the exact same math and are
// tested here, and __tests__/edge-pack-supply-parse.test.ts pins the edge sources
// to still contain the load-bearing expressions. When you change one of the edge
// fns' supply math, update this module + its test in lockstep.

// ── Top Shot pool (getPackListing.packEditionsV3 edges → pack_drop_pool rows) ──

export interface TopshotEditionEdge {
  node?: {
    count?: unknown
    edition?: { set?: { flowId?: unknown } | null; play?: { flowID?: unknown } | null } | null
  } | null
}

/**
 * Parse packEditionsV3 edges into {ext,count}. An edge is kept ONLY when both the
 * set flowId and play flowID are present (a partial edge has no usable external
 * key and must be dropped, not defaulted). ext = `${setFlowId}:${playFlowId}`.
 */
export function parseTopshotEditionEdges(edges: TopshotEditionEdge[] | null | undefined): Array<{ ext: string; count: number }> {
  const out: Array<{ ext: string; count: number }> = []
  for (const e of edges ?? []) {
    const setF = e?.node?.edition?.set?.flowId
    const playF = e?.node?.edition?.play?.flowID
    if (setF != null && playF != null) out.push({ ext: `${setF}:${playF}`, count: Number(e!.node!.count ?? 0) })
  }
  return out
}

export interface PoolRow {
  collection_id: string
  dist_id: string
  edition_id: string
  edition_flow_id: string
  drop_weight: number
  orig_drop_weight: number
  slot_name: string
  pool_source: string
  last_refreshed_at: string
}

/**
 * Build pack_drop_pool upsert rows from parsed edges. Two invariants that a live
 * bug already violated once (backfill stalled at 39/1385):
 *   - counts for the SAME ext are aggregated first (parallels/repeats appear on
 *     multiple pages; two rows sharing the 4-col PK make the upsert throw);
 *   - drop_weight is the FRACTIONAL share count/total (<=1), NOT the raw count —
 *     the raw count overflows numeric(8,6); it is preserved in orig_drop_weight.
 * Only exts resolvable to an edition id are emitted.
 */
export function buildTopshotPoolPayload(
  eds: Array<{ ext: string; count: number }>,
  opts: { collectionId: string; distId: string; idByExt: Map<string, string>; nowIso: string },
): PoolRow[] {
  const countByExt = new Map<string, number>()
  for (const e of eds) countByExt.set(e.ext, (countByExt.get(e.ext) ?? 0) + (e.count || 0))
  const totalCount = [...countByExt.values()].reduce((s, c) => s + c, 0) || 1
  return [...countByExt.entries()]
    .filter(([ext]) => opts.idByExt.has(ext))
    .map(([ext, count]) => ({
      collection_id: opts.collectionId,
      dist_id: opts.distId,
      edition_id: opts.idByExt.get(ext)!,
      edition_flow_id: ext,
      drop_weight: Number((count / totalCount).toFixed(6)),
      orig_drop_weight: count,
      slot_name: "default",
      pool_source: "gql_historical",
      last_refreshed_at: opts.nowIso,
    }))
}

// ── All Day supply (searchDistributions nodes → allday_pack_supply rows) ──────

export interface AllDayDistNode {
  id?: unknown
  title?: unknown
  numberOfPackSlots?: unknown
  totalSupply?: unknown
  availableSupply?: unknown
  price?: { value?: unknown } | null
  editionIds?: unknown
  packOdds?: unknown
}

export interface AllDaySupplyRow {
  dist_id: string
  total_minted: number
  available: number
  pack_price: number | null
  slots: unknown
  pack_odds: unknown[] | null
  edition_ids: unknown[] | null
  title: unknown
  supply_ok: true
  updated_at: string
}

/**
 * Map searchDistributions nodes to allday_pack_supply rows, DEDUPED by dist_id
 * (keep-last) so a single upsert batch never touches the same conflict target
 * twice (the prior "ON CONFLICT ... cannot affect row a second time" bug).
 * total_minted comes from totalSupply; packOdds/editionIds are kept only when
 * they are arrays (a non-array becomes NULL, never a bogus [{}]).
 */
export function buildAllDaySupplyRows(nodes: AllDayDistNode[] | null | undefined, nowIso: string): AllDaySupplyRow[] {
  const byDist = new Map<string, AllDaySupplyRow>()
  for (const n of nodes ?? []) {
    if (n == null) continue
    const minted = Number(n.totalSupply ?? 0)
    const available = Number(n.availableSupply ?? 0)
    const odds = Array.isArray(n.packOdds) ? (n.packOdds as unknown[]) : null
    byDist.set(String(n.id), {
      dist_id: String(n.id),
      total_minted: minted,
      available,
      pack_price: n.price?.value != null ? Number(n.price.value) : null,
      slots: n.numberOfPackSlots ?? null,
      pack_odds: odds,
      edition_ids: Array.isArray(n.editionIds) ? (n.editionIds as unknown[]) : null,
      title: n.title ?? null,
      supply_ok: true,
      updated_at: nowIso,
    })
  }
  return Array.from(byDist.values())
}
