#!/usr/bin/env node
// scripts/resolve-ledger-rebase-conflict.mjs
//
// Resolve a rebase conflict in an append-at-top doc (docs/overnight/ledger.md by
// default) by RE-SPLICING the entries this branch adds into UPSTREAM'S copy,
// rather than hand-editing conflict markers.
//
// ── WHY THIS EXISTS AS AN EXECUTABLE AND NOT A PARAGRAPH ───────────────────
// The recipe has been written down for months and the SAME three traps keep
// drawing blood, because each session retypes the check from memory:
//
//   1. Splice at a LINE-START `^### `, never a substring match on `### `.
//      A substring splice buries the heading mid-sentence — five occurrences.
//   2. ANCHOR the conflict-marker check to line start. Git writes markers at
//      column 0; this ledger QUOTES markers in prose (it documents this very
//      incident), so an unanchored `includes("<<<<<<<")` fires on a CORRECT
//      resolution. That false positive is now at SEVEN recorded instances,
//      including one caused by the paragraph warning about it.
//   3. GATE `git add` on the resolver's exit code. A resolver that prints a
//      failure and still leaves a staged file is worse than no resolver.
//
// This script does all three, refuses to write anything unless every check
// passes, and exits non-zero so `&&` chaining is safe:
//
//   node scripts/resolve-ledger-rebase-conflict.mjs && git add docs/overnight/ledger.md
//   GIT_EDITOR=true git rebase --continue
//
// ── HOW IT PICKS WHAT TO RE-SPLICE ─────────────────────────────────────────
// During a rebase, `:2:` is the copy being rebased ONTO (upstream) and `:3:` is
// the commit being replayed (yours). Upstream is authoritative for everything
// it already has, so the only thing to carry across is the run of headings at
// the TOP of `:3:` that upstream does not have yet. Those are re-spliced above
// upstream's newest heading, preserving their order.
//
// ⚠ It deliberately does NOT try to merge edits to pre-existing entries. This
// file is append-at-top by convention; if you edited an older entry as well,
// this script will tell you the heading count did not move by the expected
// amount and refuse, which is the correct outcome — finish that part by hand.

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

const FILE = process.argv[2] ?? "docs/overnight/ledger.md"
const HEADING = /^### /
/** Git writes markers at column 0. Anchored, per trap 2. */
const REAL_MARKER = /^(<<<<<<< |=======$|>>>>>>> )/m

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function stage(n) {
  try {
    return execFileSync("git", ["show", `:${n}:${FILE}`], { encoding: "utf8", maxBuffer: 1 << 28 })
  } catch {
    fail(
      `could not read stage :${n}: for ${FILE}. Is a rebase actually in progress ` +
        `with this file conflicted? (git diff --name-only --diff-filter=U)`,
    )
  }
}

const upstream = stage(2) // ours during a rebase = the branch being rebased ONTO
const mine = stage(3) // theirs during a rebase = the commit being replayed

const headingsOf = (s) => (s.match(/^### .*$/gm) ?? [])
const upHeads = headingsOf(upstream)
const myHeads = headingsOf(mine)
if (upHeads.length === 0) fail(`no ^### headings in upstream copy of ${FILE} — wrong file?`)

// The run of headings at the top of MINE that upstream does not have.
const upSet = new Set(upHeads)
const novel = []
for (const h of myHeads) {
  if (upSet.has(h)) break
  novel.push(h)
}
if (novel.length === 0) {
  fail(
    "nothing to re-splice: every heading at the top of your copy already exists upstream. " +
      "If your change edited an EXISTING entry rather than adding one, resolve that by hand.",
  )
}

// Slice those entries out of MINE: from its first ^### up to the first heading
// that upstream already has.
const myLines = mine.split(/\r?\n/)
const start = myLines.findIndex((l) => HEADING.test(l))
let end = myLines.length
let seen = 0
for (let i = start; i < myLines.length; i++) {
  if (HEADING.test(myLines[i])) {
    if (seen === novel.length) {
      end = i
      break
    }
    seen++
  }
}
const block = myLines.slice(start, end).join("\n")

// Splice above upstream's newest entry, at a LINE-START anchor (trap 1).
const upLines = upstream.split(/\r?\n/)
const anchor = upLines.findIndex((l) => HEADING.test(l))
if (anchor < 0) fail("no line-start ^### anchor in upstream copy")

const merged = upLines.slice(0, anchor).join("\n") + "\n" + block + "\n" + upLines.slice(anchor).join("\n")

if (REAL_MARKER.test(merged)) fail("real conflict markers survive the splice — refusing to write")

const before = upHeads.length
const after = headingsOf(merged).length
if (after - before !== novel.length) {
  fail(`heading count moved ${before} -> ${after} (delta ${after - before}), expected +${novel.length}`)
}

// ── The blank-line check, and it MUST be a delta ───────────────────────────
// A conflict resolution can butt `### ` directly against the previous line,
// where every other entry has a blank line before it. But an ABSOLUTE check
// ("every heading is preceded by a blank line") fires on a perfectly correct
// resolution, because many headings already lack one: **80 measured 2026-09-01**
// (ledger-discipline.md records 303 on 2026-08-16 — a dated sample that has since
// moved, which is exactly why this is computed at run time and not hard-coded).
// So assert only that this splice introduced no NEW instance — the same
// baseline-relative discipline as the heading count. A ledger check whose
// baseline you have not measured is a check you do not know the meaning of.
const headingsWithoutBlankBefore = (s) => {
  const L = s.split(/\r?\n/)
  let n = 0
  for (let i = 0; i < L.length; i++) {
    if (!HEADING.test(L[i])) continue
    if (i > 0 && L[i - 1].trim() !== "") n++
  }
  return n
}
const nbBefore = headingsWithoutBlankBefore(upstream)
const nbAfter = headingsWithoutBlankBefore(merged)
if (nbAfter > nbBefore) {
  fail(
    `this splice introduced ${nbAfter - nbBefore} heading(s) with no blank line before them ` +
      `(${nbBefore} -> ${nbAfter}). Add the blank line and re-run.`,
  )
}

writeFileSync(FILE, merged)
console.log(`✓ re-spliced ${novel.length} entr${novel.length === 1 ? "y" : "ies"} into upstream's ${FILE}`)
console.log(`  headings ${before} -> ${after}  ·  anchor line ${anchor + 1}`)
for (const h of novel) console.log(`  + ${h.slice(0, 88)}`)
console.log(`\nNow, gating on this script's exit code (trap 3):`)
console.log(`  git add ${FILE} && GIT_EDITOR=true git rebase --continue`)
console.log(`Then re-run the ledger guards:`)
console.log(`  awk -f scripts/find-swallowed-ledger-headings.awk ${FILE}   # must print 3`)
console.log(`  node scripts/find-future-dated-ledger-headings.mjs          # must print 0`)
