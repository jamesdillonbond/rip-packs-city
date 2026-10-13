#!/usr/bin/env node
/**
 * scripts/pre-commit-check.mjs — the fast, LOCAL half of the docs guards.
 *
 * Run by `.githooks/pre-commit` (activate: `git config core.hooksPath .githooks`;
 * the web SessionStart hook does it for you). Bypass once: `git commit --no-verify`.
 *
 * ── WHY (2026-10-12) ────────────────────────────────────────────────────────
 * 7 of the 17 non-inherited CI failures on `main` from 10-10 → 10-12 were PROCESS
 * slips, not code: committed conflict markers (2), stale generated indexes (3),
 * a ledger heading edited in place (1) — each found by CI minutes after the push,
 * on a branch other sessions were pushing to. Every one is decidable from the
 * STAGED tree in well under a second, so it is checked here, before the commit
 * exists. CI keeps its own copies of every check; this only moves the first
 * signal earlier.
 *
 * What runs, keyed on what is staged:
 *   any text file           → no unresolved conflict markers (staged content)
 *   docs/overnight/ledger.md → no heading DROPPED vs HEAD (an in-place heading
 *                              edit reads as a drop to CI's ledger-guard), no
 *                              swallowed heading, no future-dated heading
 *   docs/reference/known-issues.md → `gen-known-issues-index.mjs --check`
 *   docs/overnight/inbox/**  → `fix-inbox-index-counts.mjs --check`
 *   docs/audits/deep-audit-register.md → `check-register-integrity.mjs --before <HEAD>`
 *
 * ⚠ The index/register checkers read the WORKING TREE. If such a file has
 * unstaged edits the result describes the working tree, and this says so.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

export const LEDGER = "docs/overnight/ledger.md"
export const KNOWN_ISSUES = "docs/reference/known-issues.md"
export const INBOX_PREFIX = "docs/overnight/inbox/"
export const REGISTER = "docs/audits/deep-audit-register.md"

const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|pdf|zip|gz|mp4|webm|wasm)$/i

/** PURE. Line numbers of unresolved conflict markers (same regexes as no-conflict-markers-on-main). */
export function findConflictMarkers(text) {
  const out = []
  String(text)
    .split("\n")
    .forEach((l, i) => {
      if (/^<<<<<<< \S/.test(l) || /^>>>>>>> \S/.test(l)) out.push(i + 1)
    })
  return out
}

/** PURE. Ledger `^### ` headings present in `before` and absent from `after`. */
export function droppedLedgerHeadings(before, after) {
  const heads = (s) => new Set(String(s).split("\n").filter((l) => l.startsWith("### ")))
  const a = heads(after)
  return [...heads(before)].filter((h) => !a.has(h))
}

/** PURE. Which keyed checks a staged path list triggers. */
export function selectChecks(paths) {
  return {
    ledger: paths.includes(LEDGER),
    knownIssues: paths.includes(KNOWN_ISSUES),
    inbox: paths.some((p) => p.startsWith(INBOX_PREFIX)),
    register: paths.includes(REGISTER),
  }
}

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts })
}

function staged(path) {
  return git(["show", `:${path}`])
}

function headVersion(path) {
  try {
    return git(["show", `HEAD:${path}`], { stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    return null // new file, or no HEAD yet
  }
}

function hasUnstagedEdits(path) {
  return spawnSync("git", ["diff", "--quiet", "--", path]).status === 1
}

function run(label, cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" })
  return { label, ok: r.status === 0, out: ((r.stdout || "") + (r.stderr || "")).trim() }
}

function main() {
  const paths = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]).split("\0").filter(Boolean)
  const failures = []
  const ran = []

  // 1) Conflict markers in every staged text file.
  let scanned = 0
  for (const p of paths) {
    if (BINARY.test(p)) continue
    scanned++
    const lines = findConflictMarkers(staged(p))
    if (lines.length) failures.push(`${p}: unresolved conflict marker(s) at line ${lines.slice(0, 5).join(", ")}`)
  }
  ran.push(`conflict markers (${scanned} staged file(s))`)

  const want = selectChecks(paths)
  const tmp = mkdtempSync(join(tmpdir(), "rpc-precommit-"))
  try {
    if (want.ledger) {
      const after = staged(LEDGER)
      const before = headVersion(LEDGER)
      if (before !== null && process.env.RPC_LEDGER_ROLL !== "1") {
        const dropped = droppedLedgerHeadings(before, after)
        for (const h of dropped.slice(0, 5)) {
          failures.push(
            `${LEDGER}: heading gone vs HEAD (an in-place edit of a heading reads as a deletion to CI's ledger-guard): ${h.slice(0, 120)}`,
          )
        }
        if (dropped.length > 5) failures.push(`${LEDGER}: …and ${dropped.length - 5} more dropped heading(s)`)
      }
      const f = join(tmp, "ledger.md")
      writeFileSync(f, after)
      const sw = run("swallowed ledger headings", "awk", ["-f", "scripts/find-swallowed-ledger-headings.awk", f])
      if (!sw.ok || sw.out !== "0") failures.push(`${LEDGER}: swallowed heading(s) — run \`awk -v show=1 -f scripts/find-swallowed-ledger-headings.awk ${LEDGER}\` (got ${sw.out})`)
      const fd = run("future-dated ledger headings", process.execPath, ["scripts/find-future-dated-ledger-headings.mjs", f])
      if (!fd.ok || fd.out !== "0") failures.push(`${LEDGER}: future-dated heading(s) (dates are PT) — got ${fd.out}`)
      ran.push("ledger (dropped / swallowed / future-dated)")
    }

    const workingTreeCheck = (label, path, cmd, args) => {
      const r = run(label, cmd, args)
      ran.push(label + (hasUnstagedEdits(path) ? " ⚠ read the WORKING TREE, which has unstaged edits" : ""))
      if (!r.ok) failures.push(`${label}:\n    ${r.out.split("\n").slice(-6).join("\n    ")}`)
    }
    if (want.knownIssues) {
      workingTreeCheck("known-issues index", KNOWN_ISSUES, process.execPath, ["scripts/gen-known-issues-index.mjs", "--check"])
    }
    if (want.inbox) {
      workingTreeCheck("inbox INDEX counts", `${INBOX_PREFIX}INDEX.md`, process.execPath, ["scripts/fix-inbox-index-counts.mjs", "--check"])
    }
    if (want.register) {
      const before = headVersion(REGISTER)
      const args = ["scripts/check-register-integrity.mjs"]
      if (before !== null) {
        const f = join(tmp, "register-before.md")
        writeFileSync(f, before)
        args.push("--before", f)
      }
      workingTreeCheck("register integrity", REGISTER, process.execPath, args)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  console.log(`pre-commit: ran ${ran.join("; ")}`)
  if (failures.length) {
    console.error(`\n✗ pre-commit: ${failures.length} problem(s) — CI would red on these:\n`)
    for (const f of failures) console.error(`  • ${f}`)
    console.error(
      `\n  Fix and re-stage. A deliberate ledger archival roll: RPC_LEDGER_ROLL=1 git commit … ` +
        `(and put [ledger-roll] in the message for CI). Bypass once: git commit --no-verify.`,
    )
    process.exit(1)
  }
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) main()
