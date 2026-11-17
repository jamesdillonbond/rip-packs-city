#!/usr/bin/env node
/**
 * scripts/check-register-integrity.mjs
 *
 * WHY THIS EXISTS
 * ---------------
 * `docs/audits/deep-audit-register.md` is the canonical open list — the table a
 * session reads to decide WHAT TO WORK ON. The ledger has a no-clobber guard and
 * `docs/overnight/inbox/INDEX.md` has four CI assertions. **The register had
 * nothing.** Observed 2026-08-29: no test and no script referenced it, so a row
 * silently deleted by a bad splice, or mangled into the wrong number of columns
 * by a hand edit, would have been noticed by nobody.
 *
 * That matters more here than for the ledger. The ledger is append-at-top
 * history; a lost register row does not merely lose a record — it UN-FILES a
 * finding, and the next pass re-derives it from scratch or never looks again.
 *
 * WHAT IT ASSERTS, and why each is a real failure rather than tidiness
 * -------------------------------------------------------------------
 * 1. **No row id disappears.** Rows legitimately MOVE between OPEN and RESOLVED —
 *    that is the lifecycle — so this tracks the id SET, not per-section
 *    membership. Vanishing is the concurrent-splice clobber that has hit the
 *    ledger five times.
 * 2. **Every row has the column count ITS OWN SECTION HEADER declares.** One `|`
 *    too many and the row renders in the WRONG columns; GFM drops the cells past
 *    the header's width, so a trailing `owner` / `revert path` disappears
 *    entirely. The content is still in the file — a grep still finds it — which
 *    is what makes this the worst shape of loss.
 * 3. **Ids are unique.** Two rows sharing an id means one is unaddressable.
 *
 * ⚠ NON-VACUITY, at two granularities. It reports the row count it inspected and
 * FAILS on zero; and it fails unless **at least two sections CONTRIBUTE rows**,
 * because a parser that quietly stops matching one section's shape would
 * otherwise still report a healthy-looking population from the other.
 *
 * ⚠ THE EXPECTED WIDTH IS DERIVED FROM THE HEADER, NOT HARDCODED. An earlier
 * draft hardcoded `{OPEN: 6, RESOLVED: 5}` and flagged all 48 resolved rows on
 * its first run — the guard was the defect. Reading each section's own `| id |
 * … |` header row cannot drift from the file it checks.
 *
 * ⚠ THE EXCLUSION IS ASSERTED AT THE PROPERTY'S GRANULARITY. Sections whose
 * table is not id-keyed (VERIFIED-CLEAN is keyed by `area`, NOT-A-FINDING by
 * `item`) are skipped — but they are skipped because their header's first column
 * is not `id`, which is checked, not because they were named in a list. A new
 * id-keyed section is picked up with no edit here.
 *
 * Usage:
 *   node scripts/check-register-integrity.mjs                 # shape only (no git)
 *   node scripts/check-register-integrity.mjs --before <file> # + no-clobber compare
 */

import { readFileSync, existsSync } from "node:fs"
import { pathToFileURL } from "node:url"

export const REGISTER_PATH = "docs/audits/deep-audit-register.md"

/** A markdown table row split on UNESCAPED pipes, table edges dropped. */
export function splitCells(line) {
  // ⚠ `\|` is a legal escaped pipe inside a cell and does NOT open a column
  // (R6 and R32 use it). A RAW `|` does open one **even inside backticks** —
  // markdown splits the row before it parses inline code — so `` `/(ts|tsx)/` ``
  // genuinely breaks its row. That asymmetry is the whole point of this guard.
  const parts = line.trim().split(/(?<!\\)\|/)
  return parts.slice(1, -1).map((c) => c.trim())
}

/**
 * Every id-keyed row in the register, with the width its own section declares.
 *
 * Returns `{ rows, sections }` where `sections` lists every `##` section that
 * carries a table, whether it is id-keyed, and how many rows it contributed —
 * so a caller can assert the exclusions and the contributions, not just the sum.
 */
export function parseRows(src) {
  const rows = []
  const sections = []
  let current = null

  for (const line of String(src).split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      current = { name: heading[1], idKeyed: null, firstColumn: null, width: null, rows: 0 }
      sections.push(current)
      continue
    }
    if (!current || !line.trimStart().startsWith("|")) continue

    const cells = splitCells(line)
    if (cells.length === 0) continue

    // The first table row under a heading is its header; it declares both the
    // key column and the width every data row must match.
    if (current.idKeyed === null) {
      current.firstColumn = cells[0].toLowerCase()
      current.idKeyed = current.firstColumn === "id"
      current.width = cells.length
      continue
    }
    if (/^-+$/.test(cells[0])) continue // the |---|---| separator
    if (!current.idKeyed) continue

    current.rows += 1
    rows.push({ id: cells[0], columns: cells.length, section: current.name, expected: current.width })
  }

  return { rows, sections }
}

/**
 * The decision, pure so it can be pinned.
 *
 * @param {{ after: string, before?: string | null }} input
 *   `before` may be null when there is no parent revision to compare against.
 *   ⚠ The annotation is load-bearing: without it TS infers `before` as `null`
 *   from the default and every call site passing a string fails `tsc --noEmit`.
 */
export function checkRegister({ after, before = null }) {
  const { rows, sections } = parseRows(after)

  const seen = new Set()
  const duplicated = []
  for (const r of rows) {
    if (seen.has(r.id)) {
      if (!duplicated.includes(r.id)) duplicated.push(r.id)
    } else seen.add(r.id)
  }

  const malformed = rows
    .filter((r) => r.columns !== r.expected)
    .map((r) => ({ id: r.id, columns: r.columns, section: r.section, expected: r.expected }))

  let vanished = []
  if (before !== null) {
    const beforeIds = new Set(parseRows(before).rows.map((r) => r.id))
    vanished = [...beforeIds].filter((id) => !seen.has(id)).sort()
  }

  const contributing = sections.filter((s) => s.idKeyed && s.rows > 0).map((s) => s.name)
  // A section skipped for not being id-keyed is recorded WITH the property that
  // excused it, so the exclusion is auditable rather than asserted.
  const skipped = sections
    .filter((s) => s.idKeyed === false)
    .map((s) => ({ name: s.name, firstColumn: s.firstColumn }))

  return {
    inspected: rows.length,
    contributing,
    skipped,
    vanished,
    malformed,
    duplicated,
    ok:
      rows.length > 0 &&
      contributing.length >= 2 &&
      vanished.length === 0 &&
      malformed.length === 0 &&
      duplicated.length === 0,
  }
}

/** Exit code, extracted so it is pinned rather than inline. */
export function registerExitCode(result) {
  // Zero rows, or only one section contributing, is a FAILURE and not a clean
  // pass: it means the file moved, was emptied, or a section's shape changed
  // under this parser. A guard that inspects nothing looks exactly like one
  // that found nothing wrong.
  if (result.inspected === 0 || result.contributing.length < 2) return 2
  return result.ok ? 0 : 1
}

function arg(name) {
  const i = process.argv.indexOf(name)
  return i === -1 ? null : process.argv[i + 1]
}

function main() {
  if (!existsSync(REGISTER_PATH)) {
    console.error(`::error::${REGISTER_PATH} is missing. The canonical open list cannot be checked.`)
    process.exit(2)
  }
  const after = readFileSync(REGISTER_PATH, "utf8")
  const beforePath = arg("--before")
  const before = beforePath && existsSync(beforePath) ? readFileSync(beforePath, "utf8") : null

  const r = checkRegister({ after, before })
  console.log(
    `register integrity — ${r.inspected} row(s) inspected across ${r.contributing.length} id-keyed section(s): ` +
      `${r.contributing.join(", ")}` +
      (before === null ? " (no parent revision; shape only)" : " (compared against the parent revision)"),
  )
  for (const s of r.skipped) {
    console.log(`  skipped (not id-keyed, first column is \`${s.firstColumn}\`): ${s.name}`)
  }

  for (const id of r.vanished) {
    console.error(
      `::error::${id} was in the register before this push and is gone. A row must be MOVED to RESOLVED, never deleted.`,
    )
  }
  for (const m of r.malformed) {
    console.error(
      `::error::${m.id} (${m.section}) has ${m.columns} columns, its section header declares ${m.expected}. ` +
        `A raw \`|\` splits the cell even inside backticks — escape it as \\| . ` +
        `Cells past the header's width are DROPPED by the renderer, so the last column disappears while a grep still finds its text.`,
    )
  }
  for (const id of r.duplicated) {
    console.error(`::error::${id} appears more than once. Every reference to it is ambiguous.`)
  }
  if (r.inspected === 0) {
    console.error(
      "::error::inspected ZERO rows — the file moved, was emptied, or the row shape changed under this parser. Failing rather than passing.",
    )
  } else if (r.contributing.length < 2) {
    console.error(
      `::error::only ${r.contributing.length} id-keyed section contributed rows (${r.contributing.join(", ") || "none"}). ` +
        `Both OPEN and RESOLVED must be visible to this parser, or half the register is unchecked while the count still looks healthy.`,
    )
  }

  process.exitCode = registerExitCode(r)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
}
