import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { readFileSync } from "node:fs"
import path from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// 🚨 A CODE COMMIT FOLLOWED BY A DOCS COMMIT IN THE SAME PUSH NEVER DEPLOYED.
//
// Vercel builds the PUSH, not each commit, so the gate ran once — against the
// tip. With `git diff HEAD^ HEAD`, the tip being docs-only skipped the build and
// took the code commit underneath it down with it. Measured 2026-09-12: the
// sentinel's ack-mode commit was pushed with a docs commit on top of it and the
// resulting production deployment came back CANCELED with the code unshipped.
//
// ⚠ THE THIRD TIME. CLAUDE.md already records this biting twice ("a docs-only
// tip suppresses the Vercel deploy"), and the response both times was a habit —
// push code last. A habit is not a fix; this is.
//
// ✅ `VERCEL_GIT_PREVIOUS_SHA` is the SHA OF THE LAST SUCCESSFUL DEPLOYMENT and
// is exposed precisely when an Ignored Build Step is configured, so the gate can
// ask the question it always meant to ask: *has anything non-docs changed since
// what is actually live* — which is push-shape-independent and also correct for
// a skipped build, a reverted deploy, or several pushes landing at once.
//
// ⛔ IT MUST DEGRADE TO `HEAD^`, NEVER TO "SKIP". The variable is empty on a
// first deployment, and the sha can be absent from Vercel's shallow clone. Both
// fall back to the old behaviour, because the failure mode of guessing wrong
// here is shipping nothing — silently.
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = process.cwd()
const ignoreCommand: string = JSON.parse(readFileSync(path.join(process.cwd(), "vercel.json"), "utf8")).ignoreCommand

// ⛔ `ignoreCommand` is capped at 256 characters by Vercel's schema, and an
// over-long one rejects the WHOLE vercel.json — `crons` included — so every
// deployment errors until it is fixed. That is how this fix first shipped and
// broke the build, which is why the cap is pinned below rather than remembered.
const GATE_SCRIPT = "scripts/vercel-ignore-build.sh"
const gateSource: string = readFileSync(path.join(process.cwd(), GATE_SCRIPT), "utf8")

describe("the deploy gate's comparison base", () => {
  it("asks about the last DEPLOYED commit, not the previous commit", () => {
    expect(gateSource).toContain("VERCEL_GIT_PREVIOUS_SHA")
  })

  it("⛔ still falls back to HEAD^ — an unknown base must never mean 'skip the build'", () => {
    expect(gateSource).toContain('base="HEAD^"')
    // The fallback fires on BOTH failure modes: unset (first deploy) and a sha
    // the shallow clone does not have.
    expect(gateSource).toContain('[ -z "$base" ]')
    expect(gateSource).toContain("git cat-file -e")
  })

  it("⛔ stays under Vercel's 256-character schema cap — over it rejects the WHOLE vercel.json", () => {
    expect(ignoreCommand.length).toBeLessThanOrEqual(256)
    expect(ignoreCommand).toContain(GATE_SCRIPT)
  })

  it("keeps the docs exclusions the CI classifier is pinned against", () => {
    for (const spec of ["docs/**", "*.md", "*.mdx"]) {
      expect(gateSource).toContain(`':(exclude)${spec}'`)
    }
  })
})

// The behavioural half: run the real command in a throwaway repo and check the
// verdict for the exact shape that shipped nothing.
describe("the gate, executed against a real repository", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })

  /** exit 0 = build IGNORED, exit 1 = build PROCEEDS. */
  const gateSkips = (cwd: string, previousSha: string): boolean => {
    try {
      execFileSync("bash", [path.join(REPO_ROOT, GATE_SCRIPT)], {
        cwd,
        env: { ...process.env, VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main", VERCEL_GIT_PREVIOUS_SHA: previousSha },
      })
      return true
    } catch {
      return false
    }
  }

  const repo = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "deploy-gate-"))
    git(dir, "init", "-q", "-b", "main")
    mkdirSync(path.join(dir, "docs"), { recursive: true })
    writeFileSync(path.join(dir, "app.ts"), "export const v = 1\n")
    writeFileSync(path.join(dir, "docs/n.md"), "one\n")
    git(dir, "add", "-A")
    git(dir, "commit", "-qm", "deployed")
    const deployed = git(dir, "rev-parse", "HEAD").trim()
    return { dir, deployed }
  }

  it("🚨 the shape that shipped nothing: a code commit with a docs commit on top of it now BUILDS", () => {
    const { dir, deployed } = repo()
    writeFileSync(path.join(dir, "app.ts"), "export const v = 2\n")
    git(dir, "commit", "-aqm", "code")
    writeFileSync(path.join(dir, "docs/n.md"), "two\n")
    git(dir, "commit", "-aqm", "docs")

    expect(gateSkips(dir, deployed), "must build — there is unshipped code below the tip").toBe(false)
    // The control: the same tree under the OLD rule is exactly the bug.
    expect(gateSkips(dir, "HEAD^"), "control: HEAD^ is what skipped it").toBe(true)
  })

  it("a genuinely docs-only push since the live deployment is still skipped", () => {
    const { dir, deployed } = repo()
    writeFileSync(path.join(dir, "docs/n.md"), "two\n")
    git(dir, "commit", "-aqm", "docs")
    writeFileSync(path.join(dir, "docs/n.md"), "three\n")
    git(dir, "commit", "-aqm", "more docs")
    expect(gateSkips(dir, deployed)).toBe(true)
  })

  it("⛔ an unknown or empty previous sha degrades to HEAD^ rather than skipping a code change", () => {
    const { dir } = repo()
    writeFileSync(path.join(dir, "app.ts"), "export const v = 2\n")
    git(dir, "commit", "-aqm", "code")
    for (const bogus of ["", "0000000000000000000000000000000000000000"]) {
      expect(gateSkips(dir, bogus), `previous sha ${JSON.stringify(bogus)}`).toBe(false)
    }
  })
})
