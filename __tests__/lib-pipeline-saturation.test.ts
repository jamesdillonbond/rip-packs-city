import { describe, it, expect } from "vitest"
import { isSaturationError } from "@/lib/pipeline/saturation"

// The classifier that decides whether a pipeline/query error is DB saturation
// (inconclusive — the DB was slow, warn) vs a genuine failure (surface it).
// A false negative here re-pages saturation noise; a false positive would
// silently swallow a real regression, so both directions are pinned.

describe("isSaturationError", () => {
  it("treats an empty/missing message as saturation (supabase-js aborts surface as {message:''})", () => {
    expect(isSaturationError("")).toBe(true)
    expect(isSaturationError(null)).toBe(true)
    expect(isSaturationError(undefined)).toBe(true)
  })

  it("matches every known saturation signature (case-insensitive)", () => {
    const saturated = [
      "canceling statement due to statement timeout",
      "Timed out acquiring connection from connection pool.",
      "CONNECTION POOL exhausted",
      "connection terminated unexpectedly",
      "upstream request timeout",
      "fetch failed",
      "The operation was aborted due to timeout",
      "signal is aborted without reason",
      "SQLSTATE 57014",
    ]
    for (const msg of saturated) {
      expect(isSaturationError(msg), msg).toBe(true)
    }
  })

  it("does NOT match a genuine failure (real regressions must still surface)", () => {
    const real = [
      "zero sales in the last 30d for nba_top_shot",
      "fmv freshness breach: topshot_fmv_stale_hours = 14",
      "column \"foo\" does not exist",
      "permission denied for function analytics_smoke_run",
      "division by zero",
      "null value in column violates not-null constraint",
    ]
    for (const msg of real) {
      expect(isSaturationError(msg), msg).toBe(false)
    }
  })
})
