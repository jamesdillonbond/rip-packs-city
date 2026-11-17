import { describe, it, expect } from "vitest"
import {
  nextChunkBounds,
  clampChunkTarget,
} from "@/workers/pack-events-ingest/chunk-bounds"

// Pins the pack-events-ingest cursor chunk-loop bounding logic (extracted from
// the processCursor while-loop). A regression here silently skips or re-scans
// blocks, corrupting pack_purchases, so every branch of the live vs backfill
// stop conditions and window clamping is asserted. Production constants:
// CHUNK_SIZE = 250, CAUGHT_UP_THRESHOLD = 50.

describe("nextChunkBounds — live mode (effectiveEndBlock === null)", () => {
  it("returns null when sealedTip is not supplied", () => {
    expect(nextChunkBounds(100, null, null, 250, 50)).toBeNull()
  })

  it("returns null when caught up to tip (within threshold, boundary equal)", () => {
    // tip - target === threshold → caught up
    expect(nextChunkBounds(100, null, 150, 250, 50)).toBeNull()
  })

  it("returns null when caught up to tip (within threshold, strictly under)", () => {
    expect(nextChunkBounds(100, null, 130, 250, 50)).toBeNull()
  })

  it("returns null when tip is behind the target", () => {
    expect(nextChunkBounds(100, null, 90, 250, 50)).toBeNull()
  })

  it("advances a full chunk when the tip is far ahead", () => {
    // remaining (1000 - 100 = 900) > chunkSize, so `to` = target + chunkSize
    expect(nextChunkBounds(100, null, 1000, 250, 50)).toEqual({ from: 101, to: 350 })
  })

  it("clamps `to` to the tip when the tip is nearer than a full chunk", () => {
    // tip - target = 200 > threshold(50) so not caught up, but < chunkSize(250)
    expect(nextChunkBounds(100, null, 300, 250, 50)).toEqual({ from: 101, to: 300 })
  })

  it("returns null via the to<from guard when chunkSize collapses the window", () => {
    // Not caught up (105-100=5 > threshold 0), but chunkSize 0 → to=100 < from=101
    expect(nextChunkBounds(100, null, 105, 0, 0)).toBeNull()
  })
})

describe("nextChunkBounds — backfill mode (effectiveEndBlock is a number)", () => {
  it("returns null when the cursor already reached the end block (equal)", () => {
    expect(nextChunkBounds(500, 500, null, 250, 50)).toBeNull()
  })

  it("returns null when the cursor is past the end block", () => {
    expect(nextChunkBounds(600, 500, null, 250, 50)).toBeNull()
  })

  it("advances a full chunk when the end block is far ahead", () => {
    expect(nextChunkBounds(100, 1000, null, 250, 50)).toEqual({ from: 101, to: 350 })
  })

  it("clamps `to` to the end block on the final chunk", () => {
    // target+chunkSize = 450 would overshoot end=400 → clamp to 400
    expect(nextChunkBounds(300, 400, null, 250, 50)).toEqual({ from: 301, to: 400 })
  })

  it("ignores sealedTip in backfill mode", () => {
    // sealedTip far behind must not affect the backfill window
    expect(nextChunkBounds(100, 1000, 0, 250, 50)).toEqual({ from: 101, to: 350 })
  })
})

describe("clampChunkTarget", () => {
  it("returns `to` unchanged in live mode (effectiveEndBlock === null)", () => {
    expect(clampChunkTarget(350, null)).toBe(350)
  })

  it("returns `to` unchanged in backfill mode when below the end block", () => {
    expect(clampChunkTarget(350, 1000)).toBe(350)
  })

  it("clamps `to` down to the end block when it would overshoot", () => {
    expect(clampChunkTarget(450, 400)).toBe(400)
  })

  it("returns the end block when `to` equals it", () => {
    expect(clampChunkTarget(400, 400)).toBe(400)
  })
})
