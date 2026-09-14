#!/usr/bin/env node
/**
 * scripts/check-last-code-ci-on-main.mjs
 *
 * ON A DOCS-ONLY PUSH, SAY WHETHER `main` IS ACTUALLY GREEN.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `unit-tests-shard` is gated on `needs.changes.outputs.code == 'true'`. That is
 * a sound optimisation and nothing below proposes removing it. The cost is that
 * a docs-only push renders a green check which is INDISTINGUISHABLE from "main
 * is green", while saying only "the docs guards passed".
 *
 * 🚨 Measured 2026-09-13, and it is not hypothetical:
 *
 *   #5476  3840baf  code  6m01s  FAILED  ← the red starts here
 *   #5477  8940f14  docs  1m21s  green   ← no shards ran
 *   #5478  e6a5047  docs  1m26s  green   ← no shards ran
 *   #5479  c3678d3  docs  1m41s  green   ← no shards ran
 *   #5480  eada52c  code  5m54s  FAILED  ← the next code push inherits it
 *
 * Three greens in a row over a red `main`, and NOT ONE OF THEM IS WRONG — each
 * ran exactly what it was asked to run. The red survived ~9 hours and was found
 * only because someone happened to push code. That is this repo's own "a
 * permanently-zero instrument is indistinguishable from a broken one" in its
 * CI: a check that did not run is indistinguishable from a check that passed.
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────
 * On a docs-only push to main, find the most recent COMPLETED CI run on main
 * that actually ran the unit shards, and fail if its conclusion was not
 * `success`. The docs push is not blamed for the red — the message names the
 * run and commit that IS red, so the next person sees whose it is.
 *
 * ⚠ It does NOT run on code pushes. On a code push the run itself is the
 * statement, and failing on an inherited red there would block the very commit
 * that fixes it.
 *
 * ── THE FAIL-OPEN IS NAMED, NOT SILENT ──────────────────────────────────────
 * If no completed full-suite run is found in the window, this exits 0 — there is
 * nothing to conclude and reddening every docs push over a missing history would
 * be worse than useless. It prints `verdict=unknown` loudly, and
 * `__tests__/inherited-main-status-guard.test.ts` pins the ONE failure mode that
 * would make the fail-open silent: the marker below drifting away from the job
 * name ci.yml actually produces. That test reads ci.yml and expands the matrix
 * name, so renaming the shard job reds the guard's own test instead of quietly
 * turning this into a no-op.
 */

import { appendFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

/**
 * A run "ran the full suite" iff it contains a shard job. ⚠ Pinned against
 * ci.yml by the sibling test — do not edit one without the other.
 */
export const SHARD_JOB_MARKER = "Unit tests (vitest) — shard"

export class ApiError extends Error {}

/**
 * Does this run's job list prove the full suite ACTUALLY RAN?
 *
 * 🚨 A JOB NAME IN THE LIST IS NOT EVIDENCE THAT THE JOB RAN. The Actions jobs
 * endpoint returns SKIPPED jobs too, with their real names and
 * `conclusion: "skipped"` — so a docs-only run, which skips `unit-tests-shard`
 * by design, still lists a job called "Unit tests (vitest) — shard 1/2".
 *
 * Measured 2026-09-14, in this guard's own published output: CI #5503 (a
 * docs-only push) reported **"last full-suite run: CI #5502 · 673fdc9 ·
 * success"**, and `673fdc9` is docs-only — every path under `docs/` or `*.md`,
 * shards skipped. So the guard was reporting the last run OF ANY KIND while
 * printing a reassuring green summary: **a no-op that reads as coverage**, which
 * is the exact defect it was written to prevent, one level deeper.
 *
 * ⚠ The fail-open this guard documents was "the marker drifts away from the job
 * name". That is not what happened — the marker matched perfectly. **Matching a
 * NAME was never the question; whether the job EXECUTED is.**
 *
 * @param {Array<{name?: string, conclusion?: string|null}>} jobs
 */
export function ranFullSuite(jobs) {
  return jobs.some(
    (j) =>
      typeof j?.name === "string" &&
      j.name.startsWith(SHARD_JOB_MARKER) &&
      // `skipped` is the docs-only case; a null conclusion means it never
      // concluded, which is not evidence either. Only a job that reached a
      // verdict counts as having run.
      j.conclusion != null &&
      j.conclusion !== "skipped",
  )
}

/**
 * PURE. Given candidate runs newest-first, each already normalised to
 * `{ id, status, conclusion, ranFullSuite, … }`, decide what to report.
 *
 * ⚠ `currentRunId` is excluded so this can never read its own run.
 *
 * @param {Array<{id: string|number, status: string, conclusion: string|null, ranFullSuite: boolean, runNumber?: number, headSha?: string, displayTitle?: string, htmlUrl?: string}>} runs
 * @param {{ currentRunId?: string|number|null }} [opts] — CURRENT_RUN_ID arrives
 *   from the environment as a STRING; both spellings compare correctly.
 */
export function decideInheritedStatus(runs, { currentRunId = null } = {}) {
  const considered = runs.filter(
    (r) => String(r.id) !== String(currentRunId) && r.status === "completed" && r.ranFullSuite,
  )
  const last = considered[0] ?? null
  if (!last) return { verdict: "unknown", run: null, considered: considered.length }
  if (last.conclusion === "success") return { verdict: "green", run: last, considered: considered.length }
  return { verdict: "red", run: last, considered: considered.length }
}

/** PURE. Exit code for a verdict — only `red` is a failure. */
export function inheritedExitCode(verdict) {
  return verdict === "red" ? 1 : 0
}

/** PURE. The operator-facing line. */
export function renderVerdict({ verdict, run }) {
  if (verdict === "green") {
    return `✅ main is green — last full-suite run #${run.runNumber} (${String(run.headSha).slice(0, 7)}) succeeded.`
  }
  if (verdict === "unknown") {
    return (
      "⚠ verdict=unknown — no COMPLETED full-suite CI run found on main in the window. " +
      "Not failing the push over missing history, but nothing here says main is green."
    )
  }
  return [
    `🚨 main is RED, and this docs-only push cannot see it.`,
    ``,
    `  The last run that actually executed the unit shards:`,
    `    CI #${run.runNumber}  ${String(run.headSha).slice(0, 7)}  conclusion=${run.conclusion}`,
    `    ${run.htmlUrl}`,
    `    ${run.displayTitle ?? ""}`.trimEnd(),
    ``,
    `  This push is NOT the cause and reverting it will not help. A docs-only push`,
    `  skips \`unit-tests-shard\` by design, so its green check means "the docs guards`,
    `  passed", never "main is green". Fix the run above, or revert its commit.`,
  ].join("\n")
}

export const DEFAULT_API_BASE = "https://api.github.com"

/**
 * PURE. The GitHub **job summary** for this verdict.
 *
 * 🚨 WHY THIS EXISTS AND IS NOT DECORATION. A job's step LOG is only readable by
 * someone with admin rights on the repo — measured 2026-09-14, the API answers
 * `403 Must have admin rights to Repository` and the web log endpoints 404. So on
 * the first live run of this guard, the only observable facts were "the job ran"
 * and "it exited 0" — and `green` and `unknown` BOTH exit 0. **The one distinction
 * this guard exists to make was invisible in its own output.** That is the thread's
 * own lesson (a check that did not run looks like one that passed) reappearing one
 * layer out: a check whose RESULT cannot be read is a check nobody can act on.
 * A job summary renders on the run page for anyone who can see the run.
 */
export function renderSummary({ verdict, run, considered }) {
  const head = { green: "\u2705 `main` is green", unknown: "\u26a0\ufe0f verdict unknown", red: "\uD83D\uDEA8 `main` is RED" }[verdict]
  const lines = [`### Inherited \`main\` status: \`${verdict}\``, "", head, ""]
  if (run) {
    lines.push(
      `| last full-suite run | commit | conclusion |`,
      `|---|---|---|`,
      `| [CI #${run.runNumber}](${run.htmlUrl}) | \`${String(run.headSha).slice(0, 7)}\` | \`${run.conclusion}\` |`,
      "",
    )
  }
  if (verdict === "unknown") {
    lines.push(
      "No COMPLETED full-suite run was found, so this push is **not** failed over missing history.",
      "\u26a0\ufe0f If this repeats, suspect `SHARD_JOB_MARKER` drift or the `actions: read` permission \u2014 not the history.",
      "",
    )
  }
  if (verdict === "red") {
    lines.push(
      "**This docs-only push is not the cause and reverting it will not help** \u2014 it skips",
      "`unit-tests-shard` by design, so its green check means \"the docs guards passed\".",
      "",
    )
  }
  lines.push(`_examined ${considered ?? 0} completed run(s)_`)
  return lines.join("\n")
}

async function api(path, token, apiBase = DEFAULT_API_BASE) {
  const res = await fetch(`${apiBase}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })
  if (!res.ok) throw new ApiError(`GET ${path} -> ${res.status} ${res.statusText}`)
  return res.json()
}

/**
 * Walk runs newest-first, resolving `ranFullSuite` only until one is found.
 *
 * ⚠ The early `break` is what bounds the cost: the jobs endpoint is one request
 * PER RUN, so without it a quiet week of docs pushes would cost 15 requests on
 * every push. In practice the newest or second-newest run is a code run and this
 * makes two. The sibling test pins the break against a counting fake server —
 * losing it would not fail any fixture test, only the bill.
 *
 * @param {{repo: string, token: string, currentRunId?: string|number|null, maxRuns?: number, apiBase?: string}} opts
 */
export async function fetchCandidates({ repo, token, currentRunId, maxRuns = 15, apiBase = DEFAULT_API_BASE }) {
  const { workflow_runs: runs = [] } = await api(
    `/repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=${maxRuns}`,
    token,
    apiBase,
  )
  const out = []
  for (const r of runs) {
    if (String(r.id) === String(currentRunId)) continue
    const { jobs = [] } = await api(`/repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`, token, apiBase)
    const full = ranFullSuite(jobs)
    out.push({
      id: r.id,
      runNumber: r.run_number,
      status: r.status,
      conclusion: r.conclusion,
      headSha: r.head_sha,
      displayTitle: r.display_title,
      htmlUrl: r.html_url,
      ranFullSuite: full,
    })
    if (full) break // newest full-suite run found; nothing older can outrank it
  }
  return out
}

/** Best-effort: a summary that cannot be written must never change the verdict. */
function writeSummary(md) {
  const f = process.env.GITHUB_STEP_SUMMARY
  if (!f) return
  try {
    appendFileSync(f, md + "\n")
  } catch (e) {
    console.log(`\u26a0 could not write the job summary (verdict is unaffected): ${e.message}`)
  }
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY
  const token = process.env.GITHUB_TOKEN
  const currentRunId = process.env.CURRENT_RUN_ID || null
  if (!repo || !token) {
    // ⚠ Every exit writes a summary, including this one. A run that produced NO
    // summary is the invisible case this whole guard is about.
    console.log("⚠ verdict=unknown — GITHUB_REPOSITORY/GITHUB_TOKEN not set; nothing to check.")
    writeSummary(renderSummary({ verdict: "unknown", run: null, considered: 0 }))
    process.exit(0)
  }
  let candidates
  try {
    candidates = await fetchCandidates({ repo, token, currentRunId })
  } catch (e) {
    // ⚠ An API failure is NOT evidence that main is red. Say so and pass.
    console.log(`⚠ verdict=unknown — could not read run history: ${e.message}`)
    writeSummary(renderSummary({ verdict: "unknown", run: null, considered: 0 }))
    process.exit(0)
  }
  const result = decideInheritedStatus(candidates, { currentRunId })
  console.log(`verdict=${result.verdict} (examined ${candidates.length} run(s))`)
  console.log(renderVerdict(result))
  writeSummary(renderSummary({ ...result, considered: candidates.length }))
  process.exit(inheritedExitCode(result.verdict))
}

// ⚠ `pathToFileURL`, NOT a string-concatenated file URL around argv[1].
// `import.meta.url` is a URL and argv[1] is an OS path: they line up on POSIX and
// NEVER on Windows, where main() then silently does not run and the process exits 0.
// Banned at zero by __tests__/scripts-main-module-guard-works-on-windows.test.ts —
// and that guard greps RAW source, so this note must not spell the banned form out.
if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
