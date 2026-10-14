import { describe, it, expect } from "vitest"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, statSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  findConflictMarkers,
  droppedLedgerHeadings,
  selectChecks,
} from "@/scripts/pre-commit-check.mjs"
import { isDocsPath, planFor, isTreeWalkingTest, testsNamingPaths } from "@/scripts/preflight.mjs"

// 2026-10-12. The local hooks exist because CI found these minutes AFTER the
// push, on a branch other sessions were pushing to (pre-commit-check.mjs and
// preflight.mjs headers carry the measured cases).

const ROOT = resolve(__dirname, "..")
const MARK = "<".repeat(7)
const END = ">".repeat(7)

describe("pre-commit: the pure detectors", () => {
  it("finds a real conflict and not prose that quotes one", () => {
    expect(findConflictMarkers(["a", `${MARK} HEAD`, "x", "=======", "y", `${END} abc123`].join("\n"))).toEqual([2, 6])
    expect(findConflictMarkers(`prose quoting \`${MARK} HEAD\` mid-line`)).toEqual([])
  })

  it("an in-place heading edit reads as a DROP, exactly as CI's ledger-guard reads it", () => {
    const before = "### 2026-10-11 · A\n\nbody\n### 2026-10-10 · B\n"
    const editedInPlace = "### 2026-10-11 · A (amended)\n\nbody\n### 2026-10-10 · B\n"
    expect(droppedLedgerHeadings(before, editedInPlace)).toEqual(["### 2026-10-11 · A"])
    // Adding an entry at the top drops nothing.
    expect(droppedLedgerHeadings(before, "### 2026-10-12 · C\n\n" + before)).toEqual([])
  })

  it("keys each slow check on the path that can break it", () => {
    expect(selectChecks(["app/page.tsx"])).toEqual({ ledger: false, knownIssues: false, inbox: false, register: false })
    expect(selectChecks(["docs/overnight/ledger.md", "docs/overnight/inbox/x.md"])).toMatchObject({ ledger: true, inbox: true })
    expect(selectChecks(["docs/reference/known-issues.md", "docs/audits/deep-audit-register.md"])).toMatchObject({
      knownIssues: true,
      register: true,
    })
  })
})

describe("pre-commit: end to end in a throwaway repo", () => {
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), "rpc-hooktest-"))
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" })
    g("init", "-q")
    g("config", "user.email", "t@t")
    g("config", "user.name", "t")
    mkdirSync(join(dir, "scripts"), { recursive: true })
    mkdirSync(join(dir, "docs/overnight"), { recursive: true })
    for (const f of ["pre-commit-check.mjs", "find-swallowed-ledger-headings.awk", "find-future-dated-ledger-headings.mjs"]) {
      copyFileSync(join(ROOT, "scripts", f), join(dir, "scripts", f))
    }
    writeFileSync(join(dir, "docs/overnight/ledger.md"), "# Ledger\n\n### 2026-10-10 · first\n\nbody\n")
    g("add", "-A")
    g("commit", "-qm", "init", "--no-verify")
    const check = () => spawnSync(process.execPath, ["scripts/pre-commit-check.mjs"], { cwd: dir, encoding: "utf8" })
    return { dir, g, check, done: () => rmSync(dir, { recursive: true, force: true }) }
  }

  it("blocks a staged conflict marker and passes once it is resolved", () => {
    const r = repo()
    try {
      writeFileSync(join(r.dir, "a.ts"), `const x = 1\n${MARK} HEAD\nconst y = 2\n=======\nconst y = 3\n${END} feature\n`)
      r.g("add", "a.ts")
      const bad = r.check()
      expect(bad.status).toBe(1)
      expect(bad.stderr).toContain("a.ts: unresolved conflict marker(s) at line 2, 6")
      writeFileSync(join(r.dir, "a.ts"), "const x = 1\nconst y = 2\n")
      r.g("add", "a.ts")
      const good = r.check()
      expect(good.status, good.stderr).toBe(0)
      expect(good.stdout).toContain("conflict markers (1 staged file(s))")
    } finally {
      r.done()
    }
  })

  it("blocks a ledger heading edited in place, and lets a new top entry through", () => {
    const r = repo()
    const L = join(r.dir, "docs/overnight/ledger.md")
    try {
      writeFileSync(L, "# Ledger\n\n### 2026-10-10 · first (edited)\n\nbody\n")
      r.g("add", "-A")
      const bad = r.check()
      expect(bad.status).toBe(1)
      expect(bad.stderr).toContain("heading gone vs HEAD")
      writeFileSync(L, "# Ledger\n\n### 2026-10-11 · second\n\nnew\n\n### 2026-10-10 · first\n\nbody\n")
      r.g("add", "-A")
      const good = r.check()
      expect(good.status, good.stderr).toBe(0)
      expect(good.stdout).toContain("ledger (dropped / swallowed / future-dated)")
    } finally {
      r.done()
    }
  })
})

describe("preflight: the plan follows CI's own docs-only rule", () => {
  it("classifies exactly like the `changes` job (docs/ or *.md / *.mdx)", () => {
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")
    // If CI's rule changes, this mirror must change with it.
    expect(ci).toContain(`grep -vE '^docs/|\\.md$|\\.mdx$'`)
    expect(["docs/x.ts", "README.md", "a/b.mdx"].every(isDocsPath)).toBe(true)
    expect(["app/page.tsx", ".github/workflows/ci.yml", "docs.ts"].some(isDocsPath)).toBe(false)
  })

  it("a docs-only change runs nothing heavy", () => {
    const p = planFor(["docs/overnight/ledger.md", "CLAUDE.md"])
    expect(p.isCode).toBe(false)
    expect([p.tsc, p.lint, p.components, p.workers]).toEqual([false, false, false, false])
  })

  it("selects the component gate — the 10-11 red — for a component or client change", () => {
    expect(planFor(["components/alerts/AlertsClient.tsx"]).components).toBe(true)
    expect(planFor(["app/(collections)/[collection]/profile/CollectionProfileClient.tsx"]).components).toBe(true)
    expect(planFor(["__tests__/component-Foo.test.tsx"]).components).toBe(true)
    // An OG route.tsx is measured by the PRIMARY gate, not the component one.
    expect(planFor(["app/api/og/x/route.tsx"]).components).toBe(false)
    expect(planFor(["lib/fmv.ts"]).components).toBe(false)
  })

  it("quick mode (the pre-push hook) never runs tsc, lint or a coverage gate", () => {
    const p = planFor(["components/a.tsx", "workers/w/index.ts"], { quick: true, full: true })
    expect([p.tsc, p.lint, p.full]).toEqual([false, false, false])
    expect(p.guards).toBe(true)
    // …but it still KNOWS they were selected, so it can name them.
    expect([p.components, p.workers]).toEqual([true, true])
  })
})

describe("the hooks are wired", () => {
  it("both hooks exist, are executable, and call the scripts", () => {
    for (const [hook, script] of [
      ["pre-commit", "scripts/pre-commit-check.mjs"],
      ["pre-push", "scripts/preflight.mjs --quick"],
    ]) {
      const f = join(ROOT, ".githooks", hook)
      expect(statSync(f).mode & 0o111, `${hook} must be executable`).not.toBe(0)
      expect(readFileSync(f, "utf8")).toContain(script)
    }
  })

  it("the web SessionStart hook activates them", () => {
    expect(readFileSync(join(ROOT, ".claude/hooks/session-start.sh"), "utf8")).toContain("git config core.hooksPath .githooks")
  })
})

describe("preflight: the derived selections see what `vitest related` cannot", () => {
  // 2026-10-13: both reds on main that morning were TREE-WALKING guards
  // (no-credential-literals-in-tracked-files, insights-client-dates-are-
  // hydration-safe-guard). They read files; they import nothing changed.
  it("classifies both of those guards as tree-walking, from their real source", () => {
    for (const f of ["no-credential-literals-in-tracked-files", "insights-client-dates-are-hydration-safe-guard"]) {
      expect(isTreeWalkingTest(readFileSync(join(ROOT, "__tests__", `${f}.test.ts`), "utf8")), f).toBe(true)
    }
    expect(isTreeWalkingTest('import { x } from "@/lib/x"\nexpect(x(1)).toBe(2)')).toBe(false)
  })

  it("selects a test that NAMES a changed file even though it imports nothing", () => {
    const tests = [
      { file: "__tests__/a.test.ts", src: 'readFileSync("docs/audits/deep-audit-register.md")' },
      { file: "__tests__/b.test.ts", src: 'import { y } from "@/lib/y"' },
    ]
    expect(testsNamingPaths(tests, ["docs/audits/deep-audit-register.md"])).toEqual([])
    expect(testsNamingPaths(tests, ["lib/y.ts"])).toEqual([])
    const withCode = [...tests, { file: "__tests__/c.test.ts", src: 'readFileSync("app/(collections)/layout.tsx")' }]
    expect(testsNamingPaths(withCode, ["app/(collections)/layout.tsx"])).toEqual(["__tests__/c.test.ts"])
  })
})
