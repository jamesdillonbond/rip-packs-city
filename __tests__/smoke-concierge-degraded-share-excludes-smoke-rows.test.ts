import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// ─────────────────────────────────────────────────────────────────────────────
// The "concierge answers rather than degrading" smoke check MUST exclude
// smoke-test rows, or it measures its own sibling's fixture and pages forever.
//
// ⚠ WHAT HAPPENED (2026-08-16, Sentry JAVASCRIPT-NEXTJS-2E, 27 users, escalating).
// The check reads `support_conversations` over a 6 h window and fails when the
// share of DEGRADED conversations crosses 50%. Its own comment says it measures
// "what share of REAL conversations got a degraded fallback rather than an
// answer". It did not: it had no `is_smoke_test` filter.
//
// Meanwhile the sibling check `support-chat graceful-degradation (synthetic
// Anthropic 4xx)` POSTs `x-rpc-test-error-mode: credit_balance` to
// /api/support-chat on EVERY smoke tick, deliberately, to prove the degradation
// path works — writing a `support_conversations` row with category
// `concierge_unavailable` and `is_smoke_test = true`. That is a good test doing
// exactly its job, and it is manufactured evidence for this one.
//
// Measured live at the time: of 905 conversations since 2026-08-02, **902 were
// smoke tests and 3 were real**, and ALL 863 degraded rows were smoke rows.
// Real degraded conversations: ZERO. The only 3 real conversations in ten days
// all SUCCEEDED. So the check reported a total concierge outage that was not
// happening — and, with one synthetic degraded row guaranteed per tick against
// ~0 real traffic, it could never have gone green on its own.
//
// This is the guard-scope class the repo keeps paying for, in its sharpest form:
// a monitor whose input set includes the output of another monitor.
//
// ⚠ WHY THIS GUARD STRIPS COMMENTS FIRST — and it is not tidiness. The fix
// carries a long comment block that names `is_smoke_test` several times to
// explain itself. A guard that greps the raw source for that identifier passes
// on the COMMENT ALONE, so deleting the actual filter would leave it green. The
// repo has shipped that exact bug at least six times; the fourth mutation below
// pins the stripping itself.
// ─────────────────────────────────────────────────────────────────────────────

const ROUTE = join(process.cwd(), "app", "api", "smoke-test", "route.ts")

/** Replace comment bodies with blanks, preserving offsets so slicing still lines up. */
/*
 * ⚠ MIGRATED 2026-08-22 to the ONE shared stripper (scripts/lib/strip-comments.mjs).
 * The local copy here stripped BLOCK comments before LINE comments, so an
 * ordinary line comment mentioning a glob path opened a block comment that ran
 * to the next close-comment anywhere in the file, blanking real source this
 * guard then reported as clean (103,590 chars across 49 product files).
 * Do not re-inline a local copy.
 */

/**
 * The degraded-share check's query block: from its `support_conversations` read
 * to the end of that statement. Returns CODE ONLY (comments blanked).
 */
function degradedShareQuery(src: string): string {
  const code = stripComments(src)
  // The check is identified by its window/threshold constants, which sit a few
  // lines above the query and are code, not prose.
  const anchor = code.indexOf("FAIL_AT_SHARE")
  expect(anchor, "could not locate the degraded-share check (FAIL_AT_SHARE)").toBeGreaterThan(-1)
  const from = code.indexOf('.from("support_conversations")', anchor)
  expect(from, "degraded-share check no longer reads support_conversations").toBeGreaterThan(-1)
  // Statement ends at the first semicolon after the builder chain.
  const end = code.indexOf(";", from)
  return code.slice(from, end)
}

describe("concierge degraded-share smoke check excludes smoke-test rows", () => {
  const src = readFileSync(ROUTE, "utf8")

  it("filters out is_smoke_test rows in the query itself", () => {
    const q = degradedShareQuery(src)
    // `not(... "is", true)` rather than `.eq(false)`: legacy rows may be NULL,
    // and a NULL is not a smoke test. Either spelling of the null-safe form is
    // accepted; a bare `.eq("is_smoke_test", false)` is NOT, because it silently
    // drops every legacy NULL row and shrinks the sample it is judging.
    expect(
      /\.not\(\s*["']is_smoke_test["']\s*,\s*["']is["']\s*,\s*true\s*\)/.test(q),
      `degraded-share query must exclude smoke rows null-safely. Got:\n${q}`,
    ).toBe(true)
  })

  it("still scopes to the 6h window and drops beta_feedback", () => {
    const q = degradedShareQuery(src)
    expect(q).toContain("created_at")
    expect(q).toContain("beta_feedback")
  })

  it("GUARDS THE GUARD: a comment mentioning is_smoke_test does not satisfy it", () => {
    // Delete the real filter but leave the explanatory comments untouched — the
    // exact regression this guard exists for. A version without stripComments
    // passes this, which is why the stripping is load-bearing rather than tidy.
    const mutated = src.replace(/\.not\(\s*["']is_smoke_test["']\s*,\s*["']is["']\s*,\s*true\s*\)\s*\n?/, "")
    expect(mutated, "mutation did not apply — the filter's spelling changed").not.toBe(src)
    expect(mutated).toContain("is_smoke_test") // still present, in prose only
    expect(() => {
      const q = degradedShareQuery(mutated)
      expect(
        /\.not\(\s*["']is_smoke_test["']\s*,\s*["']is["']\s*,\s*true\s*\)/.test(q),
      ).toBe(true)
    }).toThrow()
  })

  it("the sibling that MANUFACTURES the degraded rows still exists and is still deliberate", () => {
    // If this ever stops being true, the reasoning above is stale and this guard
    // should be re-derived rather than trusted: the reason smoke rows must be
    // excluded is that we generate a degraded one on purpose every tick.
    const code = stripComments(src)
    expect(code).toContain("x-rpc-test-error-mode")
    expect(code).toContain("credit_balance")
  })
})
