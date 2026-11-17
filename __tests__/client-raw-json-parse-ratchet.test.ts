import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// BAN on `fetch(url).then((r) => r.json())` — parsing a body without ever
// checking the status — in `"use client"` code.
//
// ── WHY THIS IS A DEFECT AND NOT A STYLE PREFERENCE ─────────────────────────
// Our API routes answer a failure with a well-formed JSON envelope, because
// `lib/api-error.ts` builds one: `{ error, code, retryable }`. That is a
// deliberate, good property — and it is exactly what makes this pattern
// dangerous. On a 503 the body PARSES FINE, so:
//
//   • the promise RESOLVES, and any `.catch(() => {})` never fires;
//   • the error object is written to state, cast to the success type;
//   • and — the part that got past every reviewer of these files — an error
//     object is TRUTHY, so a guard written as
//
//         value={summary ? formatUsd(summary.total_volume_usd) : "—"}
//
//     takes its DATA branch. `formatUsd(undefined)` returns "$0" and
//     `formatNumber(undefined)` returns "0", so /analytics/sales published
//     "$0 volume · 0 sales · 0 buyers" during an outage. The em-dash fallback
//     was written to prevent precisely that, and was UNREACHABLE.
//
// ⚠ Note the direction: hardening the SERVER to return a clean JSON error
// envelope made this CLIENT bug quieter, not louder. A route that once blew up
// the parse now returns something that looks like data. Two subsystems each
// correct on their own, wrong in combination.
//
// The remedy is `fetchJson` from lib/analytics/fetch-json.ts, whose own header
// already says it: "A 4xx/5xx often still carries a JSON body (an error
// envelope). Parsing and returning it would put driver text or an `{error}`
// object where the caller expects rows, so the status gates the parse."
//
// ── WHY A BAN NOW, WHEN THIS SHIPPED AS A RATCHET ───────────────────────────
// It was a ratchet at 17 for one day, because a ban then would have meant
// shipping a 5-entry allowlist — which this repo calls theatre. The population
// was driven 17 → 15 → 0 across two passes, and **driving it to zero is what
// removes the objection to a ban** (the same move recorded for the /insights
// unbounded-prerender class). There is no allowlist here and there must not be
// one: the correct response to a new offender is `fetchJson`, not an entry.
//
// ⚠ Writing `null` on failure is only HALF the fix. It restores the em-dash,
// but a reader still cannot tell "no data" from "we could not load it" — so
// every converted file also carries a visible failure state, pinned
// behaviourally by:
//   __tests__/component-analytics-dashboards-failed-vs-empty.test.tsx
//   __tests__/component-analytics-secondary-failed-vs-empty.test.tsx

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

/* Comments removed — line AND block — by the ONE shared stripper (imported
 * above). A guard must not read its own prose as evidence, and the converted
 * files quote the banned pattern to explain the fix; this header alone would
 * otherwise register as several offenders.
 *
 * ⚠ The local version this replaced stripped whole-line comments and THEN block
 * comments, so a TRAILING `// … /* …` still opened a block comment that ran to
 * the next close anywhere in the file. */

// ⚠ THE PARENTHESES ARE OPTIONAL, and they were NOT when this ban shipped.
// The first version required `(r) =>` and so was blind to `r => r.json()` —
// the identical defect written without parens. It reported a population of ZERO
// while `app/dashboard/notifications/page.tsx:70` carried exactly that shape,
// so the ban was announced as closed while one site stood outside it. Found by
// opening an unrelated file, not by the guard.
//
// A guard's own derivation decides what it can observe — this file already says
// that about the SERVER/CLIENT split, and it turned out to be true one level
// further down, about arrow-function syntax.
//
// The backreference is what makes this precise: it matches `.then((r) => r.json())`
// only when the parameter and the receiver are the SAME identifier, so a genuine
// `.then((res) => other.json())` is not swept up.
//
// ⚠ AND THE SAME LESSON APPLIED A THIRD TIME, 2026-08-24 — this pattern still
// knew only ARROW syntax. `.then(function (r) { return r.json() })` is the
// identical defect and was invisible to it, exactly as `r => r.json()` was
// before the parens were made optional.
//
// This is NOT hypothetical syntax in this repo: a whole family of client
// components is written `function (x) { return … }`, and the sibling ratchet
// `client-failure-collapses-to-empty-ratchet` was found the same day to be
// missing 26 sites for precisely this reason. ⓘ Measured here before changing
// anything: the function spelling of THIS pattern is currently at **zero**, so
// widening is purely preventive and cannot red the ban today. It is worth doing
// anyway, because a ban at zero is the shape where a blind spot is invisible —
// there is no population whose absence would look surprising.
const RAW_JSON_RX = new RegExp(
  [
    // .then((r) => r.json())   /   .then(r => r.json())
    String.raw`\.then\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\.json\(\)\s*\)`,
    // .then(function (r) { return r.json() })
    String.raw`\.then\(\s*function\s*\(\s*(\w+)\s*\)\s*\{\s*return\s+\2\.json\(\)\s*;?\s*\}\s*\)`,
  ].join("|"),
)

function clientFiles(): string[] {
  return [...walk(join(process.cwd(), "components")), ...walk(join(process.cwd(), "app"))].filter(
    (f) => /^["']use client["']/m.test(readFileSync(f, "utf8")),
  )
}

/**
 * ⚠ SCANS THE WHOLE FILE, NOT LINE BY LINE — changed 2026-08-24 together with
 * the function-expression alternation, because the two only work as a pair.
 *
 * A `.then(function (r) { return r.json() })` is routinely written wrapped:
 *
 *     .then(function (r) {
 *       return r.json()
 *     })
 *
 * A per-line test cannot match that no matter how good the pattern is, so
 * widening the regex while keeping the line loop would have closed the blind
 * spot only for authors who happen not to wrap — the half-fix that reads as a
 * full one. Line numbers are recovered from the match offset, so the reported
 * `file:line` is unchanged in shape.
 */
function offenders(): string[] {
  const hits: string[] = []
  for (const f of clientFiles()) {
    const rel = f.slice(process.cwd().length + 1).replace(/\\/g, "/")
    const src = stripComments(readFileSync(f, "utf8"))
    const rx = new RegExp(RAW_JSON_RX.source, "g")
    let m: RegExpExecArray | null
    while ((m = rx.exec(src)) !== null) {
      hits.push(`${rel}:${src.slice(0, m.index).split("\n").length}`)
    }
  }
  return hits
}

describe("client code never parses a response body without checking the status", () => {
  it("has ZERO unchecked parses — no allowlist", () => {
    const hits = offenders()
    expect(
      hits,
      "A client file parses a response body without checking the status.\n" +
        "Use fetchJson() from lib/analytics/fetch-json.ts — it gates the parse on\n" +
        'the status, so a 5xx error envelope cannot reach state and then satisfy a\n' +
        'truthy `x ? … : "—"` guard.\n\n' +
        "Do NOT add an allowlist entry here; convert the file.\n\n" +
        hits.join("\n"),
    ).toEqual([])
  })

  it("is not vacuous — the matcher still detects the pattern", () => {
    // Guards the guard, and it has to be done with SAMPLES rather than a known
    // offender: the population is zero, so the anchor-based check this file used
    // while it was a ratchet is no longer possible. Without this, a broken
    // walk() or regex would leave the ban passing forever over nothing.
    expect(RAW_JSON_RX.test("fetch(url).then((r) => r.json())")).toBe(true)
    expect(RAW_JSON_RX.test("  .then((res) => res.json())")).toBe(true)
    // The form the shipped ban missed.
    expect(RAW_JSON_RX.test(".then(r => r.json())")).toBe(true)
    // ⚠ The FUNCTION-EXPRESSION form, added 2026-08-24. A specimen that only
    // ever feeds a detector the spelling its author had in mind shares the
    // detector's blind spot and proves nothing — which is exactly how the
    // sibling collapse ratchet stayed green while missing 26 sites.
    expect(RAW_JSON_RX.test(".then(function (r) { return r.json() })")).toBe(true)
    expect(RAW_JSON_RX.test(".then(function(res) { return res.json(); })")).toBe(true)
    // ...and it must not fire on the correct shapes.
    expect(RAW_JSON_RX.test("fetchJson<T>(url)")).toBe(false)
    expect(RAW_JSON_RX.test(".then((r) => (r.ok ? r.json() : null))")).toBe(false)
    // A different receiver is somebody else's json(), not an unchecked parse.
    expect(RAW_JSON_RX.test(".then((res) => other.json())")).toBe(false)
    // ...and the backreference must hold for the function spelling too, or the
    // new alternation is looser than the one it mirrors.
    expect(RAW_JSON_RX.test(".then(function (res) { return other.json() })")).toBe(false)
    expect(RAW_JSON_RX.test(".then(function (r) { return r.ok ? r.json() : null })")).toBe(false)
  })

  it("the scan is not line-bound — a WRAPPED offender is still found", () => {
    // ⚠ The pair that makes the widening real. Feeding the regex a one-line
    // specimen proves the pattern; this proves the WALK can deliver a wrapped
    // one to it. Without this, `offenders()` could quietly go back to a
    // per-line loop and every specimen above would still pass.
    const wrapped = ['.then(function (r) {', "  return r.json()", "})"].join("\n")
    expect(new RegExp(RAW_JSON_RX.source, "g").test(wrapped)).toBe(true)
    // ...and the same text is NOT matchable line-by-line, which is the point.
    expect(wrapped.split("\n").some((l) => RAW_JSON_RX.test(l))).toBe(false)
  })

  it("actually walks a non-trivial number of client files", () => {
    // The other half of not-vacuous: offenders() returning [] must mean "none
    // found", not "nothing scanned".
    expect(clientFiles().length).toBeGreaterThan(50)
  })
})
