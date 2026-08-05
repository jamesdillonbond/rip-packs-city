import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { nextBackfillCursor } from "@/supabase/functions/_shared/pack-opens-cursor"

// Regression pins for ingest-allday-pack-opens — the pack-opens walker with the
// worst documented incident in this repo. On 2026-07-25 a single transient
// PostgREST blip made getCursor return null (conflating "read failed" with
// "cursor unset"), the caller took the `cur == null` INIT branch and RESET the
// cursor to tip: the backfill jumped 127,740,659 -> 159,183,789 and re-walked
// ~31.4M already-ingested blocks (~18.4k Flow REST calls/day for ~93 genuinely
// new rows) until it was noticed. A later class (2026-08-01) advanced the cursor
// past unresolved opens on a tx-budget stop, silently dropping them.
//
// The fixes for BOTH live inline in this fn (Deno source, outside vitest/tsc),
// and — unlike its topshot twin — none of them were pinned:
//   • the descending-backfill cursor arithmetic is IDENTICAL to the twin's, but
//     the drift guard in edge-pack-opens-cursor.test.ts only checks the twin;
//   • the forward-mode "hold on a failed window" decision was pinned nowhere;
//   • getCursor's discriminated-union (the exact 2026-07-25 bug) was unpinned.
//
// These read the source as text and assert the structural invariants, matching
// the house source-drift-guard style. Each "guard is not a no-op" block proves
// the assertion flips on the reverted shape, so none of these can silently pass.

const SRC = readFileSync(
  path.resolve(__dirname, "../supabase/functions/ingest-allday-pack-opens/index.ts"),
  "utf8",
)
// Whitespace-normalized so formatting changes don't false-trip the pins.
const FLAT = SRC.replace(/\s+/g, " ")

describe("getCursor discriminated-union — a read error must NOT re-seed the cursor (the 2026-07-25 bug)", () => {
  it("returns { ok: false, error } on a cursor read error rather than null", () => {
    // The reverted bug returned `data ? Number(...) : null` on BOTH the error and
    // the empty case, so a transient error looked like an unset cursor and the
    // caller re-seeded to tip. The fix returns a discriminated failure first.
    expect(FLAT, "getCursor error branch drifted — a read error must return ok:false, not null").toContain(
      "if (error) return { ok: false, error:",
    )
  })

  it("both walker modes ABORT on a failed cursor read before the reseed branch is reachable", () => {
    // Each mode: `if (!curRead.ok) { ...log cursor_read_failed; return }` sits
    // BEFORE `if (cur == null) { setCursor(tip) }`. The ordering is the whole
    // safety property: the init/reseed can only run once a successful read has
    // proven the cursor is genuinely unset.
    expect((FLAT.match(/if \(!curRead\.ok\)/g) ?? []).length, "expected both forward and backfill to guard the cursor read").toBe(2)
    expect(FLAT).toContain("cursor_read_failed: true")

    const fwdAbort = SRC.indexOf('if (!curRead.ok) { await logRun("allday-pack-opens-forward"')
    const fwdReseed = SRC.indexOf("if (cur == null) { await setCursor(CUR_FWD, t)")
    const backAbort = SRC.indexOf('if (!curRead.ok) { await logRun("allday-pack-opens-backfill"')
    const backReseed = SRC.indexOf("if (cur == null) { await setCursor(CUR_BACK, t)")
    expect(fwdAbort, "forward cursor-read abort missing").toBeGreaterThan(-1)
    expect(backAbort, "backfill cursor-read abort missing").toBeGreaterThan(-1)
    // Abort precedes reseed in each mode — reintroducing the bug (reseed reachable
    // on a read error) moves the reseed before the abort and flips these.
    expect(fwdAbort, "forward reseed must sit AFTER the read-error abort").toBeLessThan(fwdReseed)
    expect(backAbort, "backfill reseed must sit AFTER the read-error abort").toBeLessThan(backReseed)
  })

  it("guard is not a no-op: the reverted null-on-error shape would fail the pin", () => {
    const reverted = "if (error) return { ok: true, value: null }".replace(/\s+/g, " ")
    expect(reverted).not.toContain("if (error) return { ok: false, error:")
  })
})

describe("forward-mode — never advance the cursor past a failed window", () => {
  it("computes the next cursor as start-1 when the scan or resolve failed", () => {
    expect(FLAT, "forward hold-on-failure decision drifted").toContain(
      "const after = err || rerr ? start - 1 : end",
    )
  })

  it("only persists the cursor when it actually moved forward (after >= start)", () => {
    // A failed window yields after = start-1 < start, so this gate skips the
    // write entirely — the next tick re-scans the same window. A regression that
    // wrote unconditionally would advance past the un-ingested range.
    expect(FLAT, "forward setCursor gate drifted").toContain("if (after >= start) await setCursor(CUR_FWD, after)")
  })

  it("guard is not a no-op: the reverted unconditional-advance shape would fail the pin", () => {
    const reverted = "const after = end".replace(/\s+/g, " ")
    expect(reverted).not.toContain("const after = err || rerr ? start - 1 : end")
  })
})

describe("backfill-mode — the scanning-is-not-writing cursor arithmetic matches the tested mirror", () => {
  // This fn keeps the descending-backfill arithmetic inline, identical to
  // ingest-topshot-pack-opens-history. The executable behaviour of that block is
  // unit-tested via nextBackfillCursor in edge-pack-opens-cursor.test.ts; the
  // twin is drift-guarded there but THIS fn was not. Pin it here so the two
  // inline copies and the mirror cannot diverge silently.
  it("still uses the mirrored four-line cursor arithmetic", () => {
    expect(FLAT, "scannedFloor seed drifted").toContain("let after = scannedFloor")
    expect(FLAT, "exhausted-hold drifted").toContain("if (exhausted) after = Math.max(after, resolvedFloor ?? cur)")
    expect(FLAT, "never-walk-back clamp drifted").toContain("after = Math.min(after, cur)")
    expect(FLAT, "floor clamp drifted").toContain("after = Math.max(after, floor)")
  })

  it("the mirror encodes the load-bearing case: HOLD at the resolved floor when exhausted", () => {
    // Cross-check the executable mirror the inline block matches, so this file
    // fails loudly if the mirror's meaning (not just the inline text) regresses.
    expect(nextBackfillCursor({ cur: 1000, floor: 0, scannedFloor: 500, resolvedFloor: 700, exhausted: true })).toBe(700)
    expect(nextBackfillCursor({ cur: 1000, floor: 0, scannedFloor: 500, resolvedFloor: 500, exhausted: false })).toBe(500)
  })
})
