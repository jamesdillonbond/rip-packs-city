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

/**
 * Index of the queue section's `## ` heading, or -1. The heading has drifted
 * (10-11: "## Needs your decision / QUEUED", earlier "## 5. Needs Trevor /
 * queued", "## Queued / needs Trevor …"), and an exact "## Queued for Trevor"
 * match read every drifted handoff as an EMPTY queue, so the 10-11 pass's items
 * were never cross-checked. Any `## ` heading that says "queued", except one
 * that reports queued items RESOLVED.
 *
 * ⚠ WIDENED 2026-10-13: "carried" too. The 10-13 handoff titled its section
 * "## Carried queue (needs a non-night-pass owner)" and the 09-28 / 10-03 ones
 * "## Needs Trevor (carried…)" — none says "queued", so all three read as an
 * absent section and the next pass started with no carried queue. Replayed over
 * all 17 overnight handoffs: those 3 go from NONE to their real section, no file
 * that already matched changes, 0 remain unmatched.
 * ⛔ NOT bare "queue": "## Mode — OFF-HOURS / QUEUE-ONLY" (10-02) sits ABOVE
 * that handoff's real section and would be taken first. A recap heading that
 * reports items RESOLVED or "closed" ("## Verified closed this pass (dropped
 * from carry)", 10-13) is excluded.
 */
export function findQueueSection(lines) {
  return lines.findIndex(
    (l) => /^## /.test(l) && /\b(queued|carried)\b/i.test(l) && !/\b(RESOLVED|closed)\b/i.test(l),
  )
}

/**
 * Extract the items in the queue section: numbered lines AND top-level `- `
 * bullets (the 10-11 handoff wrote its carried P1/P2/P3 as bullets). Indented
 * lines are continuation, not items.
 */
export function parseQueued(markdown) {
  const lines = markdown.split(/\r?\n/)
  const start = findQueueSection(lines)
  if (start < 0) return []
  const items = []
  let next = 1
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break
    const m = line.match(/^(\d+)\.\s+(.*)$/) ?? line.match(/^[-*]()\s+(.*)$/)
    if (!m) continue
    const n = m[1] ? Number(m[1]) : next
    next = n + 1
    const nights = line.match(/(\d+)\s+nights?\b/i)
    items.push({
      n,
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
  // ≥ 5 chars: a 4-char token (`main`) matched "mainnet24" in an unrelated heading.
  const tick = text.match(/`([^`]{5,})`/)
  if (tick) keys.push(tick[1])
  // A carried bullet often names its lane in bold with no backticks
  // ("**chain-arrival-pack-pulls durable BOUND**"): take the first lane-shaped
  // identifier (three or more kebab/snake segments) as a key too.
  const lane = text.match(/[a-z0-9]+(?:[-_][a-z0-9]+){2,}/)
  if (lane && !keys.includes(lane[0])) keys.push(lane[0])
  // #NNN ids from the item's bold TITLE only: an item that mentions "#187" in
  // passing is not #187, and was marked closed by #187's fix on 10-11.
  const title = text.startsWith("**") ? text.slice(0, Math.max(text.indexOf("**", 2), 2)) : text
  for (const m of title.matchAll(/#\d{2,4}\b/g)) keys.push(m[0])
  return keys
}

/**
 * A night pass names itself in its heading's STATUS PREFIX, before the first
 * `**`: "🟢 NIGHT PASS", "🟢 GREEN … (nightly overnight", "VERIFIED (nightly,
 * nothing shipped)", "(overnight autonomous pass". A daytime entry mentions the
 * night pass only in its bold summary, after that. Matching the whole line broke
 * twice on 10-09: first on "the night pass's ready queue", then on an entry that
 * quoted the words NIGHT PASS.
 */
export function isNightPassHeading(line) {
  const prefix = line.split("**")[0]
  // `NIGHT PASS` is case-sensitive: the pass writes it in capitals, and prose
  // ("the night pass's queue") must not match even on a heading with no `**`.
  return /NIGHT PASS/.test(prefix) || /\(nightly\b|overnight (autonomous )?pass/i.test(prefix)
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
    if (m[1] === date && isNightPassHeading(lines[i])) break
    out.push({ line: i + 1, text: lines[i] })
  }
  return out
}

/**
 * Ledger headings dated from `date` back `days` days, BELOW that date's night
 * pass: the window where an item can be closed BEFORE the pass yet re-carried
 * by it (the 10-10 and 10-11 passes both carried P1/P2/P3 closed on 10-09).
 */
export function headingsBeforeNightPass(ledger, date, days = 14) {
  const floor = new Date(Date.parse(`${date}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10)
  const out = []
  const lines = ledger.split(/\r?\n/)
  let below = false
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^### (\d{4}-\d{2}-\d{2})\b/)
    if (!m) continue
    if (m[1] < floor) break
    if (!below) {
      if (m[1] === date && isNightPassHeading(lines[i])) { below = true; continue }
      if (m[1] < date) below = true
      else continue
    }
    // Older headings run body text on with no bold claim, and a night pass's
    // "VERIFIED" is about health, not a closure: neither can close an item here.
    if (!lines[i].includes("**") || isNightPassHeading(lines[i])) continue
    out.push({ line: i + 1, text: lines[i] })
  }
  return out
}

/**
 * What a heading CLAIMS: its status prefix plus its first **bold** summary.
 * Ledger headings run on into a long body on the same line, and the body names
 * lanes in passing ("`get_wallet_pack_summary` …" inside a #187 fix): matching
 * the whole line marked 6 of 10 items closed on 10-11, 4 of them wrongly.
 * A heading with no bold is matched whole.
 */
export function headingClaim(text) {
  const open = text.indexOf("**")
  if (open < 0) return text
  const close = text.indexOf("**", open + 2)
  return close < 0 ? text : text.slice(0, close)
}

/** First later heading whose claim names one of the item's keys with a closing status. */
export function likelyClosedBy(item, headings) {
  const keys = itemKeys(item.text)
  if (!keys.length) return null
  return headings.find((h) => {
    const claim = headingClaim(h.text)
    return CLOSING.test(claim) && keys.some((k) => claim.includes(k))
  }) ?? null
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
  const md = readFileSync(file, "utf8")
  const items = parseQueued(md)
  const rel = path.relative(process.cwd(), file)
  const date = path.basename(file).match(/\d{4}-\d{2}-\d{2}/)?.[0]
  let headings = []
  let earlier = []
  try {
    const ledger = readFileSync(path.join(process.cwd(), "docs/overnight/ledger.md"), "utf8")
    headings = headingsAfterNightPass(ledger, date)
    earlier = headingsBeforeNightPass(ledger, date)
  } catch {
    console.log("[ready-queue] ledger unreadable — items shown without the closed-check")
  }
  if (!items.length) {
    // An absent section is NOT an empty queue: say which, so a drifted heading
    // cannot read as "nothing to do" again (it did for the 10-11 handoff).
    if (findQueueSection(md.split(/\r?\n/)) < 0) {
      console.log(`[ready-queue] ⚠ ${rel}: no "## … queued" section found — the heading may have drifted; read the handoff`)
    } else {
      console.log(`[ready-queue] ${rel}: nothing queued for Trevor / Claude Code`)
    }
    return
  }
  const rows = items.map((it) => ({
    it,
    closed: likelyClosedBy(it, headings),
    before: likelyClosedBy(it, earlier),
  }))
  const open = rows.filter((r) => !r.closed && !r.before).length
  console.log(`[ready-queue] ${items.length} item(s) from ${rel}, ${open} still open by the ledger (hints — read the entry before acting):`)
  for (const { it, closed, before } of rows) {
    const flag = closed
      ? ` ✓ likely closed (ledger.md:${closed.line})`
      : before
        ? ` ✓ likely closed BEFORE this pass — re-carried (ledger.md:${before.line})`
        : it.nights != null && it.nights >= STALE_NIGHTS ? " ⚠ STALE" : ""
    console.log(`  ${it.n}.${flag} ${it.text.slice(0, closed || before ? 110 : 200)}`)
  }
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
