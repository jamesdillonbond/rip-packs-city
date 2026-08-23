#!/usr/bin/env node
// Detects ledger entries LOST between two versions of docs/overnight/ledger.md.
//
// WHY THIS EXISTS AS A DETECTOR RATHER THAN AN INLINE `comm`
//
// The CI guard used to compute the lost set as `comm -23 <before-headings>
// <after-headings>`: any heading present before and absent after was reported as
// the concurrent-session clobber (you wrote back a copy of the ledger read
// earlier in the session, destroying entries — and revert paths — committed in
// between). That is the right thing to catch, and the set comparison is there
// because a count check alone is blind to a remove-one/add-one swap (2966c0a,
// 2026-07-19, 356 -> 356 while destroying an entry holding revert paths for two
// live prod views).
//
// 🚨 But it also fired on the ONE repair the sibling guard demands.
// `find-future-dated-ledger-headings.mjs` fails a heading stamped in a day that
// has not happened in Pacific time. The fix is to correct the date IN THE
// HEADING — which removes one heading string and adds another, leaving the count
// identical and the set changed. Measured on 2026-08-22/23: `0fa5388b` failed the
// future-date arm, and `2d082db1`, the correction it demanded, failed the
// DISAPPEARED arm. **The guard punished compliance**, and the only escapes were
// mislabelling the commit `[ledger-roll]` (it is not an archival roll) or leaving
// main red.
//
// THE NARROW EXEMPTION, and why it does not weaken the clobber check:
// a heading that vanished is NOT reported when another heading in the after-file
// carries the SAME BODY — the text after the `### <date>` prefix. A re-date is
// then visible as what it is. A real clobber deletes entries whose bodies do not
// reappear anywhere, so it is still caught in full; so is a swap, and so is a
// heading whose WORDING changed (that is indistinguishable from a delete-plus-add
// from outside, and is deliberately still reported).
//
// Usage:
//   node scripts/find-clobbered-ledger-headings.mjs <before-file> <after-file>
//     → prints the COUNT of genuinely-lost headings (0 when clean)
//   node scripts/find-clobbered-ledger-headings.mjs --show <before> <after>
//     → prints the lost headings themselves, one per line
//
// ⚠ It prints a COUNT, never a list, unless --show is passed. Do not `| wc -l` it
// (the sibling awk detector carries the same warning for the same reason).

import { readFileSync } from "node:fs"

const HEADING = /^### .*/gm

// `### 2026-08-22 · SHIPPED — thing` → `· SHIPPED — thing`
// The date is the only part a re-date changes, so the body is what identifies
// the entry. A heading with no leading date keeps its whole text as its body.
export function headingBody(heading) {
  return heading.replace(/^###\s+\d{4}-\d{2}-\d{2}\s*/, "").trim()
}

export function headingsOf(src) {
  return (src.match(HEADING) || []).map((h) => h.trimEnd())
}

export function lostHeadings(beforeSrc, afterSrc) {
  const before = headingsOf(beforeSrc)
  const after = headingsOf(afterSrc)
  const afterSet = new Set(after)
  const afterBodies = new Set(after.map(headingBody))

  const lost = []
  for (const h of before) {
    if (afterSet.has(h)) continue // still present verbatim
    if (afterBodies.has(headingBody(h))) continue // re-dated in place, not lost
    lost.push(h)
  }
  return [...new Set(lost)]
}

const isMain = process.argv[1] && process.argv[1].endsWith("find-clobbered-ledger-headings.mjs")
if (isMain) {
  const args = process.argv.slice(2)
  const show = args.includes("--show")
  const [beforePath, afterPath] = args.filter((a) => a !== "--show")
  if (!beforePath || !afterPath) {
    console.error("usage: find-clobbered-ledger-headings.mjs [--show] <before-file> <after-file>")
    process.exit(2)
  }
  const lost = lostHeadings(readFileSync(beforePath, "utf8"), readFileSync(afterPath, "utf8"))
  if (show) lost.forEach((l) => console.log(l))
  else console.log(lost.length)
}
