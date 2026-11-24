#!/usr/bin/env node
/**
 * Move the full text of CLOSED items in docs/reference/known-issues.md into
 * docs/reference/known-issues-archive.md, leaving a one-line stub in each slot.
 *
 * WHY (2026-11-24, rpc-context-hygiene, Trevor: "do it all"): the register had
 * grown to ~2 MB, 255 of its 259 items closed, and every session that opens it
 * paid for all of that. Item numbers never change and the index is untouched
 * (a stub still parses as a closed item with the same title), so every `#NNN`
 * citation keeps resolving.
 *
 * ⛔ KEEP holds items other guards READ: #14 carries the monolith inventory that
 * __tests__/monolith-inventory-is-derived-from-the-tree.test.ts uses as its
 * suppression list. Before moving an item, run that check by hand: a file over
 * the threshold named ONLY inside the moved text must be named in #14 instead.
 *
 * Idempotent: a slot that already holds a stub is skipped. Refuses to write if
 * the regenerated STATUS INDEX would differ from the current one.
 *
 * Usage: node scripts/archive-closed-known-issues.mjs           (move)
 *        node scripts/archive-closed-known-issues.mjs --dry-run (report only)
 * Revert one item: replace its stub with its `## #NNN` section body from the
 * archive and run `npm run docs:issues-index`.
 */
import fs from "node:fs"
import { parseItems, deriveStatus, deriveTitle, renderIndex } from "./gen-known-issues-index.mjs"

const FILE = "docs/reference/known-issues.md"
const ARCH = "docs/reference/known-issues-archive.md"
const KEEP = new Set(["14"])
const STUB_MARK = "full text moved verbatim to [known-issues-archive.md](known-issues-archive.md)"
const ITEM = /^([0-9]+[a-z]?)\.\s+(.*)$/
const isStop = (l) => ITEM.test(l) || l === "---" || /^#/.test(l) || /^>( |$)/.test(l) || l.startsWith("<!-- BEGIN:ITEM-INDEX")

const dry = process.argv.includes("--dry-run")
const md = fs.readFileSync(FILE, "utf8")
const lines = md.split("\n")
const items = parseItems(md)
const start = lines.findIndex((l) => l.startsWith("### Open"))
let end = lines.findIndex((l, i) => i > start && /^### /.test(l))
if (end < 0) end = lines.length
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date())

const moves = []
for (const it of items) {
  if (it.status !== "closed" || KEEP.has(it.id)) continue
  const s = it.line - 1
  if (lines[s].includes(STUB_MARK)) continue
  let e = s + 1
  while (e < end && !isStop(lines[e])) e++
  while (e > s + 1 && lines[e - 1].trim() === "") e--
  const bold = /\s$/.test(it.title) ? `${it.title}— closed` : it.title
  const stub = `${it.id}. **${bold}** — ✅ CLOSED; ${STUB_MARK} (#${it.id}) on ${today}.`
  const head = stub.match(ITEM)[2]
  if (deriveStatus(head) !== "closed" || deriveTitle(head) !== it.title) {
    console.log(`skip #${it.id}: its stub would not re-derive the same index row`)
    continue
  }
  moves.push({ id: it.id, s, e, stub })
}
if (moves.length === 0) { console.log("nothing to archive"); process.exit(0) }

const out = lines.slice()
const sections = []
for (const mv of [...moves].reverse()) {
  sections.unshift(`\n## #${mv.id}\n\n${lines.slice(mv.s, mv.e).join("\n")}\n`)
  out.splice(mv.s, mv.e - mv.s, mv.stub)
}
const newMd = out.join("\n")
if (renderIndex(items) !== renderIndex(parseItems(newMd))) {
  console.error("refusing: the STATUS INDEX would change"); process.exit(1)
}
console.log(`${dry ? "would move" : "moved"} ${moves.length}: ${moves.map((m) => "#" + m.id).join(" ")}`)
if (dry) process.exit(0)
fs.writeFileSync(FILE, newMd)
fs.appendFileSync(ARCH, sections.join(""))
