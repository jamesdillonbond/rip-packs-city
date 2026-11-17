// Shared pure logic for backfill-topshot-subeditions — the edge fn that reads a
// TopShot moment's subedition (parallel printing) CIRCULATION off chain and
// writes it into editions.circulation_count for `setID:playID::subID` rows.
// That circulation is a SCARCITY input into FMV and pack-EV: a decode bug that
// dropped or mis-scaled a subedition count would inject wrong scarcity into
// prices — the exact class behind the 2026-07-28 "53 flagged parallel editions
// missing parallel-specific circulation" finding, where a wrong value would be
// worse than the honest NULL.
//
// Ported VERBATIM from backfill-topshot-subeditions/index.ts. The deployed edge
// fn still carries inline copies; the source-drift guard in
// __tests__/edge-topshot-subedition-parse.test.ts fails CI if an inline copy is
// edited without mirroring it here. No Deno APIs used — imports cleanly under
// vitest.

/**
 * Cadence/JSON unwrapper for a `{UInt64: UInt32}` Dictionary response. Returns a
 * plain `{ nftId: subeditionCount }` map. A non-Dictionary node, a missing value
 * array, or an entry whose value is non-finite is skipped (never NaN into a
 * circulation column, never a throw on a malformed node).
 */
export function decodeDict(node: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!node || typeof node !== "object") return out
  const d = node as { type?: string; value?: Array<{ key: { value: string }; value: { value: string } }> }
  if (d.type !== "Dictionary" || !Array.isArray(d.value)) return out
  for (const kv of d.value) {
    const k = String(kv.key?.value ?? "")
    const v = Number(kv.value?.value ?? NaN)
    if (k && Number.isFinite(v)) out[k] = v
  }
  return out
}

/**
 * Clamp to an integer in [lo, hi]. A non-finite input floors to `lo` (never
 * writes NaN); a fractional value is floored, not rounded. Used to bound the
 * requested batch size before it drives the on-chain fan-out.
 */
export function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, Math.floor(n)))
}
