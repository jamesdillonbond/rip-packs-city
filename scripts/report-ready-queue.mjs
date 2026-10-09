#!/usr/bin/env node
// Print the night pass's READY QUEUE: the numbered items under
// "## Queued for Trevor / Claude Code" in the newest overnight handoff, each with
// how many nights it has been waiting.
//
// WHY (2026-10-09): from 10-05 to 10-09 five night-pass handoffs read
// "GREEN, 0 shipped" while a P1 (`chain-arrival-pack-pulls`) aged to five nights
// in that section. The work had a queue but no executor: nothing put the section
// in front of a Claude Code session, and a daytime session cleared it in one
// sitting once someone looked. This script is that "put it in front" step, so a
// session-start hook (or a person) can run one command instead of opening the
// handoff.
//
// ⚠ The handoff is a DATED SNAPSHOT: daytime sessions close items without
// editing it. So each item is cross-checked against the ledger headings written
// AFTER that night's pass: a heading that names the item's key (its first
// `backticked` token, or a #NNN register id) AND carries a closing status
// (APPLIED / SHIPPED / FIXED / DONE / CLOSED / RESOLVED / VERIFIED) marks it
// "likely closed", with the heading's line number. That is a HINT, not a
// verdict: a heading can name a lane it only partly fixed, so read the entry.
// Items waiting 3+ nights and not matched are flagged STALE.
//
// Usage: node scripts/report-ready-queue.mjs [handoff.md]   (default: newest)
// Exit 0 always — this is an information print, never a gate.
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

export const STALE_NIGHTS = 3

/** Extract numbered items from the "## Queued for Trevor…" section. */
export function parseQueued(markdown) {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((l) => /^## Queued for Trevor/.test(l))
  if (start < 0) return []
  const items = []
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break
    const m = line.match(/^(\d+)\.\s+(.*)$/)
    if (!m) continue
    const nights = line.match(/(\d+)\s+nights?\b/i)
    items.push({
      n: Number(m[1]),
      text: m[2],
      nights: nights ? Number(nights[1]) : null,
    })
  }
  return items
}

const CLOSING = /\b(APPLIED|SHIPPED|FIXED|DONE|CLOSED|RESOLVED|VERIFIED)\b/

/** The item's match keys: its first backticked token and any #NNN ids. */
export function itemKeys(text) {
  const keys = []
  const tick = text.match(/`([^`]{4,})`/)
  if (tick) keys.push(tick[1])
  for (const m of text.matchAll(/#\d{2,4}\b/g)) keys.push(m[0])
  return keys
}

/**
 * Ledger headings newer than the night pass of `date` (YYYY-MM-DD): everything
 * above that date's night-pass heading (newest-first file), stopping at any
 * older date. Returns [{ line, text }] with 1-based line numbers.
 */
export function headingsAfterNightPass(ledger, date) {
  const out = []
  const lines = ledger.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^### (\d{4}-\d{2}-\d{2})\b/)
    if (!m) continue
    if (m[1] < date) break
    // CASE-SENSITIVE on purpose: a daytime entry ABOUT the night pass ("the night
    // pass's ready queue") is not one; the pass itself writes `NIGHT PASS` or
    // "(nightly overnight" in its heading (10-08 and 10-09 formats).
    if (m[1] === date && /NIGHT PASS|\(nightly overnight/.test(lines[i])) break
    out.push({ line: i + 1, text: lines[i] })
  }
  return out
}

/** First later heading that names one of the item's keys with a closing status. */
export function likelyClosedBy(item, headings) {
  const keys = itemKeys(item.text)
  if (!keys.length) return null
  return headings.find((h) => CLOSING.test(h.text) && keys.some((k) => h.text.includes(k))) ?? null
}

export function newestOvernightHandoff(docsDir) {
  const names = readdirSync(docsDir)
    .filter((f) => /^handoff-\d{4}-\d{2}-\d{2}-overnight-pass\.md$/.test(f))
    .sort()
  return names.length ? path.join(docsDir, names[names.length - 1]) : null
}

function main() {
  const file = process.argv[2] ?? newestOvernightHandoff(path.join(process.cwd(), "docs"))
  if (!file) {
    console.log("[ready-queue] no overnight handoff found")
    return
  }
  const items = parseQueued(readFileSync(file, "utf8"))
  const rel = path.relative(process.cwd(), file)
  const date = path.basename(file).match(/\d{4}-\d{2}-\d{2}/)?.[0]
  let headings = []
  try {
    headings = headingsAfterNightPass(readFileSync(path.join(process.cwd(), "docs/overnight/ledger.md"), "utf8"), date)
  } catch {
    console.log("[ready-queue] ledger unreadable — items shown without the closed-check")
  }
  if (!items.length) {
    console.log(`[ready-queue] ${rel}: nothing queued for Trevor / Claude Code`)
    return
  }
  const rows = items.map((it) => ({ it, closed: likelyClosedBy(it, headings) }))
  const open = rows.filter((r) => !r.closed).length
  console.log(`[ready-queue] ${items.length} item(s) from ${rel}, ${open} still open by the ledger (hints — read the entry before acting):`)
  for (const { it, closed } of rows) {
    const flag = closed
      ? ` ✓ likely closed (ledger.md:${closed.line})`
      : it.nights != null && it.nights >= STALE_NIGHTS ? " ⚠ STALE" : ""
    console.log(`  ${it.n}.${flag} ${it.text.slice(0, closed ? 110 : 200)}`)
  }
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
