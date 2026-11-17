import { describe, it, expect } from "vitest"
import { buildSentinelFindings } from "../app/api/sentinel/route"

// 🚨 WHY THIS FILE EXISTS — a measurement, not a worry.
//
// Until 2026-09-13 the sentinel's durable row (`pipeline_runs.extra`) carried
// `critical` and `warn` as check NAMES only. Every per-pipeline fact an arm
// produced — which pipeline, how many minutes, against which threshold — lived
// ONLY in the Telegram/email body. So the database could not answer "has the
// no-success arm ever named `reconcile-saved-wallet-stats`?", and asking it
// returned a confident ZERO across 21 sentinel runs. That zero was meaningless:
// no key in the row had ever held a pipeline name, so the query could not have
// matched for ANY pipeline. It was one step from being published as a refutation
// of a real defect.
//
// ⭐ The estate's own rule, failing on the instrument that exists to make other
// instruments checkable: *a zero needs a positive control in the same
// instrument.*
//
// ⚠ AND THE CAPS ARE TESTED HERE RATHER THAN THROUGH THE ROUTE BECAUSE THROUGH
// THE ROUTE THEY CANNOT BE. No sentinel fixture produces a 400-character detail,
// so a route-level assertion on the cap passes whether or not the cap exists —
// verified by deleting the `.slice()` and watching the suite stay green. Pure
// function, synthetic inputs, caps actually exercised.

const long = (n: number) => "x".repeat(n)

describe("buildSentinelFindings — the detail survives into the durable row", () => {
  it("keeps the detail of every non-ok check, with its status", () => {
    const out = buildSentinelFindings([
      { name: "Pipeline Success", status: "warn", detail: "foo 972m since the last success (>360m, medium)" },
      { name: "Sales Freshness", status: "critical", detail: "0 new sales in last 2 hours" },
    ])
    // ⚠ Exact-shape, deliberately: `toEqual` here is what makes a silently
    // ADDED field a test failure rather than an invisible schema drift in a row
    // the alert views join on every tick. `blind`/`refused` landed 2026-09-19
    // and are asserted false on a healthy finding, which is the control for the
    // blindness block at the bottom of this file.
    expect(out).toEqual([
      { name: "Pipeline Success", status: "warn", detail: "foo 972m since the last success (>360m, medium)", blind: false, refused: false },
      { name: "Sales Freshness", status: "critical", detail: "0 new sales in last 2 hours", blind: false, refused: false },
    ])
  })

  it("drops ok checks — an all-clear has nothing to explain and this row is read every tick", () => {
    const out = buildSentinelFindings([
      { name: "Green One", status: "ok", detail: "all good" },
      { name: "Bad One", status: "warn", detail: "not good" },
    ])
    expect(out.map((f) => f.name)).toEqual(["Bad One"])
  })

  it("⭐ CAPS THE DETAIL — the assertion the route-level test could not make", () => {
    const [f] = buildSentinelFindings([{ name: "n", status: "warn", detail: long(5000) }])
    expect(f.detail.length).toBe(400)
  })

  it("⭐ CAPS THE COUNT, so a pathological run cannot bloat every row", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ name: `c${i}`, status: "warn", detail: "d" }))
    expect(buildSentinelFindings(many).length).toBe(25)
  })

  it("🚨 REDACTS — `extra` is far more widely readable than a log line", () => {
    // This estate keeps a Telegram bot token IN A URL PATH, and a check's detail
    // can quote an upstream URL. A raw detail here would be a live credential in
    // a table the alert views join.
    const [f] = buildSentinelFindings([
      { name: "n", status: "warn", detail: "failed: https://api.telegram.org/bot123456789:AAFakeTokenValueForTest/sendMessage" },
    ])
    expect(f.detail).not.toContain("AAFakeTokenValueForTest")
  })

  it("a missing detail becomes an empty string, never the literal `undefined`", () => {
    const [f] = buildSentinelFindings([{ name: "n", status: "critical" }])
    expect(f.detail).toBe("")
  })


  // 🚨 THE REGRESSION THIS BLOCK EXISTS FOR, measured 2026-09-19 over 48 h of
  // sentinel runs rather than imagined:
  //   * `Cadence Collapse` drove 15 of the 22 CRITICAL pages, and on ALL 15 its
  //     detail was exactly 400 chars of expired-ack prose ending mid-word. The
  //     arm's own measurement was not in the page. At CRITICAL, the reader was
  //     told only why a DIFFERENT, already-recovered condition had been fine.
  //   * `Detector Health (GitHub Actions)` 53/53 runs pinned at the cap.
  //   * `Measurement Blackout` 22/22 pinned at the cap.
  // The cause is that annotations are PREFIXES and an ack's `reason` is
  // operator-supplied with no length bound, so `.slice(0, 400)` kept the
  // annotation and discarded the finding.
  describe("clampSentinelDetail — the annotation must not eat the finding", () => {
    // An ack reason long enough to consume the whole budget on its own, which is
    // exactly the production shape.
    const ackPrefix = `[ACK EXPIRED 2026-09-13 — ${long(500)}] `
    const finding = "11 lanes degraded: topshot-sales-indexer 0 runs in 12h"

    it("⭐ keeps the FINDING when the annotation alone exceeds the cap", () => {
      const [f] = buildSentinelFindings([
        { name: "Cadence Collapse", status: "critical", detail: ackPrefix + finding },
      ])
      // The whole point: the measurement survives.
      expect(f.detail).toContain(finding)
      // And the reader can still tell WHICH annotation is in force.
      expect(f.detail).toContain("ACK EXPIRED 2026-09-13")
    })

    it("still caps at exactly 400 — the bound is load-bearing, not relaxed", () => {
      const [f] = buildSentinelFindings([
        { name: "n", status: "critical", detail: ackPrefix + finding },
      ])
      expect(f.detail.length).toBe(400)
    })

    it("marks the elision, so a truncated detail cannot read as a complete one", () => {
      const [f] = buildSentinelFindings([
        { name: "n", status: "critical", detail: ackPrefix + finding },
      ])
      expect(f.detail).toContain("…[cut]…")
    })

    it("leaves a detail that fits completely untouched", () => {
      const short = "0 new sales in last 2 hours"
      const [f] = buildSentinelFindings([{ name: "n", status: "warn", detail: short }])
      expect(f.detail).toBe(short)
    })

    it("is satisfiable at the boundary: exactly `max` chars is not truncated", () => {
      const [f] = buildSentinelFindings([{ name: "n", status: "warn", detail: long(400) }])
      expect(f.detail).toBe(long(400))
      expect(f.detail).not.toContain("…[cut]…")
    })
  })
})

// ── THE BLINDNESS VERDICT IS PERSISTED, NOT LEFT TO BE RE-GUESSED ───────────
//
// 🚨 The same defect class as the block at the top of this file, one field
// along. `isBlind()` takes a `didEvaluate` override — it exists because an arm
// that successfully reads SOMEONE ELSE'S timeout was being scored as having
// timed out itself — and that override lived only in memory. The durable row
// kept the detail text and dropped the field that says how to read it, so
// anyone re-deriving blindness from `extra.findings` had to re-run the very
// heuristic the override corrects.
//
// Measured 2026-09-19 over the 83 sweeps then in retention: re-deriving from
// stored text scored `Trust Health` blind on 38 of 83 sweeps and
// `Pipeline Success Coverage` on 24 — both had evaluated fine. The report could
// not be reproduced from its own record, and the error ran one way: over-count.
describe("buildSentinelFindings — blindness is recorded, not re-derived", () => {
  const SAT = "canceling statement due to statement timeout"
  const REFUSED = "aborted: sentinel wall budget spent (155.8s elapsed of a 140.0s query budget)"

  it("records an arm that could not evaluate as blind", () => {
    const [f] = buildSentinelFindings([
      { name: "A", status: "warn", detail: `INCONCLUSIVE (db saturated) — RPC error: ${SAT}` },
    ])
    expect(f.blind).toBe(true)
    expect(f.refused).toBe(false)
  })

  // ⭐ The override, and the whole reason this field is worth persisting: the
  // detail carries a saturation signature AND the arm evaluated fine. Text
  // alone cannot tell these apart; this is the case that was being got wrong.
  it("believes an arm that states it evaluated, though its detail quotes a timeout", () => {
    const [f] = buildSentinelFindings([
      { name: "Pipeline Success Coverage", status: "warn", didEvaluate: true,
        detail: `daily-portfolio-snapshot 0/1 ok, 0 rows — ${SAT}` },
    ])
    expect(f.blind).toBe(false)
  })

  it("separates REFUSED (never issued) from merely slow — both are blind, only one is refused", () => {
    const [refused, timedOut] = buildSentinelFindings([
      { name: "pg_net Dispatch", status: "warn", detail: `INCONCLUSIVE (db saturated) — ${REFUSED}` },
      { name: "Trust Health", status: "warn", detail: `INCONCLUSIVE (db saturated) — ${SAT}` },
    ])
    expect([refused.blind, refused.refused]).toEqual([true, true])
    expect([timedOut.blind, timedOut.refused]).toEqual([true, false])
  })

  // ⚠ THE ORDERING BUG THIS PINS. `clampSentinelDetail` keeps both ENDS and
  // removes the MIDDLE. Classify the clamped string and a long detail whose
  // signature sits in the middle reads as a healthy arm — a failed read
  // rendering as an answer, inside the alarm, exactly where this repo keeps
  // finding it. Mutation-proven: classifying after the clamp reds this.
  it("classifies the RAW detail, so a signature the clamp cuts is still seen", () => {
    const detail = long(300) + SAT + long(300)
    const [f] = buildSentinelFindings([{ name: "A", status: "warn", detail }])
    expect(f.detail).toContain("…[cut]…")
    expect(f.detail).not.toContain(SAT)   // the clamp really did remove it
    expect(f.blind).toBe(true)            // and the verdict survived anyway
  })

  it("does not invent blindness for a healthy finding", () => {
    const [f] = buildSentinelFindings([
      { name: "Sniper Feed", status: "warn", detail: "3 lanes below the floor (warn at 5)." },
    ])
    expect([f.blind, f.refused]).toEqual([false, false])
  })
})
