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
