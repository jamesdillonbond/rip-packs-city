// Shared pure logic for Top Shot pack-EV edition keying + tier normalization.
//
// These two helpers are the correctness core of the pack-EV pool: `editionExtKey`
// builds the canonical key each edition node resolves under (the int-pair
// `${set.flowId}:${play.flowID}` when both on-chain ints are present, else the
// legacy UUID pair) — used for BOTH the resolve set and the pool rows so they can
// never diverge (the v20 fix). `normalizeTier` collapses the many MOMENT_TIER_*
// / display spellings into the canonical enum bucket, returning null for anything
// unrecognized so an unknown tier never poisons the pool.
//
// Ported VERBATIM from supabase/functions/compute-topshot-pack-ev/index.ts
// (editionExtKey ~line 373, normalizeTier ~line 646). This module is a
// Deno-and-vitest-importable extraction so the keying math is pinned by unit
// tests. The deployed edge function still carries the inline copies; wiring it to
// import from here is a deploy-gated follow-up (Deno deploy), tracked so the two
// don't silently diverge.

export interface EditionNode {
  count: number
  remaining: number
  edition: {
    id: string
    tier: string
    set: { id: string; flowId?: number | string | null } | null
    play: { id: string; flowID?: number | string | null } | null
  }
}

// v20: canonical key preference — int pair `${set.flowId}:${play.flowID}` when
// both ints are present, else the legacy UUID pair. Single source of truth for
// BOTH the resolve set and the pool rows so they can never diverge.
export function editionExtKey(node: EditionNode): { ext: string | null; intPair: boolean } {
  const setFlowRaw = node.edition.set?.flowId
  const playFlowRaw = node.edition.play?.flowID
  if (
    setFlowRaw != null && playFlowRaw != null &&
    Number.isFinite(Number(setFlowRaw)) && Number.isFinite(Number(playFlowRaw))
  ) {
    return { ext: `${Number(setFlowRaw)}:${Number(playFlowRaw)}`, intPair: true }
  }
  const setId = node.edition.set?.id
  const playId = node.edition.play?.id
  if (setId && playId) return { ext: `${setId}:${playId}`, intPair: false }
  return { ext: null, intPair: false }
}

export function normalizeTier(raw: unknown): string | null {
  if (!raw) return null
  const t = String(raw).toUpperCase()
  if (t.includes("ULTIMATE")) return "ULTIMATE"
  if (t.includes("LEGENDARY")) return "LEGENDARY"
  if (t.includes("RARE")) return "RARE"
  if (t.includes("FANDOM")) return "FANDOM"
  if (t.includes("COMMON")) return "COMMON"
  return null
}

export interface PackPoolRow {
  editionId: string
  editionFlowId: string
  /** remaining / totalUnopened — the survivor-biased draw weight (0 when totalUnopened <= 0). */
  dropWeight: number
  /** the edition's ORIGINAL mint-time draw count (Item 4) — EV prefers this honest fresh-pack basis. */
  origDropWeight: number
}

// v22 pool-merge core — ported VERBATIM from compute-topshot-pack-ev/index.ts
// (the `merged` Map loop + row build, ~line 1257). packEditionsV3 returns one
// node PER SLOT, so an edition drawn by multiple slots appears multiple times;
// this merges by resolved edition uuid (summing count + remaining) so the pool
// carries exactly one row per edition. Un-keyable nodes (editionExtKey null) and
// nodes that don't resolve to a known edition are dropped. First occurrence sets
// the ext key. Extracting it here pins the dedup + weight math that a duplicate
// edition_id in one insert chunk used to break (PK collision → empty pool → the
// $0-EV sentinel class). The deployed edge function still carries the inline
// copy; wiring it to import from here is a deploy-gated follow-up.
export function mergePackPoolNodes(
  nodes: EditionNode[],
  resolveEditionId: (extKey: string) => string | undefined,
  totalUnopened: number,
): PackPoolRow[] {
  const merged = new Map<string, { ext: string; edId: string; count: number; remaining: number }>()
  for (const node of nodes) {
    const { ext } = editionExtKey(node)
    if (!ext) continue
    const edId = resolveEditionId(ext)
    if (!edId) continue
    const cur = merged.get(edId)
    if (cur) {
      cur.count += node.count ?? 0
      cur.remaining += node.remaining ?? 0
    } else {
      merged.set(edId, { ext, edId, count: node.count ?? 0, remaining: node.remaining ?? 0 })
    }
  }
  const rows: PackPoolRow[] = []
  for (const m of merged.values()) {
    const dropWeight = totalUnopened > 0 ? m.remaining / totalUnopened : 0
    rows.push({ editionId: m.edId, editionFlowId: m.ext, dropWeight, origDropWeight: m.count })
  }
  return rows
}
