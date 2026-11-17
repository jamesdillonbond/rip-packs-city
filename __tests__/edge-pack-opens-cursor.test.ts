import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { nextBackfillCursor } from "@/supabase/functions/_shared/pack-opens-cursor"

// Unit coverage + source-drift guard for the descending pack-opens backfill
// cursor decision. The edge function keeps this arithmetic inline (Deno source,
// outside vitest/tsc); this pins the MIRROR (_shared/pack-opens-cursor.ts) and
// fails CI if the inline block drifts from it.

describe("nextBackfillCursor — the scanning-is-not-writing invariant", () => {
  // Baseline: a clean tick that scanned the whole window down to scannedFloor and
  // resolved every open. The cursor advances (down) to scannedFloor.
  it("advances to the scanned floor when resolution was complete", () => {
    expect(
      nextBackfillCursor({ cur: 1000, floor: 0, scannedFloor: 500, resolvedFloor: 500, exhausted: false }),
    ).toBe(500)
  })

  it("advances even when resolvedFloor is null, as long as it did not exhaust (no opens to resolve)", () => {
    // A window with zero opens resolves nothing (resolvedFloor null) but is NOT
    // exhausted — there was simply nothing to write, so scanning is sufficient.
    expect(
      nextBackfillCursor({ cur: 1000, floor: 0, scannedFloor: 500, resolvedFloor: null, exhausted: false }),
    ).toBe(500)
  })

  // The load-bearing case: it scanned down to 500, but the tx budget ran out and
  // only resolved opens down to block 700. Advancing to 500 would step over the
  // unwritten opens in [500, 700). It must HOLD at the resolved floor.
  it("HOLDS at the resolved floor when exhausted with opens still unresolved", () => {
    expect(
      nextBackfillCursor({ cur: 1000, floor: 0, scannedFloor: 500, resolvedFloor: 700, exhausted: true }),
    ).toBe(700)
  })

  // Exhausted before ANY tx was processed → resolvedFloor null → hold entirely
  // (do not advance past cur). This is the "no tx processed at all, hold" note.
  it("HOLDS at the current cursor when exhausted before resolving anything", () => {
    expect(
      nextBackfillCursor({ cur: 1000, floor: 0, scannedFloor: 500, resolvedFloor: null, exhausted: true }),
    ).toBe(1000)
  })

  it("never walks the cursor back UP (clamps to cur)", () => {
    // A degenerate scannedFloor above cur must not move the cursor upward.
    expect(
      nextBackfillCursor({ cur: 400, floor: 0, scannedFloor: 900, resolvedFloor: 900, exhausted: false }),
    ).toBe(400)
  })

  it("never advances below the reachable floor (clamps to floor)", () => {
    expect(
      nextBackfillCursor({ cur: 1000, floor: 600, scannedFloor: 500, resolvedFloor: 500, exhausted: false }),
    ).toBe(600)
  })

  it("clamps an exhausted resolvedFloor below cur down into range too", () => {
    // exhausted, resolvedFloor 550 > scannedFloor 500 → hold at 550, then floor
    // clamp keeps it >= floor.
    expect(
      nextBackfillCursor({ cur: 1000, floor: 520, scannedFloor: 500, resolvedFloor: 550, exhausted: true }),
    ).toBe(550)
  })
})

describe("source-drift guard: the inline edge block matches this mirror", () => {
  it("ingest-topshot-pack-opens-history still uses the mirrored cursor arithmetic", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../supabase/functions/ingest-topshot-pack-opens-history/index.ts"),
      "utf8",
    )
    // Normalize whitespace so formatting changes don't false-trip the guard.
    const flat = src.replace(/\s+/g, " ")
    // If any of these drift, update _shared/pack-opens-cursor.ts + this test in
    // lockstep (they are the mirror), don't just silence the guard.
    expect(flat, "scannedFloor seed line drifted").toContain("let after = scannedFloor")
    expect(flat, "exhausted-hold line drifted").toContain(
      "if (exhausted) after = Math.max(after, resolvedFloor ?? cur)",
    )
    expect(flat, "never-walk-back clamp drifted").toContain("after = Math.min(after, cur)")
    expect(flat, "floor clamp drifted").toContain("after = Math.max(after, floor)")
  })
})
