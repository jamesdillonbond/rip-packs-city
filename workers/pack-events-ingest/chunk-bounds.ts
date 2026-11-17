// Cursor chunk-loop bounding for pack-events-ingest, extracted from the
// `processCursor` while-loop in index.ts so the block-range math can be
// unit-tested. This is the logic that decides, per iteration, which
// [from, to] block window the next event scan covers — and when a cursor
// has reached its stop condition (caught up to sealed tip in live mode, or
// reached its fixed end block in backfill mode). A regression here silently
// skips or re-scans blocks, corrupting what lands in pack_purchases, so each
// branch deserves its own pin.
//
// Pure + dependency-free (no Cloudflare/Deno globals, no fetch, no env) so it
// imports cleanly under Node/vitest. index.ts imports these.

export interface ChunkBounds {
  from: number;
  to: number;
}

// Decide the next [from, to] block window for a cursor at `target`, or null
// when the cursor's stop condition is met (caught up / reached end / empty
// window).
//
//   Live mode      (effectiveEndBlock === null): chase `sealedTip`. Stop when
//                  within `caughtUpThreshold` of the tip. `sealedTip` MUST be
//                  supplied in this mode.
//   Backfill mode  (effectiveEndBlock is a number): walk toward the fixed end
//                  block. Stop once `target >= effectiveEndBlock`. `sealedTip`
//                  is ignored.
//
// The trailing `to < from` guard mirrors the defensive check in index.ts.
export function nextChunkBounds(
  target: number,
  effectiveEndBlock: number | null,
  sealedTip: number | null,
  chunkSize: number,
  caughtUpThreshold: number,
): ChunkBounds | null {
  let from: number;
  let to: number;
  if (effectiveEndBlock === null) {
    if (sealedTip === null) return null;
    if (sealedTip - target <= caughtUpThreshold) return null;
    from = target + 1;
    to = Math.min(target + chunkSize, sealedTip);
  } else {
    if (target >= effectiveEndBlock) return null;
    from = target + 1;
    to = Math.min(target + chunkSize, effectiveEndBlock);
  }
  if (to < from) return null;
  return { from, to };
}

// Defensive clamp applied to the block a chunk advanced the cursor to: in
// backfill mode the cursor must never overshoot the fixed end block; in live
// mode the chunk `to` is returned unchanged. Mirrors the `chunkTarget`
// computation in index.ts.
export function clampChunkTarget(to: number, effectiveEndBlock: number | null): number {
  return effectiveEndBlock !== null ? Math.min(to, effectiveEndBlock) : to;
}
