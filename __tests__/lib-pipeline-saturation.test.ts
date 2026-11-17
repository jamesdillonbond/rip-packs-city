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

  // ── Gateway / transport failures (2026-09-18, register #122) ──────────────
  //
  // A read that never reached Postgres is the same blindness as one Postgres
  // cancelled: it cannot prove a threshold was breached, so it must warn rather
  // than page. The Supabase outage answered at the Cloudflare edge with a 522
  // page, so callers got an HTML DOCUMENT where JSON belongs — and this
  // classifier, which already knew "connection terminated", did not know that.
  //
  // ⚠ "connection timed out" is NOT "connection terminated". The original list
  // matched only the latter, which is exactly how the 522 slipped through.
  it("matches a gateway/transport failure that never reached Postgres", () => {
    const transport = [
      "pack_table_rows read failed: <!DOCTYPE html><title>supabase.co | 522: Connection timed out</title>",
      "<!doctype html> 523: origin is unreachable",
      "cloudflare 524: a timeout occurred",
    ]
    for (const msg of transport) {
      expect(isSaturationError(msg), msg).toBe(true)
    }
  })

  // THE CONTROL that keeps the widening honest. A false positive here swallows a
  // real regression into a warn, which is the worse direction — so the tokens are
  // narrow and these near-misses must still surface.
  it("CONTROL — near-miss wording is NOT swallowed by the new tokens", () => {
    const real = [
      "this edition sold 522 times",          // 522 without the colon
      "no connection between these two editions",
      "the request hit a timeout building the board",
      "html parsing is not enabled for this feed",
      // ⛔ These are REAL outages of our own dependencies and MUST still page.
      // api-sentinel-branches uses ECONNREFUSED as its 'hard error' arm for
      // exactly this reason, and it caught a first cut that swallowed them.
      "connect ECONNREFUSED 10.0.0.1:5432",
      "read ECONNRESET",
      "socket hang up",
      "connect ETIMEDOUT",
    ]
    for (const msg of real) {
      expect(isSaturationError(msg), msg).toBe(false)
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
