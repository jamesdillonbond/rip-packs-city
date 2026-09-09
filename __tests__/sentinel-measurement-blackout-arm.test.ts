import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import {
  isBlind,
  summariseBlindChecks,
  blindThreshold,
  BLIND_CHECK_NAME,
  INCONCLUSIVE_MARKER,
  type BlindCheckInput,
} from "../lib/sentinel/blind-checks"

// The sentinel's per-check rule — degrade a statement timeout to `warn`, never
// page — is correct and earned. The gap this arm closes is one level up: overall
// status is `checks.some(c => c.status === "warn")`, so ONE warn and THIRTEEN
// warns are the same WARN, and only CRITICAL fails the GHA job. A total
// measurement blackout therefore scores like a routine niggle.
//
// Measured 2026-09-09: six of sixteen checks INCONCLUSIVE during a nine-hour
// incident (270+ pg_cron `job startup timeout` failures, one lane down 58% of its
// runs), overall WARN, GHA green, ops_alert_dedup empty for fourteen hours.

const mk = (n: number, blind: number, disabled: string[] = []): BlindCheckInput[] =>
  Array.from({ length: n }, (_, i) => ({
    name: disabled[i] ?? `check-${i}`,
    status: "ok" as const,
    detail: i < blind ? `${INCONCLUSIVE_MARKER} (db saturated) — statement timeout` : "fine",
  }))

describe("sentinel: the measurement-blackout arm", () => {
  it("FIRES on the positive anchor — 6 of 16, the 2026-09-09 incident", () => {
    const s = summariseBlindChecks(mk(16, 6))
    expect(s.blind).toBe(6)
    expect(s.evaluated).toBe(16)
    expect(s.threshold).toBe(6)
    expect(s.status).toBe("warn")
  })

  it("STAYS QUIET on the negative anchor — 4 of 16, the 2026-06-10 false page", () => {
    // ⚠ The control that stops this arm re-committing the mistake that created
    // the per-check downgrade in the first place. The sentinel route's header
    // describes that page as "4 parts timeout noise, 0 parts data loss".
    const s = summariseBlindChecks(mk(16, 4))
    expect(s.blind).toBe(4)
    expect(s.status).toBe("ok")
  })

  it("NEVER returns critical, at any blackout level (structural cap)", () => {
    // A ban, not a sample: escalating a blackout to CRITICAL is the 2026-06-10
    // mistake one level up. Checked across the whole range including total.
    for (let blind = 0; blind <= 16; blind++) {
      const s = summariseBlindChecks(mk(16, blind))
      expect(s.status, `blind=${blind} must never be critical`).not.toBe("critical")
      expect(["ok", "warn"]).toContain(s.status)
    }
  })

  it("reports the count even when it is OK — this arm is the distribution accumulator", () => {
    // ⚠ Load-bearing, and the reason the threshold is honest about being weak.
    // The sentinel report is not persisted, so there is no history to fit a
    // threshold to. Printing the count on every run is what builds one. An arm
    // that only speaks when it fires can never be re-derived.
    const quiet = summariseBlindChecks(mk(16, 2))
    expect(quiet.status).toBe("ok")
    expect(quiet.detail).toMatch(/2 of 16/)
    const clean = summariseBlindChecks(mk(16, 0))
    expect(clean.detail).toMatch(/All 16 checks were evaluated/)
  })

  it("excludes itself from its own population", () => {
    const withSelf: BlindCheckInput[] = [
      ...mk(4, 4),
      { name: BLIND_CHECK_NAME, status: "warn", detail: `${INCONCLUSIVE_MARKER} self` },
    ]
    const s = summariseBlindChecks(withSelf)
    expect(s.evaluated).toBe(4)
    expect(s.names).not.toContain(BLIND_CHECK_NAME)
  })

  it("excludes config-disabled checks, so a disabled arm cannot inflate it forever", () => {
    // The chronic-warn failure the sentinel route explicitly warns about: a
    // permanently-disabled inconclusive check would otherwise pin this arm.
    const checks = mk(16, 6)
    checks[0].name = "off-1"
    checks[1].name = "off-2"
    const s = summariseBlindChecks(checks, new Set(["off-1", "off-2"]))
    expect(s.blind).toBe(4)
    expect(s.evaluated).toBe(14)
    expect(s.status).toBe("ok")
  })

  it("scales the threshold with the number of checks, never below the floor", () => {
    expect(blindThreshold(16)).toBe(6)
    expect(blindThreshold(30)).toBe(10)
    expect(blindThreshold(6)).toBe(5) // floor, not 2
    expect(blindThreshold(3)).toBe(5) // floor holds on a tiny report
  })

  it("REPLAYS THE REAL 2026-09-09 18:47Z SWEEP and fires — the arm's own falsifier", () => {
    // ⚠⚠ This test caught the arm being WRONG before it shipped. Keyed on the
    // INCONCLUSIVE label alone it counted FOUR here, under its own threshold of
    // six, and would have stayed silent on the incident it exists for. Two
    // checks time out with the identical saturation error and are never
    // labelled, because they build their detail by hand.
    //
    // Details below are VERBATIM from the production sentinel log for run
    // 34391184562 — a real payload, not a fixture written to pass.
    const real: BlindCheckInput[] = [
      { name: "Sales Ingest (2h)", status: "ok", detail: "562 new sales in last 2 hours" },
      { name: "Sales Ingest by Collection", status: "warn", detail: "INCONCLUSIVE (db saturated) — RPC error: canceling statement due to statement timeout" },
      { name: "Sales Ingest by Source", status: "warn", detail: "INCONCLUSIVE (db saturated) — RPC error: canceling statement due to statement timeout" },
      { name: "FMV Freshness", status: "ok", detail: "Latest FMV snapshot: 0.0h ago" },
      { name: "Ownership Index Freshness", status: "ok", detail: "Last ownership write: 5.3h ago (ownership-onchain-walk)" },
      // ⬇ unlabelled, but saturation — the two this arm would have missed
      { name: "FMV Confidence (canonical TS)", status: "warn", detail: "RPC error (canceling statement due to statement timeout)" },
      { name: "Edition Coverage", status: "warn", detail: "Coverage RPC error: canceling statement due to statement timeout" },
      { name: "TS Edition Writer Leak (48h)", status: "ok", detail: "0 inert UUID-keyed TS edition rows created in last 48h" },
      { name: "Pipeline Silence", status: "warn", detail: "ts-listings-atlas-sync silent 54m (>20m, medium)" },
      { name: "Pipeline Success", status: "warn", detail: "ts-listings-atlas-sync 54m since the last success (>45m, medium)" },
      { name: "Pipeline Success Coverage", status: "ok", detail: "All 134 watchlisted pipelines ... produced at least one success" },
      { name: "Dune Spend (cycle)", status: "warn", detail: "103.5% of datapoints at 54.1% of the cycle" },
      { name: "Trust Health", status: "warn", detail: "INCONCLUSIVE (db saturated) — Query error: canceling statement due to statement timeout" },
      { name: "Total Sales", status: "ok", detail: "~4,864,327 total sales in database (planner estimate)" },
      { name: "Sniper Feed", status: "warn", detail: "INCONCLUSIVE (db saturated) — Timeout or error: This operation was aborted" },
      { name: "Detector Health (GitHub Actions)", status: "warn", detail: "Consecutive-failure streaks: edge-fn-drift 12x (warn at 3, crit at 7)" },
    ]
    const s = summariseBlindChecks(real)
    expect(s.evaluated).toBe(16)
    expect(s.blind, "the two unlabelled saturation checks must be counted").toBe(6)
    expect(s.names).toContain("FMV Confidence (canonical TS)")
    expect(s.names).toContain("Edition Coverage")
    expect(s.status).toBe("warn")

    // ⛔ And the control that makes the above meaningful: the genuinely-real
    // warns in the same payload are NOT counted as blind. If they were, this
    // arm would just be re-counting `warn` and would say nothing new.
    expect(s.names).not.toContain("Pipeline Silence")
    expect(s.names).not.toContain("Dune Spend (cycle)")
    expect(s.names).not.toContain("Detector Health (GitHub Actions)")
  })

  it("distinguishes a saturation failure from an ordinary threshold breach", () => {
    expect(isBlind("INCONCLUSIVE (db saturated) — whatever")).toBe(true)
    expect(isBlind("RPC error (canceling statement due to statement timeout)")).toBe(true)
    expect(isBlind("Timeout or error: This operation was aborted")).toBe(true)
    // NOT blind: real findings, which must never inflate this arm
    expect(isBlind("ts-listings-atlas-sync silent 54m (>20m, medium)")).toBe(false)
    expect(isBlind("562 new sales in last 2 hours")).toBe(false)
    expect(isBlind("103.5% of datapoints at 54.1% of the cycle")).toBe(false)
    expect(isBlind(undefined)).toBe(false)
  })

  it("COUPLING: the marker it counts is the one the sentinel route actually stamps", () => {
    // ⚠ The failure mode that would make this arm silently useless: the route
    // renames its marker text and this arm reads 0 blind checks forever, on
    // every run, with no error. Pin the coupling to the route's own constant
    // rather than trusting two string literals to stay in step.
    const route = readFileSync("app/api/sentinel/route.ts", "utf8")
    const m = route.match(/const INCONCLUSIVE = "([^"]+)"/)
    expect(m, "the sentinel route must still define an INCONCLUSIVE constant").toBeTruthy()
    expect(
      m![1].includes(INCONCLUSIVE_MARKER),
      `route marker ${JSON.stringify(m![1])} no longer contains ${JSON.stringify(INCONCLUSIVE_MARKER)} — this arm would silently count zero`,
    ).toBe(true)
  })

  it("is actually WIRED INTO the route, not merely defined", () => {
    // A helper nothing calls is the "instrument nobody keys on" trap.
    const route = readFileSync("app/api/sentinel/route.ts", "utf8")
    expect(route).toMatch(/summariseBlindChecks\(/)
    expect(route).toMatch(/BLIND_CHECK_NAME/)
    // and it must run BEFORE the overall status is computed, or it can never
    // affect the report it is summarising.
    expect(route.indexOf("summariseBlindChecks(checks")).toBeLessThan(
      route.indexOf("const hasCritical = checks.some"),
    )
  })
})
