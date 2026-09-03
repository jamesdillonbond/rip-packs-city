import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parse } from "yaml"

// ⚠ WHY THIS GUARD EXISTS (2026-09-02).
//
// ci.yml's `changes` job lets a docs-only push skip the ten code jobs. That is a
// NEW way for a guard not to run, so it needs the CLAUDE.md question answered in
// CI itself: "ask what RUNS a guard, not only whether it passes". Three
// properties hold it honest, and each has a failure mode that would read as a
// green build:
//
//   1. The docs GUARDS never gate on `changes`. If someone adds `needs: changes`
//      to ledger-guard, the ledger clobber check silently stops running on the
//      pushes it exists for — and a skipped job looks like a passed one.
//   2. Every CODE job gates on `code == 'true'`, and ONLY on that. A code job
//      that forgets the gate is harmless; one gated on the wrong value skips on
//      code pushes forever.
//   3. The classifier is FAIL-SAFE: the only path to `code=false` is a resolvable
//      base and a diff made entirely of docs paths. This test EXECUTES the real
//      step body in a throwaway git repo — a regex on the script would pin the
//      spelling, not the property.
//
// And the docs-tests subset that replaces the full suite on docs pushes must
// actually find the docs-reading tests: the same grep, run here, must clear the
// same floor the job asserts, or the job is the vacuous-pass shape.

const REPO = process.cwd()
const CI = readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf8")
const wf = parse(CI) as { jobs: Record<string, any> }

const GUARD_JOBS = ["memory-docs", "ledger-guard", "register-guard", "inbox-guard", "tree-corruption"]
const DOCS_ONLY_JOBS = ["docs-tests"]
const CODE_JOBS = Object.keys(wf.jobs).filter(
  (j) => j !== "changes" && !GUARD_JOBS.includes(j) && !DOCS_ONLY_JOBS.includes(j),
)

describe("the docs-only CI filter — who gates on it, and who must never", () => {
  it("read a real workflow — a broken read must not pass as compliance", () => {
    expect(wf.jobs.changes, "the `changes` job is missing").toBeTruthy()
    expect(Object.keys(wf.jobs).length).toBeGreaterThan(12)
    expect(CODE_JOBS.length, "no code jobs found — the classification above is wrong").toBeGreaterThanOrEqual(8)
  })

  it("every guard job runs UNCONDITIONALLY of the classifier", () => {
    for (const j of GUARD_JOBS) {
      expect(wf.jobs[j], `${j} is missing`).toBeTruthy()
      expect(wf.jobs[j].needs, `${j} must not depend on changes`).toBeUndefined()
      expect(String(wf.jobs[j].if ?? ""), `${j} must not gate on the classifier`).not.toContain("needs.changes")
    }
  })

  it("every code job gates on code == 'true', and every docs-only job on code == 'false'", () => {
    for (const j of CODE_JOBS) {
      expect(wf.jobs[j].needs, `${j} must need changes`).toBe("changes")
      expect(String(wf.jobs[j].if ?? ""), `${j} must gate on code == 'true'`).toContain(
        "needs.changes.outputs.code == 'true'",
      )
    }
    for (const j of DOCS_ONLY_JOBS) {
      expect(wf.jobs[j].needs, `${j} must need changes`).toBe("changes")
      expect(String(wf.jobs[j].if ?? "")).toContain("needs.changes.outputs.code == 'false'")
    }
  })

  it("the docs-tests walk finds the docs-reading tests, above the floor the job asserts", () => {
    const step = wf.jobs["docs-tests"].steps.find((s: any) => typeof s.run === "string" && /vitest run/.test(s.run))
    expect(step).toBeTruthy()
    const floor = Number(/-lt (\d+)/.exec(step.run)?.[1])
    expect(floor).toBeGreaterThanOrEqual(30)
    // Same population rule as the job: a test file that mentions docs/, CLAUDE.md or .github/.
    const dir = path.join(REPO, "__tests__")
    const n = readdirSync(dir).filter(
      (f) => /\.test\.tsx?$/.test(f) && /docs\/|CLAUDE\.md|\.github\//.test(readFileSync(path.join(dir, f), "utf8")),
    ).length
    expect(n, `only ${n} docs-reading tests; the job's floor is ${floor}`).toBeGreaterThanOrEqual(floor)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The classifier, EXECUTED. A throwaway repo with three commits:
//   c1: code + docs      c2: docs only      c3: code
// and the real step body run against it with the same env GitHub provides.
// ─────────────────────────────────────────────────────────────────────────────
function classify(cwd: string, event: string, before: string): { code: string; log: string } {
  const step = wf.jobs.changes.steps.find((s: any) => s.id === "classify")
  const out = path.join(cwd, "gh-output.txt")
  writeFileSync(out, "")
  const log = execFileSync("bash", ["-c", step.run], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, EVENT: event, BEFORE: before, GITHUB_OUTPUT: out },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const code = /code=(\w+)/.exec(readFileSync(out, "utf8"))?.[1] ?? "(none)"
  return { code, log }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim()
}

function fixtureRepo(): { cwd: string; c1: string; c2: string; c3: string } {
  const cwd = mkdtempSync(path.join(tmpdir(), "rpc-changes-"))
  git(cwd, "init", "-q", "-b", "main")
  mkdirSync(path.join(cwd, "docs"), { recursive: true })
  mkdirSync(path.join(cwd, "lib"), { recursive: true })
  writeFileSync(path.join(cwd, "lib/a.ts"), "export const a = 1\n")
  writeFileSync(path.join(cwd, "docs/x.md"), "# x\n")
  git(cwd, "add", "-A"); git(cwd, "commit", "-qm", "c1 code+docs")
  const c1 = git(cwd, "rev-parse", "HEAD")
  writeFileSync(path.join(cwd, "docs/x.md"), "# x\nmore\n")
  writeFileSync(path.join(cwd, "README.md"), "readme\n")
  git(cwd, "add", "-A"); git(cwd, "commit", "-qm", "c2 docs only")
  const c2 = git(cwd, "rev-parse", "HEAD")
  writeFileSync(path.join(cwd, "lib/a.ts"), "export const a = 2\n")
  git(cwd, "add", "-A"); git(cwd, "commit", "-qm", "c3 code")
  const c3 = git(cwd, "rev-parse", "HEAD")
  return { cwd, c1, c2, c3 }
}

describe("the classifier is fail-safe — executed against a throwaway repo", () => {
  const repo = fixtureRepo()

  it("a docs-only push (base = the commit before a docs-only tip) is code=false", () => {
    git(repo.cwd, "checkout", "-q", repo.c2)
    const r = classify(repo.cwd, "push", repo.c1)
    expect(r.code, r.log).toBe("false")
    expect(r.log).toMatch(/docs-only/)
  })

  it("a multi-commit push whose TIP is docs-only but whose base is older is code=true", () => {
    // c1 -> c2(docs) -> c3(code): base c1, tip c3. HEAD~1 would say docs-only.
    git(repo.cwd, "checkout", "-q", repo.c3)
    expect(classify(repo.cwd, "push", repo.c1).code).toBe("true")
    // and pushing c2 alone, tip c2 base c1, is docs-only again — the base matters.
    git(repo.cwd, "checkout", "-q", repo.c2)
    expect(classify(repo.cwd, "push", repo.c1).code).toBe("false")
  })

  it("a zero sha (new branch / force push) is code=true", () => {
    git(repo.cwd, "checkout", "-q", repo.c2)
    const r = classify(repo.cwd, "push", "0000000000000000000000000000000000000000")
    expect(r.code, r.log).toBe("true")
  })

  it("an unresolvable base sha is code=true — never guessed from HEAD~1", () => {
    git(repo.cwd, "checkout", "-q", repo.c2)
    const r = classify(repo.cwd, "push", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
    expect(r.code, r.log).toBe("true")
    expect(r.log).toMatch(/not resolvable/)
  })

  it("an empty BEFORE and a non-push event are code=true", () => {
    git(repo.cwd, "checkout", "-q", repo.c2)
    expect(classify(repo.cwd, "push", "").code).toBe("true")
    expect(classify(repo.cwd, "pull_request", repo.c1).code).toBe("true")
    expect(classify(repo.cwd, "workflow_dispatch", repo.c1).code).toBe("true")
  })

  it("an empty diff (base == HEAD) is code=true, not docs-only", () => {
    git(repo.cwd, "checkout", "-q", repo.c2)
    const r = classify(repo.cwd, "push", repo.c2)
    expect(r.code, r.log).toBe("true")
    expect(r.log).toMatch(/empty diff/)
  })
})
