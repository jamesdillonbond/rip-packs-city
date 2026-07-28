// Pure, testable helpers extracted from the FLAGSHIP TopShot pack-EV writer
// (supabase/functions/compute-topshot-pack-ev/index.ts). That function is a
// ~1,570-line Deno edge function excluded from the vitest coverage measure, and
// it is deliberately NOT on the _shared/pack-ev-supply-weighted rewire the other
// three collections use (it is byte-identical to prod and must not be casually
// redeployed — see CLAUDE.md). So its money-critical primitives had ZERO
// behavioural coverage, which is exactly the class that produced the 2026-07-25
// fabricated-pack-EV P0.
//
// This module carries a VERBATIM copy of two of those primitives so they can be
// unit-tested off the Deno toolchain, and __tests__/edge-topshot-pack-ev-pricing
// .test.ts adds a source-drift guard that reddens CI if the edge fn's inline copy
// diverges from this one. It intentionally does NOT modify the edge function, so
// nothing changes in prod and no deploy is implied.
//
// computeDualPrice is NOT re-copied here: it already lives, tested, in the
// in-scope module lib/pack-ev-pricing.ts, and the edge fn documents its inline
// copy as a "verbatim port" of that one. The drift guard pins that relationship
// instead.

export interface EditionKeyNode {
  edition: {
    set?: { id?: string | null; flowId?: number | string | null } | null
    play?: { id?: string | null; flowID?: number | string | null } | null
  }
}

// v20 canonical key preference: the on-chain integer pair
// `${set.flowId}:${play.flowID}` when both flowIds are present and finite,
// otherwise the UUID pair `${set.id}:${play.id}`. `intPair` tells the caller
// which shape it got (the integer pair is the durable key; the UUID pair is a
// freshly-seeded skeleton awaiting remap). Verbatim from
// compute-topshot-pack-ev/index.ts::editionExtKey.
export function editionExtKey(node: EditionKeyNode): { ext: string | null; intPair: boolean } {
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

// Coerce an arbitrary tier string to the canonical Top Shot tier vocabulary,
// or null when it is unrecognized. Substring-matched so decorated on-chain
// values ("common", "Top Shot Rare (Series 4)") still resolve. Verbatim from
// compute-topshot-pack-ev/index.ts::normalizeTier. Note: this is the TOP SHOT
// tier set only (no UFC CHALLENGER/CONTENDER) — the writer is TS-specific.
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
