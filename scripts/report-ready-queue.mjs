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
// ⚠ It reports a DATED SNAPSHOT, not live state. Daytime sessions close items
// without editing the night handoff, so verify each against the ledger top
// before acting. Items waiting 3+ nights are flagged STALE.
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
  if (!items.length) {
    console.log(`[ready-queue] ${rel}: nothing queued for Trevor / Claude Code`)
    return
  }
  console.log(`[ready-queue] ${items.length} item(s) from ${rel} — verify each against docs/overnight/ledger.md top before acting:`)
  for (const it of items) {
    const flag = it.nights != null && it.nights >= STALE_NIGHTS ? " ⚠ STALE" : ""
    console.log(`  ${it.n}.${flag} ${it.text.slice(0, 200)}`)
  }
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
