import { describe, it, expect } from "vitest"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// scripts/resolve-ledger-rebase-conflict.mjs refused EVERY correct top splice once
// the ledger's newest entries became STACKED (heading directly under the previous
// entry, no blank between): moving upstream's first heading off its blank line read
// as a NEW blank-line defect (2026-10-18 ~1:15 PM PT — the entry was spliced by hand).
// These tests drive the script through a REAL rebase conflict in a throwaway repo, in
// both layouts, and assert the merged file — not the exit code alone.

const script = join(__dirname, "..", "scripts", "resolve-ledger-rebase-conflict.mjs")
const HEADER = "# Ledger\n\n> header\n\n"

function conflictRepo(base: string, up: string, mine: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ledger-resolver-"))
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_EDITOR: "true" } })
  git("init", "-q", "-b", "main")
  git("config", "user.email", "t@t")
  git("config", "user.name", "t")
  git("config", "commit.gpgsign", "false")
  writeFileSync(join(dir, "ledger.md"), base)
  git("add", ".")
  git("commit", "-qm", "base")
  git("checkout", "-qb", "mine")
  writeFileSync(join(dir, "ledger.md"), mine)
  git("commit", "-qam", "mine")
  git("checkout", "-q", "main")
  writeFileSync(join(dir, "ledger.md"), up)
  git("commit", "-qam", "up")
  git("checkout", "-q", "mine")
  const r = spawnSync("git", ["rebase", "main"], { cwd: dir, stdio: "pipe" })
  expect(r.status).not.toBe(0) // the premise: a real conflict exists
  return dir
}

const run = (dir: string) => spawnSync("node", [script, "ledger.md"], { cwd: dir, encoding: "utf8" })

describe("ledger rebase resolver follows upstream's separator convention", () => {
  it("STACKED layout: splices one entry above upstream's newest and succeeds", () => {
    const base = HEADER + "### old-1\n### old-2\n"
    const up = HEADER + "### up-new\n### old-1\n### old-2\n"
    const mine = HEADER + "### mine-new\n### old-1\n### old-2\n"
    const dir = conflictRepo(base, up, mine)
    const r = run(dir)
    expect(r.status, r.stderr + r.stdout).toBe(0)
    expect(readFileSync(join(dir, "ledger.md"), "utf8")).toBe(
      HEADER + "### mine-new\n### up-new\n### old-1\n### old-2\n",
    )
  })

  it("STACKED layout: two new entries stay stacked, nothing lost", () => {
    const base = HEADER + "### old-1\n### old-2\n"
    const up = HEADER + "### up-new\n### old-1\n### old-2\n"
    const mine = HEADER + "### mine-a\n### mine-b\n### old-1\n### old-2\n"
    const dir = conflictRepo(base, up, mine)
    const r = run(dir)
    expect(r.status, r.stderr + r.stdout).toBe(0)
    expect(readFileSync(join(dir, "ledger.md"), "utf8")).toBe(
      HEADER + "### mine-a\n### mine-b\n### up-new\n### old-1\n### old-2\n",
    )
  })

  it("BLANK-SEPARATED layout: emits the blank line itself", () => {
    const base = HEADER + "### old-1\nbody\n\n### old-2\n"
    const up = HEADER + "### up-new\nbody\n\n### old-1\nbody\n\n### old-2\n"
    const mine = HEADER + "### mine-new\nbody\n\n### old-1\nbody\n\n### old-2\n"
    const dir = conflictRepo(base, up, mine)
    const r = run(dir)
    expect(r.status, r.stderr + r.stdout).toBe(0)
    expect(readFileSync(join(dir, "ledger.md"), "utf8")).toBe(
      HEADER + "### mine-new\nbody\n\n### up-new\nbody\n\n### old-1\nbody\n\n### old-2\n",
    )
  })

  it("BLANK-SEPARATED layout: still refuses a block that butts its own entries together", () => {
    const base = HEADER + "### old-1\nbody\n\n### old-2\n"
    const up = HEADER + "### up-new\nbody\n\n### old-1\nbody\n\n### old-2\n"
    const mine = HEADER + "### mine-a\nbody\n### mine-b\nbody\n\n### old-1\nbody\n\n### old-2\n"
    const dir = conflictRepo(base, up, mine)
    const r = run(dir)
    expect(r.status).not.toBe(0)
    expect(r.stderr + r.stdout).toMatch(/no blank line before/)
    // and it wrote nothing: the conflicted file still carries the markers
    expect(readFileSync(join(dir, "ledger.md"), "utf8")).toMatch(/^<<<<<<< /m)
  })
})
