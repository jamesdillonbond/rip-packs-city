#!/usr/bin/env node
// scripts/fix-inbox-index-counts.mjs
//
// WHY THIS EXISTS — three consecutive Cowork patch sets shipped INDEX.md counts
// that were already stale when they arrived (269→270, then 275→277 against a real
// 281/24, then a rebase artifact leaving 283 against 285). Every one of them was
// DERIVED correctly at authoring time. That is the point:
//
//   ⭐ Deriving a value does not make it live. A patch is a snapshot, so any
//     number in it that describes MUTABLE state is stale the moment upstream
//     moves. For a count-carrying file the deliverable must be the DERIVATION,
//     not the derived value — run at APPLY time, not at authoring time.
//
// So: add your entries, then run this. It recomputes exactly the two count
// assertions `__tests__/inbox-index-lists-every-filing.test.ts` makes, using the
// same rules, so the two cannot drift apart:
//
//   * the "# Inbox index — N live filings" header  <- files ON DISK (not entries)
//   * every "## YYYY-MM-DD — N filings" heading    <- `- [` lines in that section
//
// ⛔ WHAT IT DELIBERATELY DOES NOT DO: it never adds, removes or edits an ENTRY.
// The guard's other two assertions — every filing on disk is listed, and no entry
// points at a file that is gone — need a human, because writing an entry means
// reading the filing and saying what it found. A fixer that invented entries
// would be guessing titles, and an index of guessed titles is worse than a red
// guard. When those assertions would fail this exits NON-ZERO and says so, so a
// green run here can never be mistaken for a green guard.
//
// Usage:  node scripts/fix-inbox-index-counts.mjs [--check]
//   --check  report what it WOULD change and exit 1 if anything differs; write nothing.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs"
import path from "node:path"

const INBOX = path.join(process.cwd(), "docs/overnight/inbox")
const INDEX = path.join(INBOX, "INDEX.md")

export function filingsOnDisk(dir = INBOX) {
  return readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "INDEX.md").sort()
}

export function linkedFilings(src) {
  const out = []
  for (const m of src.matchAll(/\]\((\d{4}-\d{2}-\d{2}T[^)\s]+\.md)\)/g)) out.push(m[1])
  return out
}

/**
 * Pure: returns { text, changes[] }. `onDiskCount` is passed in rather than read
 * so this is testable without a filesystem — the same reason the Sentry quota
 * guard keeps its decision pure.
 */
export function fixCounts(src, onDiskCount) {
  const changes = []
  const lines = src.split("\n")

  // ── per-day headings ─────────────────────────────────────────────────────
  // Two passes: count first, then rewrite, so a heading is never rewritten from
  // a partially-counted section.
  const dayAt = new Map() // line index -> { date, claimed, seen }
  let cur = null
  const flush = () => { if (cur) dayAt.set(cur.i, cur) }
  lines.forEach((line, i) => {
    const head = line.match(/^## (\d{4}-\d{2}-\d{2}) — (\d+) filings?\b/)
    if (head) { flush(); cur = { i, date: head[1], claimed: Number(head[2]), seen: 0 }; return }
    if (line.startsWith("## ")) { flush(); cur = null; return }
    if (cur && /^- \[/.test(line)) cur.seen++
  })
  flush()

  for (const [i, d] of dayAt) {
    if (d.claimed === d.seen) continue
    const noun = d.seen === 1 ? "filing" : "filings"
    lines[i] = lines[i].replace(/— \d+ filings?\b/, `— ${d.seen} ${noun}`)
    changes.push(`## ${d.date}: ${d.claimed} -> ${d.seen}`)
  }

  // ── header total: compared by the guard against files ON DISK ────────────
  const hi = lines.findIndex((l) => /^# Inbox index — \d+ live filings/.test(l))
  if (hi === -1) throw new Error('INDEX.md must open with "# Inbox index — N live filings"')
  const claimedTotal = Number(lines[hi].match(/^# Inbox index — (\d+)/)[1])
  if (claimedTotal !== onDiskCount) {
    lines[hi] = lines[hi].replace(/^# Inbox index — \d+ live filings/, `# Inbox index — ${onDiskCount} live filings`)
    changes.push(`header: ${claimedTotal} -> ${onDiskCount} (files on disk)`)
  }

  return { text: lines.join("\n"), changes }
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))
if (isMain) {
  const check = process.argv.includes("--check")
  const src = readFileSync(INDEX, "utf8")
  const onDisk = filingsOnDisk()
  const linked = linkedFilings(src)

  const listed = new Set(linked)
  const missing = onDisk.filter((f) => !listed.has(f))
  const dangling = [...new Set(linked)].filter((f) => !existsSync(path.join(INBOX, f)))

  const { text, changes } = fixCounts(src, onDisk.length)

  if (changes.length === 0) console.log("inbox INDEX.md counts: already correct.")
  else {
    console.log(`inbox INDEX.md counts ${check ? "WOULD BE" : ""} corrected:`)
    for (const c of changes) console.log("  " + c)
    if (!check) writeFileSync(INDEX, text)
  }

  // The counts are the only thing this fixes; the entries are a human's job.
  if (missing.length || dangling.length) {
    console.error("\n⛔ COUNTS ALONE WILL NOT MAKE THE GUARD PASS — entries need a human:")
    if (missing.length) {
      console.error(`  ${missing.length} filing(s) on disk with no entry (add one, saying what the filing FOUND):`)
      for (const f of missing) console.error("    " + f)
    }
    if (dangling.length) {
      console.error(`  ${dangling.length} entr(y/ies) point at a file that is gone.`)
      console.error("    If it was ARCHIVED, DELETE the entry — this index maps the LIVE queue.")
      for (const f of dangling) console.error("    " + f)
    }
    console.error("\nRe-run this after fixing the entries; the counts re-derive from them.")
    process.exit(1)
  }

  if (check && changes.length) process.exit(1)
}
