import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import path from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// A `.gitignore` RULE MUST NOT BE ABLE TO SWALLOW A FILE UNDER `docs/`.
//
// ⭐ THE INCIDENT, 2026-09-03. A session could not run its verification gate, so
// it parked an unverified change as `docs/overnight/handoffs/<name>.patch`,
// wrote a README pointing at it, wrote a ledger entry saying *"the patch is
// committed"*, ran `git add -A`, saw a clean `git status`, and pushed. `*.patch`
// swallowed the file: the commit carried only the README. The next session
// followed the pointer and found a promise.
//
// 🚨 THE PART THAT MAKES THIS A GUARD RATHER THAN A NOTE: `git add` does not
// report what an ignore rule skipped, and a clean `git status` afterwards is
// CONSISTENT with the file having been added. **The two observations a writer
// naturally makes cannot tell the two outcomes apart** — so "check more
// carefully" is not an available fix.
//
// ⚠ AND `git status --ignored` IS THE WRONG INSTRUMENT, which is worth stating
// because it is the obvious one. It lists ignored files that exist ON DISK; a CI
// checkout has none, because they were never committed. A guard built on it
// would read zero forever and catch nothing — the vacuous-pass shape this repo
// records for a staged-only check that "inspected nothing on a CI checkout and
// exited 0". So this asks about the RULES, by creating a file and asking git
// whether it would take it.
//
// ⭐ `*.patch` WAS NOT THE ONLY TRAP. Measured the same day, all of these would
// have been swallowed under `docs/`: `logs/` (the whole directory), `imports/`,
// `sweep-*.log`, `*.pem`, `*creds*.json`.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd()

/** Would `git add` take this path, or is an ignore rule hiding it? */
function isAddable(rel: string): boolean {
  const abs = path.join(ROOT, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, "probe\n")
  try {
    // ⚠ `git add --dry-run` rather than `git check-ignore`, deliberately. With a
    // negation in play, `check-ignore` exits 0 for BOTH "ignored" and "matched a
    // `!` rule", and telling them apart means parsing `-v` output for a leading
    // `!`. `--dry-run` answers the question actually being asked: would this file
    // make it into a commit?
    execFileSync("git", ["add", "--dry-run", "--", rel], { cwd: ROOT, stdio: "pipe" })
    return true
  } catch {
    return false
  } finally {
    // The probe never reaches the index (`--dry-run`), so removing the file is
    // the whole cleanup.
    rmSync(abs, { force: true })
    const dir = path.dirname(abs)
    if (dir !== path.join(ROOT, "docs")) rmSync(dir, { recursive: true, force: true })
  }
}

describe("a .gitignore rule cannot silently swallow a file under docs/", () => {
  it("is not vacuous — the probe can still see a file being IGNORED", () => {
    // ⚠ The control that makes every case below mean something. If the probe
    // reported "addable" for everything — a broken exec, a changed flag, a git
    // that no longer errors — the whole file would pass while asserting nothing.
    // `*.patch` OUTSIDE docs/ must still be ignored, which also pins that this
    // fix did not simply delete the rule.
    expect(isAddable("tmp-gitignore-probe/probe.patch")).toBe(false)
  })

  it("takes the extension that caused the incident", () => {
    expect(isAddable("docs/tmp-gitignore-probe.patch")).toBe(true)
  })

  it("takes the FIVE other patterns that were live traps, not just that one", () => {
    // Asserted individually rather than in a loop so a failure names the rule.
    // ⚠ `.txt`, NOT `.md`, and the extension is not the point of these two — the
    // DIRECTORY pattern is. `__tests__/live-docs-md-links-resolve.test.ts` walks
    // every `docs/**/*.md` and reads each one, vitest runs test files in parallel
    // workers, and a probe that appears and vanishes mid-walk is an `ENOENT`
    // between its `readdirSync` and its `readFileSync` — an intermittent red with
    // no cause in either file. Exactly the wall-clock-dependent failure class
    // fixed for `edge-deno` earlier today; not worth reintroducing to save a
    // three-character rename.
    expect(isAddable("docs/tmp-gitignore-probe/logs/x.txt"), "logs/").toBe(true)
    expect(isAddable("docs/tmp-gitignore-probe/imports/y.txt"), "imports/").toBe(true)
    expect(isAddable("docs/tmp-gitignore-probe-sweep-1.log"), "sweep-*.log").toBe(true)
    expect(isAddable("docs/tmp-gitignore-probe.tsbuildinfo"), "*.tsbuildinfo").toBe(true)
    expect(isAddable("docs/tmp-gitignore-probe/npm-debug.log"), "npm-debug.log*").toBe(true)
  })

  it("⛔ but SECRETS stay ignored under docs/ — the negation must not widen that surface", () => {
    // ⚠ THE HALF THAT MAKES THE FIX SAFE, and the reason `.gitignore` re-asserts
    // these AFTER the negation. A blanket `!docs/**` would make an `.env.local`,
    // a `*creds*.json` or a `*.pem` dropped into docs/ committable. This repo has
    // already paid for a credential leak once — the 2026-08-03 `filter-repo`
    // purge — so a convenience rule must not quietly re-open that.
    expect(isAddable("docs/tmp-gitignore-probe/.env.local"), ".env*.local").toBe(false)
    expect(isAddable("docs/tmp-gitignore-probe-creds.json"), "*-creds.json").toBe(false)
    expect(isAddable("docs/tmp-gitignore-probe/x-creds.json"), "*creds*.json").toBe(false)
    expect(isAddable("docs/tmp-gitignore-probe.pem"), "*.pem").toBe(false)
  })

  it("the docs negation is ORDERED so the secret re-assertion wins", () => {
    // ⚠ A negation only overrides patterns ABOVE it, so this is a property of
    // ORDER, not of presence — and the two behavioural cases above cannot say
    // WHY they hold, which makes a reordering look like an unrelated failure.
    // Pinned as the position it depends on, in the file where it lives.
    const lines = readFileSync(path.join(ROOT, ".gitignore"), "utf8").split("\n")
    const negation = lines.findIndex((l: string) => l.trim() === "!docs/**")
    expect(negation, "the !docs/** negation is gone").toBeGreaterThan(-1)
    for (const secret of [".env*.local", "*creds*.json", "*-creds.json", "*.pem"]) {
      const last = lines.map((l: string) => l.trim()).lastIndexOf(secret)
      expect(last, `${secret} is not in .gitignore at all`).toBeGreaterThan(-1)
      expect(
        last,
        `${secret} must appear AFTER the !docs/** negation or it stops applying under docs/`,
      ).toBeGreaterThan(negation)
    }
  })

  it("the overnight-pass lock stays ignored under docs/ — a committed lock reads as HELD", () => {
    // ⚠ The negation un-ignored `docs/overnight/.lock` the day it landed: a RELEASED
    // lock surfaced as untracked on 2026-09-03, one `git add -A` from being committed.
    // The night pass treats a present lock as another run in progress, so a committed
    // one would block every future pass until someone noticed. Pinned by ORDER, like
    // the secrets above, and NOT by the `isAddable` probe: that probe WRITES and then
    // DELETES its path, and this path is a live file on any box mid-pass.
    const lines = readFileSync(path.join(ROOT, ".gitignore"), "utf8").split("\n")
    const negation = lines.findIndex((l: string) => l.trim() === "!docs/**")
    const last = lines.map((l: string) => l.trim()).lastIndexOf("docs/overnight/.lock")
    expect(last, "docs/overnight/.lock is not in .gitignore at all").toBeGreaterThan(-1)
    expect(last, "docs/overnight/.lock must be re-asserted AFTER !docs/**").toBeGreaterThan(negation)
  })
})
