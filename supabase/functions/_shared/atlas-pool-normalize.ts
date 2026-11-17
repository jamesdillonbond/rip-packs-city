// Shared pure logic for ingest-topshot-atlas-pool — the edge fn that turns a raw
// TopShot Atlas GetDistributionEditions response into canonical drop-pool rows
// ({ set, play, remaining, original }). Those rows are the drop pool that pack-EV
// weights every edition against, so a normalize bug that mis-read `remaining`
// (the survivor weight) or silently accepted a wrong-shaped envelope as data
// would skew every pack's EV — the fabricated-EV class. The kind discriminator
// keeps an empty-but-well-formed envelope (`empty`, a normal no-pool dist)
// distinct from a genuinely unrecognised shape (`unmapped`, which the caller
// rejects + logs), so a schema change surfaces loudly instead of writing zeros.
//
// Ported VERBATIM from ingest-topshot-atlas-pool/index.ts. The deployed edge fn
// still carries inline copies; the source-drift guard in
// __tests__/edge-atlas-pool-normalize.test.ts fails CI if an inline copy is
// edited without mirroring it here. No Deno APIs used — imports cleanly under
// vitest.

/** Coerce to a finite number, else null. `false` and null map to null. */
export function num(v: any): number | null {
  if (v == null || v === false) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export type NormResult = {
  kind: "ok" | "empty" | "unmapped"
  rows: Array<{ set: number; play: number; remaining: number; original: number }> | null
  sampleKeys: string[]
  totalCount: number | null
}

/**
 * Normalize a raw Atlas GetDistributionEditions response into canonical rows.
 * Primary shape: { editions:[ { editionId, originalCount, remainingCount,
 * edition:{ setId, editionTemplateId } } ], totalCount }; legacy fallback keys
 * kept. `empty` = well-formed envelope with an empty editions array (Atlas has no
 * pool data for this id — normal for bundle/case dists). `unmapped` = a shape we
 * genuinely don't recognise (caller rejects + logs the keys).
 */
export function normalizeAtlas(raw: any): NormResult {
  const totalCount = num(raw?.totalCount) ?? num(raw?.data?.totalCount)
  const arr = raw?.editions ?? raw?.data?.editions ?? (Array.isArray(raw) ? raw : null)
  if (Array.isArray(arr) && arr.length === 0) {
    return { kind: "empty", rows: null, sampleKeys: raw ? Object.keys(raw) : [], totalCount }
  }
  if (!Array.isArray(arr)) {
    return { kind: "unmapped", rows: null, sampleKeys: raw ? Object.keys(raw) : [], totalCount }
  }
  const sampleKeys = Object.keys(arr[0] ?? {})
  const rows: Array<{ set: number; play: number; remaining: number; original: number }> = []
  for (const e of arr) {
    if (!e) continue
    const ed = e.edition ?? {}
    // Confirmed Atlas fields first, then legacy fallbacks.
    const set = num(ed.setId) ?? num(e.setFlowId) ?? num(e.set_flow_id) ?? num(e.setId) ?? num(e.set?.flowId)
    const play = num(ed.editionTemplateId) ?? num(e.playFlowId) ?? num(e.play_flow_id) ?? num(e.playId) ?? num(e.play?.flowID)
    const remaining = num(e.remainingCount) ?? num(e.remaining_count) ?? num(e.remaining)
    const original = num(e.originalCount) ?? num(e.original_count) ?? num(e.original) ?? 0
    if (set == null || play == null || remaining == null) continue
    rows.push({ set, play, remaining, original: original ?? 0 })
  }
  if (rows.length === 0) return { kind: "unmapped", rows: null, sampleKeys, totalCount }
  return { kind: "ok", rows, sampleKeys, totalCount }
}
