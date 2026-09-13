import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// TWO FILES DECIDE "IS THIS PUSH JUST DOCS?", THEY DECIDE IT IN DIFFERENT
// SYNTAXES, AND NOTHING TIED THEM TOGETHER UNTIL THIS TEST.
//
//   vercel.json   ignoreCommand → `git diff --quiet HEAD^ HEAD -- .
//                 ':(exclude)docs/**' ':(exclude)*.md' ':(exclude)*.mdx'`
//                 …decides whether PRODUCTION DEPLOYS.
//   ci.yml        the `changes` job → `grep -vE '^docs/|\.md$|\.mdx$'`
//                 …decides whether the TEN CODE JOBS RUN.
//
// ⚠ THE DANGEROUS DIRECTION IS ASYMMETRIC. If CI's set is WIDER than Vercel's,
// a push skips its code jobs and still deploys — untested code in production.
// If Vercel's is wider, code merges green and never ships, which CLAUDE.md
// records as having bitten twice ("a docs-only tip suppresses the Vercel
// deploy"). Both are silent; neither reds anything today.
//
// 🚨 AND THIS IS ABOUT TO MATTER. Register #61 proposes widening the deploy-side
// exclusions (measured 2026-09-12: adding `supabase/migrations/**` alone would
// skip 129 of 484 builds in 14 days, 26.7%). Whoever makes that change will edit
// `vercel.json` — one file, one obvious place — and CI's hand-copied regex, in a
// different file and a different syntax, will silently disagree from that moment
// on. This test is what turns that into a red build instead of a quiet drift.
//
// ⭐ IT COMPARES BEHAVIOUR, NOT SPELLING. A pathspec and an ERE cannot be
// string-compared, and pinning either spelling would fail on a harmless rewrite
// while passing a real divergence. Both are applied to the REAL TREE (`git
// ls-files`, a walk — not a curated path list) and the two verdicts must match
// file for file.
// ─────────────────────────────────────────────────────────────────────────────

const REPO = process.cwd()

/** The `:(exclude)…` pathspecs the deploy gate actually passes to git. */
export function deployExcludePathspecs(ignoreCommand: string): string[] {
  return [...ignoreCommand.matchAll(/':\(exclude\)([^']+)'/g)].map((m) => m[1])
}

/** The ERE the CI classifier greps `changed` against. */
export function ciExcludeRegex(ciYaml: string): string {
  const m = ciYaml.match(/grep -vE '([^']+)'/)
  if (!m) throw new Error("could not find the classifier's grep -vE in ci.yml")
  return m[1]
}

const ignoreCommand: string = JSON.parse(
  readFileSync(path.join(REPO, "vercel.json"), "utf8"),
).ignoreCommand
const CI = readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf8")

const pathspecs = deployExcludePathspecs(ignoreCommand)
const ciRe = new RegExp(ciExcludeRegex(CI))

/** Every tracked path — the walk, so a new excluded subtree cannot hide. */
const tracked = execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .split("\n")
  .filter(Boolean)

/**
 * Which paths git itself considers excluded — asked of GIT, not reimplemented.
 * `git ls-files -- . ':(exclude)X'` is the same matcher `git diff` uses, so this
 * cannot drift from the deploy gate's semantics the way a hand-written glob would.
 */
function deployExcluded(): Set<string> {
  const kept = execFileSync(
    "git",
    ["ls-files", "--", ".", ...pathspecs.map((p) => `:(exclude)${p}`)],
    { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\n")
    .filter(Boolean)
  const keptSet = new Set(kept)
  return new Set(tracked.filter((f) => !keptSet.has(f)))
}

describe("the deploy gate and the CI classifier agree on what counts as docs", () => {
  it("NOT VACUOUS: both sides were really read, and both really exclude something", () => {
    expect(pathspecs.length, "no :(exclude) pathspecs parsed out of vercel.json").toBeGreaterThan(0)
    expect(ciExcludeRegex(CI).length).toBeGreaterThan(0)
    expect(tracked.length, "the tree walk found no files").toBeGreaterThan(500)

    // ⚠ THE CONTROL THAT MATTERS: two BROKEN extractors that exclude nothing
    // would agree perfectly and this test would pass on a real divergence. So
    // each side must be shown to separate a known doc from a known non-doc.
    const excluded = deployExcluded()
    const aDoc = tracked.find((f) => f.startsWith("docs/") && f.endsWith(".md"))
    const aCodeFile = tracked.find((f) => f.endsWith(".ts") && !f.endsWith(".md"))
    expect(aDoc, "no docs/*.md in the tree to test with").toBeTruthy()
    expect(aCodeFile, "no .ts file in the tree to test with").toBeTruthy()

    expect(excluded.has(aDoc!), "deploy gate must exclude a docs/*.md").toBe(true)
    expect(excluded.has(aCodeFile!), "deploy gate must NOT exclude a .ts file").toBe(false)
    expect(ciRe.test(aDoc!), "CI classifier must exclude a docs/*.md").toBe(true)
    expect(ciRe.test(aCodeFile!), "CI classifier must NOT exclude a .ts file").toBe(false)
  })

  it("classify every tracked file both ways — the verdicts must match file for file", () => {
    const excluded = deployExcluded()
    const disagreements = tracked
      .filter((f) => excluded.has(f) !== ciRe.test(f))
      .map((f) => `${f}  [deploy-skips=${excluded.has(f)} ci-treats-as-docs=${ciRe.test(f)}]`)

    expect(
      disagreements.slice(0, 25),
      "vercel.json's ignoreCommand and ci.yml's `changes` classifier disagree about these paths.\n" +
        "Whichever you just widened, widen the other to match.\n" +
        "  deploy-skips=true, ci=false  → the code jobs RUN but production NEVER DEPLOYS (the trap\n" +
        "                                 CLAUDE.md records as having bitten twice).\n" +
        "  deploy-skips=false, ci=true  → the code jobs SKIP and production DEPLOYS ANYWAY —\n" +
        "                                 untested code in production, the worse of the two.\n" +
        `Disagreeing paths (${disagreements.length} total, first 25):`,
    ).toEqual([])
  })
})
