#!/usr/bin/env node
// Dev-only helper (NOT run in CI): proves a committed migration's embedded
// function DDL is byte-identical (whitespace-normalized) to the LIVE database
// definition captured via pg_get_functiondef. Usage:
//   node scripts/verify-live-ddl.mjs <migration.sql> <fn> <expected_norm_md5>
// It extracts the fn DDL exactly as __tests__/db-invariants-drift-guard.test.ts
// does, normalizes whitespace, strips a single trailing ';' (pg_get_functiondef
// emits no trailing semicolon), md5s, and compares to the expected live md5.
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"

function findFnStart(src, name) {
  const needle = `CREATE OR REPLACE FUNCTION public.${name}`
  let from = 0
  for (;;) {
    const idx = src.indexOf(needle, from)
    if (idx < 0) return -1
    const lineStart = src.lastIndexOf("\n", idx) + 1
    if (!src.slice(lineStart, idx).includes("--")) return idx
    from = idx + needle.length
  }
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
