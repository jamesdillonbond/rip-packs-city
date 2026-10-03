#!/usr/bin/env node
//
// scripts/check-prod-dep-audit.mjs — a dependency change may not bring a NEW
// high/critical advisory into the PRODUCTION tree.
//
// ── Why ─────────────────────────────────────────────────────────────────────
// Until 2026-10-02 nothing in CI read `npm audit`. Dependabot raises PRs for
// NEW disclosures against what is already installed, but nothing stopped a
// push from ADDING a vulnerable package: every `npm ci` log printed the count
// ("29 vulnerabilities … 1 critical") and every job went green under it.
//
// ── What ────────────────────────────────────────────────────────────────────
// `npm audit --omit=dev --json`, reduced to its ROOT advisories (the entries
// that carry an advisory object, not the packages that only inherit one), at
// severity high or critical. Each must be in prod-dep-audit-baseline.json with
// a reason. Exit 1 on a new one, AND on a baseline entry the audit no longer
// reports, so the baseline only ever shrinks and a fix is recorded the push it
// lands. Exit 2 when the audit did not produce a readable report: a check
// that did not run must never read as a pass.
//
// ⚠ It runs on dependency changes (dependency-audit.yml), not on every push:
// the advisory database moves daily, so a nightly disclosure would otherwise
// red an unrelated push. New disclosures on installed packages are
// Dependabot's job. ⚠ Needs the registry: `npm audit` posts the tree to it.
//
// Usage: node scripts/check-prod-dep-audit.mjs [--report <audit.json>]
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const HERE = path.dirname(fileURLToPath(import.meta.url))
// At the repo root beside eslint-ratchet.json: `scripts/*.json` is gitignored.
const BASELINE = path.join(HERE, "..", "prod-dep-audit-baseline.json")
const GATED = new Set(["high", "critical"])

/** Root advisories at a gated severity: url → { package, severity, title }. */
export function rootAdvisories(report) {
  const out = new Map()
  for (const [pkg, v] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via !== "object" || !via) continue
      if (!GATED.has(via.severity)) continue
      const key = via.url || `${via.name ?? pkg}#${via.source}`
      out.set(key, { package: via.name ?? pkg, severity: via.severity, title: String(via.title ?? "").slice(0, 100) })
    }
  }
  return out
}

/** { exit, lines } for a parsed report against a baseline { advisories: { url: { package, reason } } }. */
export function evaluate(report, baseline) {
  const lines = []
  if (!report || typeof report !== "object" || !report.metadata?.vulnerabilities) {
    return { exit: 2, lines: ["[prod-dep-audit] INSTRUMENT BROKEN: npm audit returned no readable report — this is not a pass."] }
  }
  const prodDeps = report.metadata.dependencies?.prod ?? 0
  if (prodDeps < 50) {
    return { exit: 2, lines: [`[prod-dep-audit] INSTRUMENT BROKEN: the report covers only ${prodDeps} production dependencies; the tree was not read.`] }
  }
  const found = rootAdvisories(report)
  const allowed = baseline.advisories ?? {}
  const added = [...found.entries()].filter(([url]) => !allowed[url])
  const stale = Object.keys(allowed).filter((url) => !found.has(url))
  lines.push(`[prod-dep-audit] ${prodDeps} production dependencies audited; ${found.size} high/critical root advisor${found.size === 1 ? "y" : "ies"} (${Object.keys(allowed).length} baselined)`)
  for (const [url, a] of added) lines.push(`  NEW ${a.severity}: ${a.package} — ${a.title}\n      ${url}`)
  for (const url of stale) lines.push(`  NO LONGER REPORTED (remove from the baseline): ${allowed[url].package} ${url}`)
  if (added.length) lines.push("A dependency change brought in a high/critical advisory. Pick a fixed version, or baseline it in prod-dep-audit-baseline.json WITH the reason it cannot be fixed yet.")
  return { exit: added.length || stale.length ? 1 : 0, lines }
}

function runAudit() {
  try {
    return execFileSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] })
  } catch (e) {
    // npm audit exits 1 whenever ANY advisory exists; the JSON is still on stdout.
    return e.stdout ?? ""
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--report")
  const raw = i > 0 ? readFileSync(process.argv[i + 1], "utf8") : runAudit()
  let report = null
  try {
    report = JSON.parse(raw)
  } catch {
    report = null
  }
  const { exit, lines } = evaluate(report, JSON.parse(readFileSync(BASELINE, "utf8")))
  for (const l of lines) (exit ? console.error : console.log)(l)
  process.exit(exit)
}
