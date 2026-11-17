// A DIRECTORY-DRIVEN sweep for "a failed read renders as an answer" on server
// pages — the companion to server-pages-error-vs-absent-guard.test.ts.
//
// ── WHY A SWEEP, WHEN A GUARD ALREADY EXISTED ──────────────────────────────
// The existing guard is a hand-written list of FOUR pages. On 2026-08-15 a sweep
// of all 118 server pages found TWO live instances it could not see, and the
// reason the second one survived is the transferable part:
//
//   • ITS CASE WAS NAMED FOR A DIFFERENT PAGE. That guard's case is titled
//     "analytics/wallets does not report a failed read as 'no activity'" and
//     reads `app/(analytics)/analytics/wallets/page.tsx` — the DIRECTORY INDEX.
//     The DETAIL page one segment down, `wallets/[address]/page.tsx`, was never
//     in it, and it carried the defect in three separate loaders.
//     lib/analytics/sets/detail-fetchers.ts even cites "/analytics/wallets" as
//     already-pinned, which reads as covering the detail page and does not.
//     Two pages sharing a path prefix is all it took.
//
//   • THE OTHER, app/pinnacle/moment/[id]/page.tsx, is the shareable Pinnacle
//     pin URL — the same surface class as /moment/[id], which DID get this fix.
//     None of its reads destructured `error` at all, so a statement timeout fell
//     through `if (!ed)` into `notFound()`.
//
// This file therefore keeps NO page list. It walks `app/`, selects the server
// pages that can 404, and bans the two source signatures that produce the defect.
// Adding a page cannot escape it.
//
// ⚠ THIS IS A BAN WITH NO ALLOWLIST, NOT A RATCHET. The usual reason to prefer a
// ratchet is to avoid shipping a large allowlist as theatre — but the population
// was driven to ZERO in the pass that added this (the two instances above were
// fixed in the same commit), so there is nothing to grandfather. It follows
// __tests__/insights-server-pages-bound-their-reads.test.ts, which made the same
// call for the same reason.
//
// ── WHAT "CORRECT" LOOKS LIKE, AND WHY THERE ARE TWO RIGHT ANSWERS ─────────
// Both of these pass, and the choice between them is a real product decision:
//
//   1. THROW. The entity pages (player/set/team/[slug]) throw on an RPC error so
//      a transient failure renders a RETRYABLE ERROR BOUNDARY rather than a
//      soft-404. This is deep-audit D10's deliberate choice — do not "fix" those
//      pages by making them fail soft.
//   2. RETURN A DISCRIMINATED SHAPE. `{ data, ok }` (lib/analytics/sets, lib/
//      analytics/wallets, lib/moment-detail) lets the caller render an explicit
//      "didn't load" card, which is right on the most-shared URLs where an error
//      boundary is a worse experience than a card that says reload.
//
// What is NEVER correct is a bare `null` for both outcomes, because the caller
// cannot then tell them apart — and every caller of such a loader answers 404.

import { describe, it, expect } from "vitest"
import { readdirSync, statSync, readFileSync } from "fs"
import path from "path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const ROOT = path.resolve(__dirname, "..")
const APP_DIR = path.join(ROOT, "app")

/** Opt-out marker for a read whose error is deliberately dropped because the
 *  read is DECORATION — it cannot make the page assert anything false, only
 *  render less. Mirrors the `definer-view: intentional` convention in
 *  __tests__/migration-view-security-invoker-guard.test.ts: silence is not a
 *  decision, but an explicit reason is. */
const DEGRADES_MARKER = "degrades-on-error: intentional"

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry === "page.tsx" || entry === "layout.tsx") out.push(full)
  }
  return out
}

/** Strip line and block comments, PRESERVING line numbers.
 *
 * ⚠ REQUIRED, not tidiness. This repo has paid for it four times: a guard that
 * greps source for a pattern trips on the comment that documents the fix, and
 * every file this sweep touches now carries a comment quoting the banned shape
 * verbatim (including the doc block at the top of THIS file).
 *
 * ⚠ The newline preservation is load-bearing, not cosmetic. The decoration
 * opt-out marker lives in a COMMENT, so it is only visible in the raw source —
 * but the offending read is only visible in the stripped source. A naive strip
 * deletes comment lines, the two line numberings drift apart, and the marker
 * lookup silently misses (caught here by the marker failing to suppress its own
 * read). Replacing each comment with its own newlines keeps the two in step. */
/*
 * ⚠ MIGRATED 2026-08-22 to the ONE shared stripper (scripts/lib/strip-comments.mjs).
 * The local copy stripped BLOCK comments before LINE comments, so an ordinary
 * line comment mentioning a glob path opened a block comment running to the next
 * close-comment anywhere in the file, blanking real source this guard then
 * reported as clean (103,590 chars across 49 product files). The shared version
 * blanks rather than deletes, so offsets and line numbers survive.
 * Do not re-inline a local copy.
 */

interface Finding {
  file: string
  line: number
  kind: string
}

/** A loader that answers `null` for a FAILED read. Both spellings, and both
 *  require the absence of `throw` — throwing is a legitimate treatment (see the
 *  header), so a branch that throws is not a finding. */
function nullOnFailure(src: string): { kind: string; at: number }[] {
  const out: { kind: string; at: number }[] = []
  for (const m of src.matchAll(/if \(\s*\w*[Ee]rror\s*\)\s*\{([\s\S]{0,400}?)\}/g)) {
    const body = m[1]
    if (/return null/.test(body) && !/throw/.test(body)) {
      out.push({ kind: "if (error) { … return null }", at: m.index ?? 0 })
    }
  }
  for (const m of src.matchAll(/catch\s*(?:\([^)]*\))?\s*\{([\s\S]{0,400}?)\n\s*\}/g)) {
    const body = m[1]
    if (/return null/.test(body) && !/throw/.test(body)) {
      out.push({ kind: "catch { … return null }", at: m.index ?? 0 })
    }
  }
  return out
}

/** A supabase read that never destructures `error` at all.
 *
 * ⚠ This is the spelling a grep for `if (error)` structurally cannot find, and
 * it is what app/pinnacle/moment/[id]/page.tsx actually did. supabase-js RETURNS
 * errors rather than throwing, so omitting `error` from the destructure leaves
 * `data` undefined on failure — byte-identical to a genuinely empty result. */
function readDropsError(src: string): { kind: string; at: number }[] {
  const out: { kind: string; at: number }[] = []
  for (const m of src.matchAll(
    /const \{\s*data(?:\s*:\s*\w+)?\s*\}\s*=\s*await\s+\w+[\s\S]{0,200}?\.(?:from|rpc)\(/g
  )) {
    out.push({ kind: "read drops `error` from the destructure", at: m.index ?? 0 })
  }
  return out
}

describe("server pages: a failed read must not render as an answer (directory sweep)", () => {
  const files = walk(APP_DIR)

  // Server pages that can 404 — the population where this defect has teeth,
  // because a 404 is the strongest possible false claim about existence.
  const candidates = files.filter((f) => {
    const raw = readFileSync(f, "utf8")
    if (raw.trimStart().startsWith('"use client"')) return false
    return stripComments(raw).includes("notFound()")
  })

  it("finds a real population to check (guards the guard)", () => {
    // If a refactor moved every 404 out of app/, this sweep would pass while
    // checking nothing. 8 is comfortably below the 11 measured on 2026-08-15.
    expect(candidates.length).toBeGreaterThanOrEqual(8)
  })

  it("no server page that can 404 collapses a failed read into `null`", () => {
    const findings: Finding[] = []
    for (const f of candidates) {
      const raw = readFileSync(f, "utf8")
      const src = stripComments(raw)
      const rel = path.relative(ROOT, f)
      const lineOf = (at: number) => src.slice(0, at).split("\n").length

      for (const hit of nullOnFailure(src)) {
        findings.push({ file: rel, line: lineOf(hit.at), kind: hit.kind })
      }
      for (const hit of readDropsError(src)) {
        // A DECORATION read may drop its error, but must say so. The marker is
        // looked up in the RAW source (it lives in a comment).
        const lineNo = lineOf(hit.at)
        const window = raw.split("\n").slice(Math.max(0, lineNo - 8), lineNo + 1).join("\n")
        if (window.includes(DEGRADES_MARKER)) continue
        findings.push({ file: rel, line: lineNo, kind: hit.kind })
      }
    }

    expect(
      findings,
      findings.length
        ? "A failed read must be distinguishable from an absent row. Either THROW " +
          "(retryable error boundary) or return a discriminated `{ data, ok }` — see " +
          "lib/analytics/wallets/detail-fetchers.ts. If the read is pure decoration " +
          `and cannot make the page assert anything false, mark it "${DEGRADES_MARKER}" ` +
          "with a reason.\n" +
          findings.map((f) => `  ${f.file}:${f.line} — ${f.kind}`).join("\n")
        : undefined
    ).toEqual([])
  })

  it("the two pages fixed on 2026-08-15 carry the distinction they were missing", () => {
    // Behavioural backstop for the sweep: the sweep proves the BAD shape is
    // absent, these prove the GOOD shape is present. A page could satisfy the
    // sweep by deleting its error handling entirely.
    const wallets = readFileSync(
      path.join(ROOT, "lib", "analytics", "wallets", "detail-fetchers.ts"),
      "utf8"
    )
    expect(wallets, "the wallet loader must return a discriminated shape").toContain("ok: false")
    expect(
      wallets,
      "a malformed address is an ANSWER, not a failure — it must stay ok:true"
    ).toMatch(/FLOW_ADDR_RE\.test\(addr\)\) return \{ data: null, ok: true \}/)

    const pin = stripComments(
      readFileSync(path.join(ROOT, "app", "pinnacle", "moment", "[id]", "page.tsx"), "utf8")
    )
    expect(pin, "the pin page must branch on the read's own verdict").toContain("if (!ok)")
    expect(
      pin,
      "a failed pin read must render the unavailable card, never notFound()"
    ).toContain("PinUnavailableCard")
  })

  it("a failed read must not de-index a real page", () => {
    // The metadata half. A page that renders an honest 'didn't load' body while
    // still emitting indexable metadata lets a transient blip cost the page its
    // ranking — the fix has to cover both halves.
    for (const rel of [
      ["app", "(analytics)", "analytics", "wallets", "[address]", "page.tsx"],
      ["app", "pinnacle", "moment", "[id]", "page.tsx"],
      ["app", "moment", "[id]", "page.tsx"],
    ]) {
      const src = stripComments(readFileSync(path.join(ROOT, ...rel), "utf8"))
      expect(
        src.replace(/\s+/g, " "),
        `${rel.join("/")} must noindex the failed-read branch`
      ).toMatch(/robots: \{ index: false, follow: true \}/)
    }
  })
})
