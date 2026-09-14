#!/usr/bin/env node
// scripts/audit-cowork-artifact-failure-handling.mjs
//
// Which LIVE Cowork dashboards still render a FAILED READ as an EMPTY RESULT SET?
// (register #114). This is the instrument for the half of #114 that is NOT in this
// repo: the published dashboards, whose only copy on disk is Claude Desktop's
// artifact store.
//
// ── WHY THIS EXISTS AS A SCRIPT AND NOT A NUMBER IN A DOC ──────────────────
// #114 was filed saying "the FIVE live dashboards still carry the old helper".
// Measured 2026-09-14 08:3x AM PT by walking the store: it is **FIFTEEN**. A
// session following the prose would have fixed five, believed the estate clean,
// and left ten rendering a failed read as "no data". CLAUDE.md's rule is that
// every figure is a dated sample -- so this walks the tree and re-derives the
// count instead of restating it. Run it before claiming the estate is fixed.
//
// ── WHAT IT DISCRIMINATES, AND WHY THE CALL-SITE GUARD IS NOT COVERAGE ─────
// Three independent properties, because "handles errors" is not one question:
//
//   1. helper throws on {error:{name,message}}  <- THE SHAPE THAT ACTUALLY HAPPENS.
//      Measured against the live Supabase MCP server: this is verbatim what it
//      answers for a missing relation. The old helper fell through to `return
//      [raw]`, i.e. one junk row, no throw.
//   2. helper throws on an unparseable NON-EMPTY body, rather than `return []`,
//      which is indistinguishable from a genuinely empty result set.
//   3. the CALL SITE separately checks `isError` before unwrapping.
//
// ⚠ (3) IS THE TRAP. Eleven of the fifteen do check `isError` at the call site,
// which reads as error handling and is why this survived review -- but `isError`
// is NOT the shape a missing relation returns. Those eleven are guarded against
// the failure that does not happen and blind to the one that does. Four have no
// call-site guard at all and are blind to everything.
//
// ── WHY BRACE-MATCHING ─────────────────────────────────────────────────────
// The helper is lifted by matching braces from `function extractRows`, NOT by a
// character slice. A sibling guard in this repo was bounded by CHARACTER DISTANCE
// and silently inspected a truncated body; `__tests__/artifact-helpers-do-not-
// render-failure-as-empty.test.ts` brace-matches for the same reason.
//
// USAGE:  node scripts/audit-cowork-artifact-failure-handling.mjs [storeDir]
//         COWORK_ARTIFACT_STORE=<dir> node scripts/audit-cowork-artifact-failure-handling.mjs
//
// ⛔ NOT RUNNABLE IN CI, and deliberately so: the store is a per-machine Claude
// Desktop directory, not a repo path. Same class as `npm run db:pins:check`,
// which needs a service-role key. Exits 2 when the store is absent so a machine
// without it fails LOUDLY rather than reporting a clean estate it never read.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import path from "node:path"
import os from "node:os"

const DEFAULT_STORE = path.join(os.homedir(), "OneDrive", "Documents", "Claude", "Artifacts")
const store = process.argv[2] || process.env.COWORK_ARTIFACT_STORE || DEFAULT_STORE

if (!existsSync(store) || !statSync(store).isDirectory()) {
  console.error(`✗ artifact store not found: ${store}`)
  console.error(`  Pass it explicitly or set COWORK_ARTIFACT_STORE.`)
  console.error(`  Refusing to report a clean estate from a store that was never read.`)
  process.exit(2)
}

/** Lift the helper body by BRACE MATCHING, never a character slice. */
function liftHelper(src) {
  const start = src.indexOf("function extractRows")
  if (start < 0) return null
  const open = src.indexOf("{", start)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return null
}

const rows = []
for (const entry of readdirSync(store)) {
  const file = path.join(store, entry, "index.html")
  if (!existsSync(file)) continue
  const src = readFileSync(file, "utf8")
  const helper = liftHelper(src)
  if (!helper) continue

  rows.push({
    artifact: entry,
    throwsOnErrorObject:
      /raw\.error\s*&&\s*typeof\s+raw\.error\s*===\s*["']object["']/.test(helper) ||
      /raw\.isError\s*===\s*true/.test(helper),
    throwsOnUnreadable: /throw new Error\(\s*["']unreadable/.test(helper),
    callSiteChecksIsError:
      /if\s*\(\s*r\s*&&\s*r\.isError\s*\)\s*throw/.test(src) ||
      /if\s*\(\s*raw\s*&&\s*raw\.isError\s*\)\s*throw/.test(src),
  })
}

rows.sort((a, b) => a.artifact.localeCompare(b.artifact))

// A population of zero would make every assertion below vacuously reassuring.
if (rows.length === 0) {
  console.error(`✗ no artifact carried an extractRows helper under ${store}`)
  console.error(`  That is either a moved store or a changed helper name — not a clean estate.`)
  process.exit(2)
}

const pad = (s, n) => String(s).padEnd(n)
console.log(`Cowork artifact store: ${store}\n`)
console.log(pad("artifact", 30), pad("throws on {error:{…}}", 22), pad("throws on unreadable", 21), "call-site isError")
console.log("-".repeat(96))
for (const r of rows) {
  console.log(
    pad(r.artifact, 30),
    pad(r.throwsOnErrorObject ? "yes" : "NO", 22),
    pad(r.throwsOnUnreadable ? "yes" : "NO", 21),
    r.callSiteChecksIsError ? "yes" : "NO",
  )
}

const vulnerable = rows.filter((r) => !r.throwsOnErrorObject)
const fullyBlind = vulnerable.filter((r) => !r.callSiteChecksIsError)

console.log(`\nartifacts carrying an extractRows helper: ${rows.length}`)
console.log(`blind to the shape that actually happens ({error:{…}}): ${vulnerable.length}`)
console.log(`  ...and no call-site isError guard either (FULLY BLIND): ${fullyBlind.length}`)
if (fullyBlind.length) console.log(`  fully blind: ${fullyBlind.map((r) => r.artifact).join(", ")}`)
console.log(
  `\nFix: copy the helper from docs/cowork-skills/rpc-insights-health.html into each,` +
    `\nthen update_artifact each one from a Cowork DESKTOP session (this repo's tooling cannot republish them).`,
)

process.exit(vulnerable.length === 0 ? 0 : 1)
