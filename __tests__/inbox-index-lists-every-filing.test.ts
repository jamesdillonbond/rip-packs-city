import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, existsSync } from "node:fs"
import path from "node:path"

// docs/overnight/inbox/INDEX.md exists so a session can honour the audit
// protocol's cheap-check (1) — "grep ALL of inbox/* before measuring anything" —
// without opening ~200 documents. It is a MAP, and its own header says what
// happens to an unmaintained one: "Regenerate this file when you add filings, or
// it becomes another rotted map — the exact failure it documents."
//
// It rotted the same day it was written. Measured 2026-08-22 ~21:20 PT: 196
// filings on disk, 193 listed, THREE missing — including the P0-adjacent Sentry
// blackout filing. A map that silently omits an entry is worse than no map: a
// session that scans it believes it has read the backlog.
//
// Nothing watched it, so this is that watcher. It is a BAN AT POPULATION ZERO
// (every filing must be listed; the allowed number of omissions is 0) rather
// than a ratchet, because there is no cost to listing a filing and no legitimate
// reason to leave one out.
//
// It deliberately checks BOTH directions. A missing entry hides work. A dangling
// entry — a link to a file that has been archived or renamed — is the same
// defect pointed the other way: the index asserts a filing is in the queue when
// it is not.
//
// ⚠ BOTH halves have now fired in production, hours apart. 2026-08-22 22:59: a
// concurrent session wrote back a stale copy and dropped NINE filings, one of them
// titled HIGH-PRIORITY. 2026-08-23 ~08:00: the overnight pass archived two drained
// filings into inbox/archive/ and left their entries here, so the index listed two
// items as open that were closed. Neither was noticed by a reader; both were caught
// here on the next CI run.

const INBOX = path.join(process.cwd(), "docs/overnight/inbox")
const INDEX = path.join(INBOX, "INDEX.md")

function filingsOnDisk(): string[] {
  return readdirSync(INBOX)
    .filter((f) => f.endsWith(".md") && f !== "INDEX.md")
    .sort()
}

function linkedFilings(src: string): string[] {
  // Entries are markdown links whose target is the filing's basename:
  //   - [Some title](2026-08-23T0228Z-....md)
  const out: string[] = []
  for (const m of src.matchAll(/\]\((\d{4}-\d{2}-\d{2}T[^)\s]+\.md)\)/g)) out.push(m[1])
  return out
}

describe("docs/overnight/inbox/INDEX.md is a complete map of the inbox", () => {
  const src = readFileSync(INDEX, "utf8")
  const onDisk = filingsOnDisk()
  const linked = linkedFilings(src)

  it("has a population large enough for the checks below to mean anything", () => {
    // Guards the vacuous case: a renamed directory or a changed link shape would
    // otherwise make every assertion below pass by inspecting nothing.
    expect(onDisk.length).toBeGreaterThan(50)
    expect(linked.length).toBeGreaterThan(50)
  })

  it("lists every filing on disk — zero omissions", () => {
    const listed = new Set(linked)
    const missing = onDisk.filter((f) => !listed.has(f))
    expect(missing, `filings on disk but absent from INDEX.md:\n${missing.join("\n")}`).toEqual([])
  })

  it("links no filing that does not exist", () => {
    const dangling = [...new Set(linked)].filter((f) => !existsSync(path.join(INBOX, f)))
    const archived = dangling.filter((f) => existsSync(path.join(INBOX, "archive", f)))
    const archiveNote = archived.length
      ? `\n\n${archived.length} of them are in inbox/archive/. ARCHIVING A FILING MEANS REMOVING ITS ENTRY HERE TOO: ` +
        `this index maps the LIVE queue ("N live filings"), so an entry for an archived filing tells the next ` +
        `session an item is still open when it is closed. Delete the entry; the counts re-derive from the entries.`
      : ""
    expect(
      dangling,
      `INDEX.md links files that are not in the inbox:\n${dangling.join("\n")}${archiveNote}`,
    ).toEqual([])
  })

  it("states a heading count equal to the number of filings", () => {
    const m = src.match(/^# Inbox index — (\d+) live filings/m)
    expect(m, "INDEX.md must open with '# Inbox index — N live filings'").not.toBeNull()
    expect(Number(m![1])).toBe(onDisk.length)
  })

  it("states per-day counts equal to the entries under each day", () => {
    // "## 2026-08-09 — 1 filing" is singular, so the suffix is optional-plural.
    const lines = src.split("\n")
    const mismatches: string[] = []
    let day: { date: string; claimed: number } | null = null
    let seen = 0
    const flush = () => {
      if (day && day.claimed !== seen) mismatches.push(`${day.date}: heading says ${day.claimed}, section holds ${seen}`)
    }
    for (const line of lines) {
      const head = line.match(/^## (\d{4}-\d{2}-\d{2}) — (\d+) filings?\b/)
      if (head) {
        flush()
        day = { date: head[1], claimed: Number(head[2]) }
        seen = 0
        continue
      }
      if (line.startsWith("## ")) {
        flush()
        day = null
        continue
      }
      if (day && /^- \[/.test(line)) seen++
    }
    flush()
    expect(mismatches, mismatches.join("\n")).toEqual([])
  })
})
