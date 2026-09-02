#!/usr/bin/env node
/**
 * scripts/check-eslint-ratchet.mjs
 *
 * WHY A RATCHET AND NOT A GATE
 * ----------------------------
 * ⚠ THIS REPO DOES NOT RUN ESLINT IN CI, and ci.yml says so in a comment
 * ("do not cite it as coverage anywhere"). Measured 2026-08-29 over 2,857 files:
 * **6,474 violations across 20 rules, of which 5,757 (89%) are
 * `@typescript-eslint/no-explicit-any`** — which is a DOCUMENTED CONVENTION here
 * ("Supabase client typed `any` in API routes"). So the absence of eslint is a
 * rule-set mismatch, not neglect, and turning it on as a gate would be a
 * 6,000-error wall that gets switched off within a day.
 *
 * ⛔ `no-explicit-any` is therefore EXCLUDED, and the exclusion is asserted at
 * the rule's own granularity rather than by muting a whole plugin — muting the
 * plugin would also silence `no-unused-expressions`, `no-require-imports` and
 * `no-empty-object-type`, which are not conventional here.
 *
 * The residual is 717 violations across 19 rules, several of them genuine
 * correctness classes rather than style: `react-hooks/set-state-in-effect` (59),
 * `@next/next/no-html-link-for-pages` (114), `react-hooks/purity` (6),
 * `react-hooks/static-components` (15).
 *
 * 717 is too many to fix in one pass and too many to gate at zero. A RATCHET is
 * the repo's own answer to exactly that shape (the coverage gates, the
 * fabricated-divisor ratchet, the local-stripper population ratchet): the count
 * is bounded, it may only shrink, and a regression is loud on the commit that
 * introduces it instead of being absorbed into a number nobody reads.
 *
 * WHAT MAKES IT NOT VACUOUS
 * -------------------------
 * - A rule that is NOT in the baseline and appears is a FAILURE, not an
 *   unmeasured pass. A new rule arriving silently is how a guard goes blind.
 * - A baseline entry whose count is now ZERO is reported so the entry gets
 *   deleted; a baseline that describes the past is worse than none.
 * - It refuses to report an all-clear on an empty or unreadable report, because
 *   "eslint found nothing" and "eslint did not run" produce the same zero.
 *
 * Usage:
 *   npx eslint . --format json -o eslint-report.json || true
 *   node scripts/check-eslint-ratchet.mjs --report eslint-report.json
 *   node scripts/check-eslint-ratchet.mjs --report eslint-report.json --write  # re-baseline
 */

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs"
import { pathToFileURL } from "node:url"

export const BASELINE_PATH = "eslint-ratchet.json"

/** Per-rule violation counts from an eslint JSON report, minus the exclusions. */
export function countByRule(report, excludedRules = []) {
  const excluded = new Set(excludedRules)
  const counts = {}
  let filesLinted = 0
  let suppressionsWithNothingToSuppress = 0
  for (const file of report) {
    filesLinted += 1
    for (const m of file.messages ?? []) {
      // A message with no ruleId is an unused `eslint-disable` directive, not a
      // parse failure — a distinction that cost me a wrong reading first time.
      if (!m.ruleId) {
        suppressionsWithNothingToSuppress += 1
        continue
      }
      if (excluded.has(m.ruleId)) continue
      counts[m.ruleId] = (counts[m.ruleId] ?? 0) + 1
    }
  }
  return { counts, filesLinted, suppressionsWithNothingToSuppress }
}

/**
 * The decision, pure so it can be pinned.
 * Returns { grew, appeared, emptied, ok }.
 */
export function compareToBaseline({ counts, baseline }) {
  const grew = []
  const appeared = []
  const emptied = []

  for (const [rule, n] of Object.entries(counts)) {
    const was = baseline[rule]
    if (was === undefined) appeared.push({ rule, now: n })
    else if (n > was) grew.push({ rule, was, now: n })
  }
  for (const [rule, was] of Object.entries(baseline)) {
    if (!counts[rule]) emptied.push({ rule, was })
  }
  return { grew, appeared, emptied, ok: grew.length === 0 && appeared.length === 0 }
}

/** Exit code, extracted so it is pinned rather than inline. */
export function ratchetExitCode({ ok, ran }) {
  if (!ran) return 2 // "eslint did not run" must never read as "eslint found nothing"
  return ok ? 0 : 1
}

/**
 * The freshest linted file that is NEWER than the report, or null.
 *
 * 🚨 THE FAILURE THIS EXISTS FOR. The checks above catch a report that is
 * MISSING, unparseable or EMPTY. None of them catches the one that actually
 * happened: a report that is complete, parseable, and describes a DIFFERENT
 * TREE. `npm run lint:ratchet` used to invoke the comparison alone against a
 * fixed /tmp path, so a report left by an earlier run was read as a measurement
 * of the current one — it printed "717 = baseline" across four consecutive
 * pushes while CI, which regenerates the report first, saw 719 and failed every
 * one of them. A green local instrument and a red CI job, from the same script.
 *
 * A reading taken before its subject changed is not a reading.
 *
 * `slackMs` exists because checkout steps and some filesystems stamp coarse
 * mtimes; it is a tolerance, not a grace period for real edits.
 */
export function findStaleness({ reportMtimeMs, linted, slackMs = 1000 }) {
  let worst = null
  for (const { path, mtimeMs } of linted ?? []) {
    const laterByMs = mtimeMs - reportMtimeMs
    if (laterByMs <= slackMs) continue
    if (!worst || laterByMs > worst.laterByMs) worst = { path, laterByMs }
  }
  return worst
}

function arg(name) {
  const i = process.argv.indexOf(name)
  return i === -1 ? null : process.argv[i + 1]
}

async function main() {
  const reportPath = arg("--report")
  if (!reportPath || !existsSync(reportPath)) {
    console.error(`config: --report <eslint json> is required (got ${reportPath ?? "nothing"}).`)
    process.exit(2)
  }
  let report
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"))
  } catch (e) {
    console.error(`::error::could not parse ${reportPath}: ${e.message} — this run measured nothing.`)
    process.exit(2)
  }
  if (!Array.isArray(report) || report.length === 0) {
    console.error(`::error::${reportPath} lists no files. eslint did not run; refusing to report an all-clear.`)
    process.exit(2)
  }

  // 🚨 STALENESS. The two checks above catch a report that is MISSING, unparseable
  // or empty. They do not catch the failure that actually happened: a report that
  // is complete, parseable and describes a DIFFERENT TREE. `npm run lint:ratchet`
  // used to invoke this script alone against a fixed /tmp path, so a report left
  // behind by an earlier run was read as a measurement of the current one — it
  // reported "717 = baseline" four times across four pushes while CI, which
  // regenerates the report first, saw 719 and failed every one of them.
  //
  // A reading taken before its subject changed is not a reading. If any file the
  // report claims to have linted is newer than the report itself, this run
  // measured the past.
  const stale = findStaleness({
    reportMtimeMs: statSync(reportPath).mtimeMs,
    linted: report.map((f) => f?.filePath).filter((p) => typeof p === "string" && existsSync(p))
      .map((p) => ({ path: p, mtimeMs: statSync(p).mtimeMs })),
  })
  if (stale) {
    console.error(
      `::error::${reportPath} is STALE — ${stale.path} was modified ${Math.round(stale.laterByMs / 1000)}s ` +
        `after the report was written. Regenerate it (npx eslint . --format json -o ${reportPath}) before ` +
        `comparing; this run would have measured a tree that no longer exists.`,
    )
    process.exit(2)
  }

  const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  const { counts, filesLinted, suppressionsWithNothingToSuppress } = countByRule(report, base.excludedRules)

  if (process.argv.includes("--write")) {
    const sorted = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]))
    writeFileSync(BASELINE_PATH, JSON.stringify({ ...base, measuredAt: new Date().toISOString().slice(0, 10), counts: sorted }, null, 2) + "\n")
    console.log(`re-baselined: ${Object.keys(sorted).length} rules, ${Object.values(sorted).reduce((a, b) => a + b, 0)} violations`)
    return
  }

  const result = compareToBaseline({ counts, baseline: base.counts })
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const baseTotal = Object.values(base.counts).reduce((a, b) => a + b, 0)

  console.log(
    `eslint ratchet — ${filesLinted} files, ${total} violations across ${Object.keys(counts).length} rules ` +
      `(baseline ${baseTotal}); excluding ${base.excludedRules.join(", ")}`,
  )
  if (suppressionsWithNothingToSuppress > 0) {
    console.log(`  note: ${suppressionsWithNothingToSuppress} eslint-disable directive(s) suppress nothing`)
  }

  for (const g of result.grew) {
    console.error(`::error::${g.rule} grew ${g.was} -> ${g.now}. Fix the new one, or re-baseline deliberately.`)
  }
  for (const a of result.appeared) {
    console.error(
      `::error::${a.rule} is not in the baseline and now has ${a.now}. A NEW rule must be a decision, not a silent pass.`,
    )
  }
  for (const e of result.emptied) {
    console.log(`  ✓ ${e.rule} reached zero (was ${e.was}) — delete its baseline entry so the file stops describing the past`)
  }
  if (result.ok && total < baseTotal) {
    console.log(`\n${baseTotal - total} fewer than baseline. Re-baseline with --write to lock the gain in.`)
  }

  process.exitCode = ratchetExitCode({ ok: result.ok, ran: true })
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    console.error(`unexpected: ${e.message}`)
    process.exit(2)
  })
}
