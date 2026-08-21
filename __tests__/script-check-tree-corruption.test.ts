import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Tests for scripts/check-tree-corruption.mjs — a BLOCKING CI guard that had no
// test of its own.
//
// ── WHY IT MATTERS THAT THIS ONE IS TESTED ─────────────────────────────────
// It guards the Windows↔sandbox mount corruption class: NUL-byte injection and
// silent truncation. Its first real run found a committed NUL byte in a URL
// sanitiser, so the failure mode is not hypothetical. And CLAUDE.md records the
// trap it shipped with: "its default staged-only mode inspects NOTHING on a CI
// checkout (0 file(s) checked, exit 0)" — a guard that passes loudly while
// looking at nothing.
//
// ⚠ THESE DRIVE THE REAL SCRIPT AGAINST A REAL THROWAWAY GIT REPO. Re-implementing
// its logic here and asserting on that would pin my copy, not the file CI runs —
// the exact "vacuous assertion that reads as coverage" shape. Every case shells
// out to `node scripts/check-tree-corruption.mjs` with cwd set to a scratch repo.
//
// ⚠ AND THE NUL IS BUILT AT RUNTIME FROM AN ESCAPE, NEVER TYPED AS A LITERAL
// BYTE. A literal NUL in this file would be committed into the tree — and the
// very guard under test would then block the repo. The fixture has to describe
// the corruption without containing it.
const NUL = "\u0000"

const SCRIPT = path.resolve(__dirname, "..", "scripts", "check-tree-corruption.mjs")

let repo: string

function git(args: string[], cwd = repo) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
}

/** Run the guard; never throws — returns the exit status and merged output. */
function runGuard(args: string[] = []): { status: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    })
    return { status: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` }
  }
}

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), "tree-corruption-"))
  git(["init", "-q", "-b", "main"])
  git(["config", "user.email", "t@example.com"])
  git(["config", "user.name", "T"])
  mkdirSync(path.join(repo, "sub"), { recursive: true })
  writeFileSync(path.join(repo, "clean.ts"), "export const a = 1\nexport const b = 2\n")
  writeFileSync(path.join(repo, "sub", "also-clean.md"), "# title\n\nbody\n")
  // A binary-extension file that legitimately contains a NUL — the skip list
  // exists for exactly this, and without a case here the skip is unverified.
  writeFileSync(path.join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]))
  git(["add", "-A"])
  git(["commit", "-qm", "base"])
})

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true })
})

describe("check-tree-corruption --all", () => {
  it("passes a clean tree AND reports how many files it inspected", () => {
    // ⚠ The count is the load-bearing half. "exit 0" alone is what a guard
    // inspecting nothing also returns, so the number is the only thing that
    // separates "clean" from "blind" — CI asserts it for the same reason.
    const { status, out } = runGuard(["--all"])
    expect(status).toBe(0)
    const m = /corruption guard: (\d+) file\(s\) checked/.exec(out)
    expect(m, `expected an inspected-file count in: ${out}`).not.toBeNull()
    expect(Number(m![1])).toBeGreaterThan(0)
  })

  it("blocks a file containing NUL bytes, naming it", () => {
    // The class its first real run actually caught, in a URL sanitiser.
    writeFileSync(path.join(repo, "clean.ts"), `export const a = 1 ${NUL}\n`)
    const { status, out } = runGuard(["--all"])
    expect(status).toBe(1)
    expect(out).toContain("clean.ts")
    expect(out).toContain("NUL bytes")
    git(["checkout", "--", "clean.ts"])
  })

  it("blocks a TRUNCATED file — a strict prefix of HEAD — with both byte counts", () => {
    // The mount-corruption signature: the write stops early, so what survives is
    // a prefix. Reported as `n of m bytes` so the reader sees how much went.
    writeFileSync(path.join(repo, "clean.ts"), "export const a = 1\n")
    const { status, out } = runGuard(["--all"])
    expect(status).toBe(1)
    expect(out).toMatch(/truncated: \d+ of \d+ bytes/)
    git(["checkout", "--", "clean.ts"])
  })

  it("does NOT flag an ordinary edit that happens to be shorter", () => {
    // ⚠ THE DISCRIMINATING CASE, and the one that decides whether this guard is
    // usable at all. Shrinking a file is normal; only a STRICT PREFIX of HEAD is
    // corruption. Without this the guard would block routine deletions, and the
    // next person would disable it.
    writeFileSync(path.join(repo, "clean.ts"), "export const z = 9\n")
    const { status } = runGuard(["--all"])
    expect(status).toBe(0)
    git(["checkout", "--", "clean.ts"])
  })

  it("skips binary extensions, so a legitimate NUL in a .png is not corruption", () => {
    // logo.png was committed with a NUL in beforeAll and the clean-tree case
    // above already passed — which only proves the skip if the byte is really
    // there, so assert that directly rather than trusting the fixture.
    const raw = execFileSync("git", ["show", "HEAD:logo.png"], { cwd: repo, maxBuffer: 1 << 20 })
    expect(raw.includes(0x00), "fixture must actually contain a NUL").toBe(true)
    expect(runGuard(["--all"]).status).toBe(0)
  })

  it("still passes when a NEW file is added (no HEAD copy to compare against)", () => {
    // `git show HEAD:<f>` returns null for a path HEAD does not have; the guard
    // must skip the truncation comparison rather than read "no HEAD" as a shrink.
    writeFileSync(path.join(repo, "brand-new.ts"), "export const n = 1\n")
    git(["add", "brand-new.ts"])
    expect(runGuard(["--all"]).status).toBe(0)
    git(["rm", "-q", "-f", "brand-new.ts"])
  })
})

describe("the staged-mode blind spot CLAUDE.md documents", () => {
  it("⚠ inspects ZERO files and exits 0 when nothing is staged", () => {
    // NOT a bug report — the DEFAULT mode's documented behaviour, pinned so it
    // cannot be forgotten again. A CI checkout stages nothing, so running this
    // without `--all` there is a guard that passes while looking at nothing:
    // "0 file(s) checked", exit 0. CLAUDE.md's rule — "ask what RUNS a guard,
    // not only whether it passes" — comes from this file. If a future edit makes
    // bare mode audit the tree, this test SHOULD fail and be inverted deliberately.
    const { status, out } = runGuard([])
    expect(status).toBe(0)
    expect(out).toContain("0 file(s) checked")
  })

  it("in staged mode it DOES catch a staged NUL — the mode works, it is the emptiness that lies", () => {
    // The complement, so the case above cannot be misread as "staged mode is
    // broken". Given something staged, it does its job.
    writeFileSync(path.join(repo, "clean.ts"), `export const a = 1 ${NUL}\n`)
    git(["add", "clean.ts"])
    const { status, out } = runGuard([])
    expect(status).toBe(1)
    expect(out).toContain("NUL bytes")
    git(["reset", "-q"])
    git(["checkout", "--", "clean.ts"])
  })
})
