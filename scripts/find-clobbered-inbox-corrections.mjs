#!/usr/bin/env node
// Detects a CORRECTION block lost from an inbox filing between two versions.
//
// ── THE INCIDENT (2026-09-03) ───────────────────────────────────────────────
// Two sessions edited the same inbox filing twenty minutes apart. The second
// rewrote it in place from a copy read before the first landed, silently
// deleting an 84-line `## ⛔ CORRECTION` block — the block refuting the filing's
// headline measurement. A human reading the diff caught it; CI could not.
//
// 🚨 ALL THREE EXISTING INBOX GUARDS PASSED, and none could have failed:
// `inbox-index-lists-every-filing`, `fix-inbox-index-counts` and
// `inbox-is-append-only-since-the-rule` are about FILES and COUNTS — which
// filings exist and how many. A rewrite that keeps the file keeps the count.
//
// ── ⭐ TWO EARLIER DESIGNS FAILED ON THE REAL DATA. BOTH FAILURES ARE THIS
// ── REPO'S OWN DOCUMENTED LESSONS, REAPPEARING IN THE GUARD ABOUT THEM.
//
// **v1 — "every `## ` heading present before must be present after."** Correctly
// flagged the incident; then FALSE-POSITIVED on the REPAIR, because the
// repairing session legitimately renamed two sections while merging ("The
// discriminator, in one line" → "The discriminator — ⛔ CORRECTED TWICE…").
// Free-form prose gets restructured, and a guard that reds main for it is one
// people learn to disable — the ledger's detector needed a narrow exemption for
// exactly this ("the guard punished compliance", 2026-08-22/23).
//
// **v2 — "the after-file must still contain SOME correction heading."** Missed
// the incident entirely: the clobbering commit added its OWN correction
// (`## The discriminator — ⛔ CORRECTED 23:50Z…`) while deleting mine, so the
// count went 1 → 1. ⛔ **That is "diff the SET, not the count" (2966c0a,
// 356 → 356) reproduced inside the guard written to catch it.**
//
// ── WHAT IT CHECKS NOW ──────────────────────────────────────────────────────
// Identity by CONTENT, not by heading. For each `## ` section in the before-file
// whose heading says "correction", take its longest substantive body lines and
// require that at least one still appears anywhere in the after-file.
//
// That is robust to the things that legitimately happen — the heading is
// reworded, the block is moved, surrounding sections are restructured — and
// fails on the thing that must not: the text is gone.
//
// ⚠ Corrections only, deliberately. They are the highest-value, lowest-churn
// content in a filing (they exist because someone acted on a wrong number), and
// "the correction disappeared" has no legitimate cause. Everything else stays
// free to be rewritten.
//
// Usage:
//   node scripts/find-clobbered-inbox-corrections.mjs <before> <after>
//     → prints the COUNT of lost correction sections (0 when clean)
//   node scripts/find-clobbered-inbox-corrections.mjs --show <before> <after>
//     → prints the lost headings themselves, one per line
//
// ⚠ Prints a COUNT, never a list, unless --show is passed. Do not `| wc -l` it:
// a clean run prints "0", and `wc -l` on that is 1.

import { readFileSync } from "node:fs"

const IS_CORRECTION = /\bcorrect(ion|ed)\b/i

/** Normalise for comparison: collapse whitespace, drop emphasis. */
const norm = (s) => s.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().toLowerCase()

/** Split a document into { heading, body } sections on `## `. */
function sections(text) {
  const out = []
  const lines = text.split("\n")
  let cur = null
  for (const line of lines) {
    if (/^## /.test(line)) {
      if (cur) out.push(cur)
      cur = { heading: line, body: [] }
    } else if (cur) {
      cur.body.push(line)
    }
  }
  if (cur) out.push(cur)
  return out
}

/**
 * The lines worth fingerprinting a section by: long enough to be distinctive,
 * and not table rows or rules, which repeat across documents.
 */
function fingerprints(body) {
  return body
    .filter((l) => {
      const t = l.trim()
      return t.length >= 45 && !t.startsWith("|") && !t.startsWith("---")
    })
    .map(norm)
    .sort((a, b) => b.length - a.length)
    .slice(0, 5)
}

const args = process.argv.slice(2)
const show = args[0] === "--show"
const [beforePath, afterPath] = show ? args.slice(1) : args

const read = (p) => {
  try {
    return readFileSync(p, "utf8")
  } catch {
    return ""
  }
}

const afterNorm = norm(read(afterPath))
const lost = []
for (const s of sections(read(beforePath))) {
  if (!IS_CORRECTION.test(s.heading)) continue
  const fps = fingerprints(s.body)
  // A correction with no substantive body cannot be fingerprinted; treat it as
  // present rather than inventing a failure from a measurement we cannot make.
  if (fps.length === 0) continue
  if (!fps.some((f) => afterNorm.includes(f))) lost.push(s.heading)
}

if (show) {
  for (const h of lost) console.log(h)
} else {
  console.log(String(lost.length))
}
