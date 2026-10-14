#!/usr/bin/env node
/**
 * scripts/preflight.mjs — run the CI gates a change can red, BEFORE the push.
 *
 *   npm run preflight            changed paths vs origin/main (+ uncommitted)
 *   npm run preflight -- --full  also the primary coverage ratchet (~10 min)
 *   npm run preflight -- --dry   print the plan, run nothing
 *   npm run preflight -- --quick ci:guards + vitest related only (< ~1 min)
 *
 * `.githooks/pre-push` runs `--quick` (bypass once: `git push --no-verify`, or
 * RPC_SKIP_PREFLIGHT=1). ⚠ QUICK ON PUSH, ON PURPOSE: agent sessions run
 * `git push` under a ~2 min command timeout, and a 5-min coverage run inside the
 * hook would be killed mid-push for every concurrent writer. Quick mode NAMES
 * the slow gates the change selects instead of running them.
 *
 * ── WHY (2026-10-12) ────────────────────────────────────────────────────────
 * The longest red on `main` in the 10-10 → 10-12 window was 3 h 14 m (10-11,
 * 11:47 AM → 3:01 PM PT): component coverage 90.81 % against a 90.85 % gate.
 * Seven code pushes landed on it, each session seeing its own tsc / vitest /
 * lint green and reading the red X as somebody else's. The documented remedy —
 * "run `npm run test:coverage:components` before pushing a component change" —
 * was a sentence in testing-and-ci.md, i.e. a convention nothing ran. This runs
 * it, and the other gates, selected by what changed:
 *
 *   docs-only (every path under docs/ or *.md — CI's own `changes` rule)
 *                       → nothing heavy; CI runs only the docs guards either
 *   any code            → tsc (3 GB heap), `ci:guards`, `lint:ratchet`,
 *                         `vitest related` over the changed sources + changed tests
 *   components/**, a non-route .tsx, or a *.test.tsx
 *                       → `test:coverage:components` (the 10-11 gate, ~5 min)
 *   workers/** or a worker test → `test:coverage:workers`
 *   --full              → `test:coverage` (the primary ratchet)
 *
 * Plus two DERIVED test selections (2026-10-13 — both reds on `main` that
 * morning were tree-walking guards, `no-credential-literals-in-tracked-files`
 * and `insights-client-dates-are-hydration-safe-guard`, which `vitest related`
 * cannot see because they READ files instead of importing them):
 *   - tests whose source NAMES a changed path   → quick AND full (cheap)
 *   - every tree-walking guard (readdirSync / ls-files / walk(), ~140 files,
 *     ~90 s)                                    → full only; quick names it
 *
 * ⚠ It is a FIRST signal, not the gate. CI stays authoritative; `vitest related`
 * cannot see a test that reads a file through `readFileSync` rather than an
 * import (the guard tests do that a lot), which is why `--full` exists.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

/** PURE. CI's docs-only rule (`.github/workflows/ci.yml`, job `changes`). */
export function isDocsPath(p) {
  return /^docs\//.test(p) || /\.(md|mdx)$/.test(p)
}

/** PURE. Which gates a changed-path list selects. */
export function planFor(paths, { full = false, quick = false } = {}) {
  const code = paths.filter((p) => !isDocsPath(p))
  const isCode = code.length > 0
  const components = code.some(
    (p) =>
      p.startsWith("components/") ||
      /\.test\.tsx$/.test(p) ||
      (/\.tsx$/.test(p) && !/(^|\/)route\.tsx$/.test(p) && !p.startsWith("__tests__/")),
  )
  const workers = code.some((p) => p.startsWith("workers/") || /^__tests__\/worker-.*\.test\.ts$/.test(p))
  const related = code.filter((p) => /\.(ts|tsx|mjs|js)$/.test(p) && !p.startsWith("e2e/"))
  return {
    isCode,
    quick,
    tsc: isCode && !quick,
    guards: isCode,
    lint: isCode && !quick,
    related,
    components,
    workers,
    full: isCode && full && !quick,
  }
}

/** PURE. Does a test file's source walk the tree (and so see files it never imports)? */
export function isTreeWalkingTest(src) {
  return /readdirSync|ls-files|\bwalk\(/.test(src)
}

/** PURE. Test files whose source names one of the changed (non-test) paths. */
export function testsNamingPaths(tests, paths) {
  const subjects = paths.filter((p) => !p.startsWith("__tests__/") && !isDocsPath(p))
  if (!subjects.length) return []
  return tests.filter(({ src }) => subjects.some((p) => src.includes(p))).map(({ file }) => file)
}

function readTests() {
  return readdirSync("__tests__")
    .filter((f) => /\.test\.tsx?$/.test(f))
    .map((f) => ({ file: `__tests__/${f}`, src: readFileSync(`__tests__/${f}`, "utf8") }))
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
}

/** Paths changed vs the merge-base with origin/main, plus uncommitted and untracked. */
export function changedPaths() {
  let base
  try {
    base = git(["merge-base", "HEAD", "origin/main"])
  } catch {
    base = "HEAD"
  }
  const lines = [
    ...git(["diff", "--name-only", base]).split("\n"),
    ...git(["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ]
  return [...new Set(lines.filter(Boolean))]
}

function step(label, cmd, args, env = {}) {
  const t = Date.now()
  console.log(`\n▶ ${label}`)
  const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env }, shell: process.platform === "win32" })
  const s = ((Date.now() - t) / 1000).toFixed(0)
  const ok = r.status === 0
  console.log(`${ok ? "✓" : "✗"} ${label} (${s}s, exit ${r.status})`)
  return { label, ok, s }
}

function main() {
  const full = process.argv.includes("--full")
  const dry = process.argv.includes("--dry")
  const quick = process.argv.includes("--quick")
  const paths = changedPaths()
  const plan = planFor(paths, { full, quick })
  console.log(`preflight: ${paths.length} changed path(s); ${plan.isCode ? "CODE" : "docs-only"}`)
  if (!plan.isCode) {
    console.log("docs-only change — CI runs only the docs guards (the pre-commit hook covers the fast ones). Nothing heavy to run.")
    return
  }
  const npx = process.platform === "win32" ? "npx.cmd" : "npx"
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"
  const steps = []
  if (plan.tsc) steps.push(["tsc --noEmit", npx, ["tsc", "--noEmit"], { NODE_OPTIONS: "--max-old-space-size=3072" }])
  steps.push(["ci:guards", npm, ["run", "-s", "ci:guards"]])
  if (plan.lint) steps.push(["lint:ratchet", npm, ["run", "-s", "lint:ratchet"]])
  if (plan.related.length) steps.push([`vitest related (${plan.related.length} path(s))`, npx, ["vitest", "related", "--run", "--passWithNoTests", ...plan.related]])
  const tests = readTests()
  const named = testsNamingPaths(tests, paths)
  if (named.length) steps.push([`tests that name a changed path (${named.length})`, npx, ["vitest", "run", "--passWithNoTests", ...named]])
  const walkers = tests.filter((t) => isTreeWalkingTest(t.src)).map((t) => t.file)
  const skippedSlow = []
  ;(quick ? skippedSlow : steps).push([`tree-walking guards (${walkers.length})`, npx, ["vitest", "run", ...walkers]])
  if (plan.components) (quick ? skippedSlow : steps).push(["component coverage gate", npm, ["run", "-s", "test:coverage:components"]])
  if (plan.workers) (quick ? skippedSlow : steps).push(["worker coverage gate", npm, ["run", "-s", "test:coverage:workers"]])
  if (plan.full) steps.push(["primary coverage gate", npm, ["run", "-s", "test:coverage"]])

  console.log("plan:\n" + steps.map(([l]) => `  - ${l}`).join("\n"))
  if (quick) {
    console.log("  (quick: tsc + lint:ratchet skipped)")
    for (const [l] of skippedSlow) console.log(`  ⚠ NOT RUN, and this change selects it: ${l} — run \`npm run preflight\` before relying on CI`)
  } else if (!plan.full) console.log("  (primary coverage ratchet skipped — CI runs it; add --full to run it here)")
  if (dry) return

  // ⚠ Run EVERY step even after a failure: one red step hiding the next is how
  // the six guards behind `tsc` went unseen on CI (testing-and-ci.md).
  const results = steps.map(([l, c, a, e]) => step(l, c, a, e))
  const bad = results.filter((r) => !r.ok)
  console.log(`\npreflight — ${results.length} step(s) ran, ${bad.length} failed`)
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.label} (${r.s}s)`)
  process.exit(bad.length ? 1 : 0)
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) main()
