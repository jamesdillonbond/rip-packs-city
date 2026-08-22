#!/usr/bin/env node
// Dev-only helper (NOT run in CI): proves a committed migration's embedded
// function DDL is byte-identical (whitespace-normalized) to the LIVE database
// definition captured via pg_get_functiondef. Usage:
//   node scripts/verify-live-ddl.mjs <migration.sql> <fn> <expected_norm_md5>
// It extracts the fn DDL as __tests__/db-invariants-drift-guard.test.ts does
// (FUNCTION *and* PROCEDURE — see DDL_KINDS below; this claim was false between
// 2026-08-16 and 2026-08-22, when only the guard handled procedures),
// normalizes whitespace, strips a single trailing ';' (pg_get_functiondef
// emits no trailing semicolon), md5s, and compares to the expected live md5.
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"

// ⚠ PROCEDURE too — this is the THIRD copy of this parser. The drift guard fixed
// its FUNCTION-only needle on 2026-08-16 (a PROCEDURE was otherwise UNPINNABLE);
// scripts/check-db-pin-staleness.mjs was fixed on 2026-08-22; this one still said
// FUNCTION only, while its own header above claimed it "extracts the fn DDL
// exactly as __tests__/db-invariants-drift-guard.test.ts does". It did not.
// Found by grepping the EXPRESSION rather than the file, which is the only reason
// a third copy turned up at all.
const DDL_KINDS = ["FUNCTION", "PROCEDURE"]
function findFnStart(src, name) {
  for (const kind of DDL_KINDS) {
    const needle = `CREATE OR REPLACE ${kind} public.${name}`
    let from = 0
    for (;;) {
      const idx = src.indexOf(needle, from)
      if (idx < 0) break
      const lineStart = src.lastIndexOf("\n", idx) + 1
      if (!src.slice(lineStart, idx).includes("--")) return idx
      from = idx + needle.length
    }
  }
  return -1
}
function extractSqlFn(src, name) {
  const start = findFnStart(src, name)
  if (start < 0) return null
  const rest = src.slice(start)
  const tagMatch = /\$([a-zA-Z_]*)\$/.exec(rest)
  if (!tagMatch) return null
  const tag = tagMatch[0]
  const bodyOpen = tagMatch.index + tag.length
  const closeRel = rest.indexOf(tag, bodyOpen)
  if (closeRel < 0) return null
  const semi = rest.indexOf(";", closeRel + tag.length)
  if (semi < 0) return null
  return rest.slice(0, semi + 1).replace(/\s+/g, " ").trim()
}

const [file, fn, expected] = process.argv.slice(2)
const src = readFileSync(file, "utf8")
let ddl = extractSqlFn(src, fn)
if (!ddl) { console.error(`FAIL: ${fn} not found in ${file}`); process.exit(1) }
// pg_get_functiondef has no trailing ';', the migration copy does — strip it.
const norm = ddl.replace(/;$/, "")
const md5 = createHash("md5").update(norm).digest("hex")
if (md5 === expected) {
  console.log(`OK   ${fn}: ${md5} (len ${norm.length})`)
  process.exit(0)
} else {
  console.error(`DRIFT ${fn}: got ${md5} (len ${norm.length}), want ${expected}`)
  process.exit(1)
}
