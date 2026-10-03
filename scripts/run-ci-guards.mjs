#!/usr/bin/env node
// Run the TypeScript-job guards from .github/workflows/ci.yml locally, in
// order, and say what ran. `npm run ci:guards`.
//
// Why this exists (2026-10-03): tsc 0, vitest green and lint:ratchet at
// baseline all passed locally and `main` still went red for ~20 minutes on
// `check-brand-tokens` (two recharts strokes in a chart) — the SAME way it
// went red twice on 09-2x on `check-unbounded-server-reads`
// (docs/reference/testing-and-ci.md). The guards are cheap (seconds); the
// red is not. A node driver, not a `;`-chained npm script, because the latter
// dies in cmd.exe.
//
// ⚠ This list MUST match the `run:` steps of the CI job. The test
// `__tests__/ci-guards-script-matches-the-workflow.test.ts` pins that.
import { spawnSync } from "node:child_process"

export const CI_GUARDS = [
  "check-brand-tokens",
  "check-driver-message-leaks",
  "check-unhandled-third-state",
  "check-responsive-flex-basis",
  "check-unbounded-server-reads",
  "check-lane-egress",
]

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  let failed = 0
  for (const g of CI_GUARDS) {
    const r = spawnSync(process.execPath, [`scripts/${g}.mjs`], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" })
    const ok = r.status === 0
    if (!ok) failed++
    const tail = ((r.stdout || "") + (r.stderr || "")).trim().split("\n").slice(-3).join("\n  ")
    console.log(`${ok ? "✓" : "✗"} ${g} (exit ${r.status})${ok ? "" : `\n  ${tail}`}`)
  }
  console.log(`ci:guards — ${CI_GUARDS.length} guards ran, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}
