#!/usr/bin/env node
// scripts/run-lint-ratchet.mjs
//
// Generate the eslint report, THEN compare it against the ratchet baseline —
// as one Node process, with no shell doing the sequencing.
//
// ── WHY THIS EXISTS: `npm run lint:ratchet` WAS A NO-OP ON WINDOWS ─────────
// The script used to be a shell chain:
//
//   npx eslint . --format json -o /tmp/eslint-report.json || true; node scripts/check-eslint-ratchet.mjs --report /tmp/eslint-report.json
//
// npm runs scripts through **cmd.exe** on Windows (`script-shell` unset), and
// ⛔ **cmd.exe does not treat `;` as a command separator.** Measured 2026-09-14
// on the dev box, decisively:
//
//   · `npm run lint:ratchet` CREATED C:\tmp\eslint-report.json (so eslint ran)
//   · printed NOTHING from the checker, and exited 0
//   · run directly, the checker prints `eslint ratchet — 3072 files, 715 violations…`
//
// eslint exits **1** whenever violations exist (715 do), so the `|| true…` arm
// runs — and `true` resolves to Git-for-Windows' `true.exe`, which swallows
// `; node scripts/check-eslint-ratchet.mjs --report …` as ARGUMENTS and exits 0.
// **The comparison never executed.** The gate CLAUDE.md names as the one that
// reds while `npm test` and `tsc` pass was, on the only push-capable box, a
// command that always exits 0 having measured nothing.
//
// ⚠ The existing runner test asserted the npm script's TEXT — that it contains
// `eslint … -o` before `check-eslint-ratchet.mjs`. Both were present. It passed
// throughout. **Pin the property, not the spelling**: a string can hold the right
// words in the right order and still not run.
//
// ── AND THE SECOND BUG THE SHELL CHAIN HID: `/tmp` IS TWO DIRECTORIES ──────
// A literal `/tmp/...` resolves to `C:\tmp` for a Windows process and to
// `C:\Users\<user>\AppData\Local\Temp` when MSYS/Git Bash rewrites it. Both
// files existed on the box, **15 hours apart**, so which report got compared
// depended on which shell typed the path. `os.tmpdir()` removes the ambiguity.
// (This is the same class as the 2026-09-02 stale-report incident in
// `docs/reference/testing-and-ci.md`, which a fixed `/tmp` path also caused.)
//
// The report path can be overridden with ESLINT_REPORT — CI passes its own.

import { spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import os from "node:os"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")
const REPORT = process.env.ESLINT_REPORT || join(os.tmpdir(), "rpc-eslint-report.json")
const ESLINT = join(ROOT, "node_modules", "eslint", "bin", "eslint.js")
const CHECKER = join(HERE, "check-eslint-ratchet.mjs")

if (!existsSync(ESLINT)) {
  console.error(`::error::eslint not found at ${ESLINT} — run \`npm ci\` first.`)
  process.exit(2)
}

// 1 · GENERATE. eslint exits 1 whenever any violation exists, which is the
// normal state here (the ratchet's whole job is to hold a non-zero count
// steady), so its exit code is deliberately not a failure signal. What the
// next step needs is that the report was WRITTEN — which is checked, rather
// than assumed, because "the command ran" is not "the artifact exists".
const generated = spawnSync(process.execPath, [ESLINT, ".", "--format", "json", "-o", REPORT], {
  cwd: ROOT,
  stdio: "inherit",
})

if (generated.error) {
  console.error(`::error::could not run eslint: ${generated.error.message}`)
  process.exit(2)
}
if (!existsSync(REPORT)) {
  console.error(
    `::error::eslint exited ${generated.status} and wrote no report at ${REPORT}. ` +
      `Refusing to compare — a missing report is not a clean tree.`,
  )
  process.exit(2)
}
if (statSync(REPORT).size === 0) {
  console.error(`::error::eslint wrote an EMPTY report at ${REPORT}. Refusing to compare.`)
  process.exit(2)
}

// 2 · COMPARE. The checker owns the verdict — including its own staleness
// refusal (exit 2) — so its exit code is propagated unchanged.
const compared = spawnSync(process.execPath, [CHECKER, "--report", REPORT, ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: "inherit",
})

if (compared.error) {
  console.error(`::error::could not run the ratchet comparison: ${compared.error.message}`)
  process.exit(2)
}

// ⚠ A null status means the child was killed by a signal; that is not a pass.
process.exit(compared.status === null ? 1 : compared.status)
