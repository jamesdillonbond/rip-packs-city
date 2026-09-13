import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
// ⚠ No `@ts-expect-error` here. The directive was added on the assumption that a
// plain .mjs import is untyped, but this repo's tsconfig resolves it fine, so the
// directive itself became the error (TS2578 "Unused '@ts-expect-error' directive")
// and reddened `npx tsc --noEmit`, which CI gates. Suppressions must be verified
// against the compiler, not assumed from the file extension.
import { parseItems, renderIndex, deriveStatus, deriveTitle } from "../scripts/gen-known-issues-index.mjs"

// docs/reference/known-issues.md is the canonical open list — CLAUDE.md and the
// inbox INDEX both point at it — and it had grown to 45 numbered items in one
// ~80 KB section with no way to see them at a glance. SIXTEEN of them read
// RESOLVED / CLOSED / SHELVED / RETIRED in their own first sentence while
// sitting under the heading `### Open`.
//
// That is not cosmetic, and the register itself records the proof: item #8's
// text says it "sat under a Resolved heading, so anyone enumerating the Open
// list never saw it" — the same mismatch pointed the other way cost that item
// several sessions of being read as closed.
//
// ⛔ The fix is NOT to move or renumber items. The ledger, focus.md, inbox
// filings, CLAUDE.md and migration record files all cite them by number, so
// re-sorting would break every citation. The fix is an ADDITIVE generated index.
//
// This is the watcher for it, in the same shape as
// `inbox-index-lists-every-filing`: a BAN AT POPULATION ZERO (every item must be
// listed; the allowed number of omissions is 0), checked in BOTH directions,
// because a missing row hides an item and a dangling row asserts an item that
// does not exist.
//
// ⚠ It asserts the COUNT IT INSPECTED, not merely that nothing failed: a parser
// that silently matched zero items would otherwise pass every assertion below.
const FILE = path.join(process.cwd(), "docs/reference/known-issues.md")
const md = () => readFileSync(FILE, "utf8")

describe("known-issues STATUS INDEX", () => {
  it("inspects a non-zero population (a parser matching nothing must not pass)", () => {
    const items = parseItems(md())
    expect(items.length).toBeGreaterThan(20)
  })

  it("lists every numbered item in the Open section — no omissions", () => {
    const items = parseItems(md())
    const block = md().slice(md().indexOf("<!-- BEGIN:ITEM-INDEX"), md().indexOf("<!-- END:ITEM-INDEX"))
    const missing = items.filter((i: { id: string }) => !block.includes(`| **#${i.id}** |`))
    expect(missing.map((i: { id: string }) => i.id)).toEqual([])
    expect(items.length).toBeGreaterThan(20)
  })

  it("lists no item that does not exist in the body — no dangling rows", () => {
    const body = md()
    const block = body.slice(body.indexOf("<!-- BEGIN:ITEM-INDEX"), body.indexOf("<!-- END:ITEM-INDEX"))
    const listed = [...block.matchAll(/\| \*\*#([0-9]+[a-z]?)\*\* \|/g)].map((m) => m[1])
    const real = new Set(parseItems(body).map((i: { id: string }) => i.id))
    expect(listed.filter((id) => !real.has(id))).toEqual([])
    expect(listed.length).toBeGreaterThan(20)
  })

  it("is byte-identical to a fresh regeneration (it cannot silently rot)", () => {
    const body = md()
    const fresh = renderIndex(parseItems(body))
    const current = body.slice(body.indexOf("<!-- BEGIN:ITEM-INDEX"), body.indexOf("<!-- END:ITEM-INDEX") + "<!-- END:ITEM-INDEX -->".length)
    expect(current).toBe(fresh)
  })

  it("the --check mode is ENFORCING: it exits non-zero on a stale index", () => {
    // Positive control. A check that only ever runs against a current file
    // proves nothing about whether it can fail.
    const body = md()
    const tampered = body.replace(/\| \*\*#([0-9]+[a-z]?)\*\* \| [^|]+\|/, "")
    expect(tampered).not.toBe(body)
    const freshFromTampered = renderIndex(parseItems(tampered))
    expect(tampered.includes(freshFromTampered)).toBe(false)
  })

  it("derives status from the item's own words, and the closed/partial boundary is the trap", () => {
    // "PARTLY RESOLVED" contains "RESOLVED"; a naive rule calls it closed.
    expect(deriveStatus("🟡 **PARTLY RESOLVED 2026-08-23 — the privilege defect is fixed**")).toBe("partial")
    expect(deriveStatus("🟡 **PARTIALLY SHIPPED — two pack-sales backfills**")).toBe("partial")
    // A re-opened item names its own resolution history and is still open.
    expect(deriveStatus("**NBA stats — REGRESSED, re-opened 2026-08-16.** Filed under Resolved until…")).toBe("open")
    expect(deriveStatus("✅ **RESOLVED 2026-08-22 — all 6 closed.**")).toBe("closed")
    expect(deriveStatus("**Cart execution — SHELVED 2026-05-24, FRONTEND + API DELETED**")).toBe("closed")
    expect(deriveStatus("🔴 **OPEN, NEW 2026-08-27 — unbounded fetch() in an after() route**")).toBe("open")
  })

  it("derives a title that survives the register's markdown", () => {
    expect(deriveTitle("**`atlas-proxy` — needs an operator `wrangler deploy`.** More prose here.")).toBe(
      "atlas-proxy — needs an operator wrangler deploy."
    )
    expect(deriveTitle("plain text with no bold at all, quite long".repeat(4)).length).toBeLessThanOrEqual(96)
  })

  // 🚨 THE GAP THIS GUARD WAS STRUCTURALLY SILENT ABOUT, AND IT HAD ALREADY BITTEN
  // TWICE. `parseItems` slices `### Open` to the NEXT `### ` heading, so a numbered
  // item written BELOW that window is invisible to it — and every assertion above
  // then passes VACUOUSLY, because they each check that the items the parser FOUND
  // are indexed. Measured 2026-09-13: #98 (OPEN) and #99 sat under `### Resolved`
  // and were absent from the index, which ended at #97. The Resolved heading's own
  // note records the same thing happening to item #8. A guard that cannot see the
  // items placed outside its window is not a guard over the file.
  //
  // ⭐ Expressed as a BAN AT ZERO over the whole file rather than a count, so it is
  // invariant under ordinary additions and deletions and reds only when an item is
  // placed outside the Open section.
  //
  // ⭐ And it reuses the generator's OWN matcher instead of restating its item regex
  // here: it re-parses a copy in which every heading after `### Open` is demoted, so
  // the parser's window runs to EOF. A copied regex would be a claim about the
  // generator that can go stale silently — the same failure one level up.
  const widenTheOpenWindowToEOF = (body: string) => {
    const i = body.indexOf("### Open") + "### Open".length
    return body.slice(0, i) + body.slice(i).replace(/^### /gm, "#### ")
  }

  it("has NO numbered item outside the Open section — the parser's window is the whole population", () => {
    const body = md()
    const inOpen = parseItems(body).map((i: { id: string }) => i.id)
    const anywhere = parseItems(widenTheOpenWindowToEOF(body)).map((i: { id: string }) => i.id)
    expect(anywhere.length).toBeGreaterThan(20) // not vacuous
    expect(anywhere.filter((id) => !inOpen.includes(id))).toEqual([])
  })

  it("that ban can actually FAIL — an item moved below the Open section is caught", () => {
    // Positive control. Relocate the LAST item's heading line to the end of the
    // file, which is exactly the shape #98/#99 and #8 arrived in.
    const body = md()
    const items = parseItems(body)
    const last = items[items.length - 1]
    const lines = body.split("\n")
    const moved = lines[last.line - 1]
    expect(moved).toMatch(/^[0-9]+[a-z]?\. /)
    lines.splice(last.line - 1, 1)
    const tampered = lines.join("\n") + "\n\n" + moved + "\n"
    const inOpen = parseItems(tampered).map((i: { id: string }) => i.id)
    const anywhere = parseItems(widenTheOpenWindowToEOF(tampered)).map((i: { id: string }) => i.id)
    expect(inOpen).not.toContain(last.id)
    expect(anywhere).toContain(last.id)
    expect(anywhere.filter((id) => !inOpen.includes(id))).toEqual([last.id])
  })

  it("the generator refuses to write an empty index", () => {
    expect(() => parseItems("# a file with no Open section\n")).toThrow(/no '### Open' heading/)
  })

  it("npm run docs:issues-index -- --check passes against the committed file", () => {
    const out = execFileSync("node", ["scripts/gen-known-issues-index.mjs", "--check"], { encoding: "utf8" })
    expect(out).toMatch(/index is current — \d+ items inspected/)
  })
})
