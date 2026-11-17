#!/usr/bin/env node
// Deno-lint ratchet for supabase/functions/** (CI job `edge-deno`).
//
// WHY A RATCHET AND NOT A FIX. Until 2026-09-25 `deno lint` ran with `|| true`:
// it could never fail, so a new finding landed as silently as an old one. The
// 17 findings present that day are all in DEPLOYED edge functions, and
// `npm run edge:drift:check` compares the repo source against what is deployed,
// so "just fix them" means redeploying 13 functions for lint hygiene. Instead the
// baseline is pinned per rule AND file: a count may only go DOWN, and a
// (rule, file) pair not in the baseline fails. Fix one when you are already
// deploying that function, then lower the baseline in the same commit.
//
// Usage:
//   deno lint --json supabase/functions/ > lint.json || true
//   node scripts/check-deno-lint-ratchet.mjs lint.json
//   node scripts/check-deno-lint-ratchet.mjs lint.json --update   # rewrite baseline (only after a DROP)

import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const BASELINE = path.join(ROOT, "deno-lint-ratchet.json")

/** Count findings per "rule|repo-relative file". Pure. */
export function countFindings(report, root = ROOT) {
  const out = {}
  for (const d of report.diagnostics ?? []) {
    let f = String(d.filename ?? "")
    if (f.startsWith("file://")) f = fileURLToPath(f)
    f = path.relative(root, f).split(path.sep).join("/")
    const k = `${d.code}|${f}`
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

/** Compare current counts to the baseline. Pure. */
export function compare(current, baseline) {
  const grown = []
  const shrunk = []
  for (const [k, n] of Object.entries(current)) {
    const b = baseline[k] ?? 0
    if (n > b) grown.push({ key: k, baseline: b, now: n })
  }
  for (const [k, b] of Object.entries(baseline)) {
    const n = current[k] ?? 0
    if (n < b) shrunk.push({ key: k, baseline: b, now: n })
  }
  return { grown, shrunk }
}

function main() {
  const file = process.argv[2]
  if (!file) {
    console.error("usage: check-deno-lint-ratchet.mjs <deno-lint.json> [--update]")
    process.exit(2)
  }
  let report
  try {
    report = JSON.parse(readFileSync(file, "utf8"))
  } catch (e) {
    // An unreadable report is a failure to MEASURE, never a pass.
    console.error(`✗ cannot read deno lint JSON at ${file}: ${e.message}`)
    process.exit(2)
  }
  if (!Array.isArray(report.diagnostics)) {
    console.error("✗ deno lint JSON has no `diagnostics` array — the report shape changed")
    process.exit(2)
  }
  if ((report.errors ?? []).length) {
    // A file deno could not parse is not linted, and so cannot add a finding.
    console.error(`✗ deno lint could not process ${report.errors.length} file(s):`)
    for (const e of report.errors) console.error(`  ${e.file_path ?? ""} ${e.message ?? ""}`)
    process.exit(1)
  }
  const current = countFindings(report)
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"))
  const total = Object.values(current).reduce((a, b) => a + b, 0)
  const baseTotal = Object.values(baseline).reduce((a, b) => a + b, 0)

  if (process.argv.includes("--update")) {
    writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(Object.entries(current).sort()), null, 2) + "\n")
    console.log(`deno-lint baseline rewritten: ${baseTotal} → ${total}`)
    return
  }

  const { grown, shrunk } = compare(current, baseline)
  console.log(`deno lint ratchet — ${total} finding(s) (baseline ${baseTotal}) across ${Object.keys(current).length} rule|file key(s)`)
  for (const g of grown) console.log(`  ✗ ${g.key}: ${g.baseline} → ${g.now}`)
  for (const s of shrunk) console.log(`  ↓ ${s.key}: ${s.baseline} → ${s.now} (run with --update to lower the baseline)`)
  if (grown.length) {
    console.log("\nNew deno lint finding(s) in supabase/functions — fix them; the baseline only goes down.")
    process.exit(1)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main()
