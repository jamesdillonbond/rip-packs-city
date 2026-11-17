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

  // 2026-10-21: late git builds of OLDER commits took the production alias from
  // newer live ones twice in one morning (8e28e329 over 7807764a, 02d1325a over
  // 6ccc20ef). Vercel clones only the commit it builds, so the newer live sha is
  // not in the clone — the second case below is that exact shape.
  it("🚨 a late build of a commit OLDER than the live one is skipped (it would roll prod back)", () => {
    const { dir } = repo()
    writeFileSync(path.join(dir, "app.ts"), "export const v = 2\n")
    git(dir, "commit", "-aqm", "older code")
    const older = git(dir, "rev-parse", "HEAD").trim()
    writeFileSync(path.join(dir, "app.ts"), "export const v = 3\n")
    git(dir, "commit", "-aqm", "newer code — live")
    const live = git(dir, "rev-parse", "HEAD").trim()
    git(dir, "checkout", "-q", older)
    expect(gateSkips(dir, live), "HEAD is an ancestor of what is live").toBe(true)
  })

  it("🚨 …also from a SHALLOW clone of the older commit that lacks the live sha (fetched by the gate)", () => {
    const { dir: origin } = repo()
    git(origin, "config", "uploadpack.allowAnySHA1InWant", "true")
    writeFileSync(path.join(origin, "app.ts"), "export const v = 2\n")
    git(origin, "commit", "-aqm", "older code")
    const older = git(origin, "rev-parse", "HEAD").trim()
    writeFileSync(path.join(origin, "app.ts"), "export const v = 3\n")
    git(origin, "commit", "-aqm", "newer code — live")
    const live = git(origin, "rev-parse", "HEAD").trim()
    const clone = mkdtempSync(path.join(tmpdir(), "deploy-gate-clone-"))
    git(clone, "init", "-q")
    git(clone, "remote", "add", "origin", `file://${origin}`)
    git(clone, "fetch", "-q", "--depth=1", "origin", older)
    git(clone, "checkout", "-q", older)
    let present = true
    try { git(clone, "cat-file", "-e", `${live}^{commit}`) } catch { present = false }
    expect(present, "control: the shallow clone does not have the live sha").toBe(false)
    expect(gateSkips(clone, live)).toBe(true)
  })

  it("MIRROR: a NEWER commit than the live one with code still builds; the same commit is unchanged", () => {
    const { dir, deployed } = repo()
    writeFileSync(path.join(dir, "app.ts"), "export const v = 2\n")
    git(dir, "commit", "-aqm", "code")
    expect(gateSkips(dir, deployed)).toBe(false)
    const head = git(dir, "rev-parse", "HEAD").trim()
    expect(gateSkips(dir, head), "same sha: no diff → skipped, as before").toBe(true)
  })

  it("MIRROR: a sibling branch (not an ancestor of live) with code still builds", () => {
    const { dir, deployed } = repo()
    writeFileSync(path.join(dir, "app.ts"), "export const v = 2\n")
    git(dir, "commit", "-aqm", "live")
    const live = git(dir, "rev-parse", "HEAD").trim()
    git(dir, "checkout", "-q", "-b", "side", deployed)
    writeFileSync(path.join(dir, "lib.ts"), "export const w = 1\n")
    git(dir, "add", "-A")
    git(dir, "commit", "-qm", "sibling code")
    expect(gateSkips(dir, live)).toBe(false)
  })

  it("⛔ an unknown or empty previous sha degrades to HEAD^ rather than skipping a code change", () => {
    const { dir } = repo()
    writeFileSync(path.join(dir, "app.ts"), "export const v = 2\n")
    git(dir, "commit", "-aqm", "code")
    for (const bogus of ["", "0000000000000000000000000000000000000000"]) {
      expect(gateSkips(dir, bogus), `previous sha ${JSON.stringify(bogus)}`).toBe(false)
    }
  })

  // 2026-10-27 (review of 2d604b32f): the gate also reads the tip of origin/main.
  const cloneAt = (origin: string, sha: string) => {
    git(origin, "config", "uploadpack.allowAnySHA1InWant", "true")
    const clone = mkdtempSync(path.join(tmpdir(), "deploy-gate-clone-"))
    git(clone, "init", "-q")
    git(clone, "remote", "add", "origin", `file://${origin}`)
    git(clone, "fetch", "-q", "--depth=1", "origin", sha)
    git(clone, "checkout", "-q", sha)
    return clone
  }

  it("🚨 OVERLAPPING late builds: an older commit is skipped when a newer main tip contains it (live has not moved yet)", () => {
    const { dir: origin, deployed } = repo()
    writeFileSync(path.join(origin, "app.ts"), "export const v = 2\n")
    git(origin, "commit", "-aqm", "A — older code")
    const a = git(origin, "rev-parse", "HEAD").trim()
    writeFileSync(path.join(origin, "app.ts"), "export const v = 3\n")
    git(origin, "commit", "-aqm", "B — newer code, still building")
    const clone = cloneAt(origin, a)
    // Live is still the pre-push deploy, so the 10-21 rule alone would BUILD A.
    expect(gateSkips(clone, deployed), "A is contained in main's tip B; B's build ships it").toBe(true)
  })

  it("MIRROR: the main tip itself still builds", () => {
    const { dir: origin, deployed } = repo()
    writeFileSync(path.join(origin, "app.ts"), "export const v = 2\n")
    git(origin, "commit", "-aqm", "tip code")
    const tip = git(origin, "rev-parse", "HEAD").trim()
    expect(gateSkips(cloneAt(origin, tip), deployed)).toBe(false)
  })

  it("🚨 a ROLLBACK (main reset to an ancestor of the live commit) builds instead of being skipped", () => {
    const { dir: origin } = repo()
    writeFileSync(path.join(origin, "app.ts"), "export const v = 2\n")
    git(origin, "commit", "-aqm", "X — good")
    const x = git(origin, "rev-parse", "HEAD").trim()
    writeFileSync(path.join(origin, "app.ts"), "export const v = 3\n")
    git(origin, "commit", "-aqm", "B — broken, live")
    const live = git(origin, "rev-parse", "HEAD").trim()
    git(origin, "branch", "keep-b")       // keep B fetchable
    git(origin, "reset", "-q", "--hard", x) // main backed out to X
    expect(gateSkips(cloneAt(origin, x), live), "live is no longer on main: ship the rollback").toBe(false)
  })
})
