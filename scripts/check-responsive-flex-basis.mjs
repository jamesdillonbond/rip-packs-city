#!/usr/bin/env node
//
// scripts/check-responsive-flex-basis.mjs
//
// ── What this closes ────────────────────────────────────────────────────────
// An inline `style={{ flex: "1 1 300px" }}` on a child of a container that a
// MEDIA QUERY flips to `flex-direction: column`.
//
// `flex-basis` sizes the MAIN axis. When the query flips that axis from width
// to height, a 300px width-basis silently becomes a 300px HEIGHT — and an
// inline style is precisely the one declaration a media query cannot override.
//
// Measured 2026-08-22 in Chromium: components/WalletSearchBand.tsx rendered
// **350px** tall at 390x844 (and at 320px) against the ~100px its own header
// comment specified, above the fold on every /[collection]/* and /insights/*
// page, for the anonymous mobile visitor that band exists for. Desktop was
// correct at every width, which is why it survived: 1440 / 1024 / 700 all
// measured 82px before and after the fix. Nothing else caught it — tsc, eslint,
// both coverage gates and every existing guard were green the whole time,
// because the defect is not expressible in the DOM, only in the layout.
//
// ── What it is structurally silent about (know this before trusting it) ─────
//   * The join is by CLASS NAME, not by resolved DOM ancestry. It says "this
//     file carries an inline length basis AND mentions a class whose direction
//     changes at a breakpoint" — strong evidence, not proof of parentage.
//   * A container whose direction is flipped by an inline style or by a JS
//     branch rather than by CSS is outside it, as is any child whose basis is
//     computed at runtime rather than written as a literal.
//
// Tailwind's responsive direction utilities (`flex-col sm:flex-row`) ARE covered
// — they were the guard's one documented hole, measured at population zero
// (11 files use such a utility, none of them carries an inline length basis), so
// closing it cost nothing and keeps that zero from drifting upward unnoticed.
//   * It only knows the media queries written in CSS text in this repo —
//     template literals and .css files. A Tailwind responsive direction utility
//     (`flex-col sm:flex-row`) is NOT parsed.
//   * It flags a co-occurrence, not a proven parent/child relationship, so a
//     hit is a thing to LOOK AT, not automatically a defect. Say so in the
//     output rather than calling every hit a bug.
//
// ⚠ Comments are stripped before matching. Six guards in this repo have fired
// on the comment documenting the very fix they were written for — and this one
// would have, because WalletSearchBand's header now spells the bad expression
// out in prose. Stripping is not cosmetic here; without it the guard is red on
// the fixed tree.
//
// ⚠ Two counts are asserted, not merely printed: files inspected, and files
// that carry a media-query flex-direction change at all. If the second is zero the CSS
// parser has broken and the guard is passing vacuously, which reads identical
// to "clean" at a glance. That is the failure mode this repo keeps recording.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const ROOTS = ["components", "app", "lib"]
const EXT = /\.(tsx|ts|css)$/

// An inline flex shorthand carrying a LENGTH basis. A unitless basis (flex: 1)
// and a keyword one (flex: "1 1 auto") are both safe under an axis flip.
const INLINE_LENGTH_BASIS = /flex:\s*["'`]\s*\d+\s+\d+\s+\d+(?:px|rem|em|%)\s*["'`]/g

// Tailwind says the same thing as a media query, in a class attribute:
// `flex-col sm:flex-row` is a breakpoint-conditional main axis. No CSS text to
// parse, so it needs its own signal.
const TAILWIND_RESPONSIVE_DIRECTION = /\b(?:sm|md|lg|xl|2xl):flex-(?:row|col)\b/
// Any RESPONSIVE direction change is the precondition, not just a flip TO
// column: a mobile-first container that is column by default and becomes row
// under a min-width query is column at exactly the narrow widths where the
// basis-becomes-height bug bites. Matching only `column` here would have been
// an allowlist masquerading as a rule.
const RESPONSIVE_DIRECTION = /flex-direction\s*:\s*(?:column|row)/

// ⚠ Brace-COUNTED, not regex-matched. The first cut of this guard closed each
// @media with /\n\s*\}/ and reported 3 files carrying a column flip when the
// true number is 32 — it stopped at the first nested rule's closing brace, so
// ~90% of the tree was outside the guard BY CONSTRUCTION while it printed
// "clean". Measure what a guard can actually see before trusting a zero.
function mediaBlocks(src) {
  const out = []
  let i = 0
  for (;;) {
    const at = src.indexOf("@media", i)
    if (at === -1) break
    const open = src.indexOf("{", at)
    if (open === -1) break
    let depth = 0
    let end = -1
    for (let j = open; j < src.length; j++) {
      const ch = src[j]
      if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) { end = j; break }
      }
    }
    if (end === -1) break
    out.push(src.slice(open + 1, end))
    i = end + 1
  }
  return out
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")      // block comments, incl. CSS ones
    .replace(/^[ \t]*\/\/.*$/gm, "")        // whole-line // comments
}

function walk(dir, out) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next") continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (EXT.test(p)) out.push(p)
  }
  return out
}

const files = ROOTS.flatMap((r) => walk(r, []))

// ── Pass 1: which CLASS NAMES change flex-direction inside a media query ────
// Keyed on the selector, not on the file. app/rpc-tokens.css is a GLOBAL sheet:
// the container it styles and the child carrying the inline basis are almost
// never in the same file, so a per-file join would have been blind to every
// component that uses a global class — the guard's own derivation fixing its
// blast radius, which is the failure this repo keeps recording.
const responsiveDirectionClasses = new Set()
let mediaBlocksSeen = 0

for (const file of files) {
  const src = stripComments(readFileSync(file, "utf8"))
  for (const block of mediaBlocks(src)) {
    mediaBlocksSeen++
    // Rules inside the block: `sel1, sel2 { decls }`
    for (const rule of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!RESPONSIVE_DIRECTION.test(rule[2])) continue
      for (const cls of rule[1].matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
        responsiveDirectionClasses.add(cls[1])
      }
    }
  }
}

// ── Pass 2: files that USE one of those classes AND carry an inline basis ───
const hits = []
for (const file of files) {
  const src = stripComments(readFileSync(file, "utf8"))
  const basisMatches = [...src.matchAll(INLINE_LENGTH_BASIS)]
  if (basisMatches.length === 0) continue

  const used = [...responsiveDirectionClasses].filter((c) =>
    new RegExp(`(?:^|[\\s"'\`.])${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[\\s"'\`])`).test(src),
  )
  const tw = TAILWIND_RESPONSIVE_DIRECTION.test(src)
  if (used.length === 0 && !tw) continue
  if (tw) used.push("(tailwind responsive flex-direction utility)")

  const lines = src.split("\n")
  for (const m of basisMatches) {
    const line = src.slice(0, m.index).split("\n").length
    hits.push({ file, line, text: (lines[line - 1] ?? "").trim().slice(0, 120), classes: used })
  }
}

console.log(
  `[responsive-flex-basis] inspected ${files.length} file(s); ${mediaBlocksSeen} media block(s); ` +
    `${responsiveDirectionClasses.size} class(es) change flex-direction responsively; ` +
    `${hits.length} co-occurrence(s)`
)

// Positive control on the guard's own reach — see the header. A zero here means
// the CSS parser stopped seeing media queries, not that the tree is clean.
if (files.length === 0 || mediaBlocksSeen === 0 || responsiveDirectionClasses.size === 0) {
  console.error(
    "[responsive-flex-basis] INSTRUMENT BROKEN: inspected " +
      `${files.length} file(s), parsed ${mediaBlocksSeen} media block(s), and resolved ` +
      `${responsiveDirectionClasses.size} responsively-directed class(es). With any of those at ` +
      "zero this guard cannot see what it is meant to check, and a pass means nothing."
  )
  process.exit(1)
}

if (hits.length > 0) {
  console.error(
    "\n[responsive-flex-basis] An inline flex shorthand with a LENGTH basis sits in a file\n" +
      "that changes a container's flex-direction at a breakpoint (CSS rule or Tailwind\n" +
      "responsive utility — the line below names which). flex-basis sizes\n" +
      "the MAIN axis, so under that flip the width-basis becomes a HEIGHT — and a media query\n" +
      "cannot override an inline style. Move the shorthand into the CSS block (see\n" +
      "components/WalletSearchBand.tsx's .rpc-wsb-input), or confirm the two are unrelated:\n"
  )
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}\n    ${h.text}\n    responsively-directed class(es) in this file: ${h.classes.join(", ")}`)
  }
  console.error(
    "\nThis is a co-occurrence check, not a proven parent/child link. If the container and the\n" +
      "child are genuinely unrelated, say so where the change lands rather than silencing this."
  )
  process.exit(1)
}

console.log("[responsive-flex-basis] clean")
