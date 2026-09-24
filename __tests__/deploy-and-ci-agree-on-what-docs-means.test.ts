import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// TWO FILES DECIDE "IS THIS PUSH JUST DOCS?", THEY DECIDE IT IN DIFFERENT
// SYNTAXES, AND NOTHING TIED THEM TOGETHER UNTIL THIS TEST.
//
//   vercel.json   ignoreCommand → scripts/vercel-ignore-build.sh → `git diff --quiet <base> HEAD -- .
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

/**
 * The `:(exclude)…` pathspecs the deploy gate actually passes to git.
 *
 * ⚠ `ignoreCommand` is capped at 256 chars by Vercel's schema (an over-long one
 * rejects the WHOLE vercel.json, `crons` included — measured 2026-09-12, #97),
 * so the gate delegates to a script. FOLLOW THE DELEGATION rather than reading
 * the one-liner: reading only the one-liner would return ZERO pathspecs and this
 * whole test would pass vacuously, which is the failure mode it exists to catch.
 */
export function deployExcludePathspecs(ignoreCommand: string): string[] {
  const script = ignoreCommand.match(/[\w./-]*scripts\/[\w.-]+\.sh/)?.[0]
  const source = script ? readFileSync(path.join(REPO, script), "utf8") : ignoreCommand
  const specs = [...source.matchAll(/':\(exclude\)([^']+)'/g)].map((m) => m[1])
  if (specs.length === 0) throw new Error("no :(exclude) pathspecs found — the gate's source was not located")
  return specs
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

/**
 * ⭐ THE ONE PERMITTED ASYMMETRY (#61, decided 2026-09-23): subtrees the deploy
 * gate skips but CI still TESTS. Safe in exactly this direction — "code jobs run,
 * production doesn't rebuild" — because (a) nothing in them is part of the Next.js
 * build (pinned below: no .ts/.tsx/.js in them, no app/lib/components import) and
 * (b) the deploy base is VERCEL_GIT_PREVIOUS_SHA, so the next deployable push
 * carries everything since what is live. The REVERSE direction (CI skips, deploy
 * runs) stays forbidden for every path, these included.
 */
const DEPLOY_ONLY_EXCLUSIONS = ["supabase/migrations/", "supabase/tests/", ".github/"] as const
const isDeployOnly = (f: string) => DEPLOY_ONLY_EXCLUSIONS.some((p) => f.startsWith(p))

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
      // the pinned asymmetry: deploy skips, CI still runs — and ONLY that direction
      .filter((f) => !(isDeployOnly(f) && excluded.has(f) && !ciRe.test(f)))
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

describe("the deploy-only exclusions are real and stay non-deployable", () => {
  it("NOT VACUOUS: each deploy-only subtree exists and the deploy gate really skips all of it", () => {
    const excluded = deployExcluded()
    for (const prefix of DEPLOY_ONLY_EXCLUSIONS) {
      const files = tracked.filter((f) => f.startsWith(prefix))
      expect(files.length, `${prefix} has no tracked files — drop it from DEPLOY_ONLY_EXCLUSIONS`).toBeGreaterThan(0)
      const notSkipped = files.filter((f) => !excluded.has(f))
      expect(notSkipped.slice(0, 10), `${prefix} is listed as deploy-only but the gate still builds on these`).toEqual([])
    }
  })

  it("CI still RUNS its code jobs for them (the asymmetry never flips to 'CI skips')", () => {
    const flipped = tracked.filter((f) => isDeployOnly(f) && ciRe.test(f) && !f.endsWith(".md") && !f.endsWith(".mdx"))
    expect(flipped, "CI now treats a deploy-only path as docs — migrations/workflows would ship untested").toEqual([])
  })

  it("nothing in them is buildable source — no .ts/.tsx/.js/.mjs/.json the Next.js build could pull in", () => {
    const buildable = tracked.filter((f) => isDeployOnly(f) && /\.(tsx?|jsx?|mjs|cjs|json)$/.test(f))
    expect(buildable, "a buildable file landed in a deploy-only subtree — a push touching it would skip the deploy").toEqual([])
  })

  it("no deployable code imports them (a comment naming the path is fine)", () => {
    const roots = ["app", "lib", "components"]
    const src = execFileSync("git", ["ls-files", "--", ...roots, "proxy.ts", "next.config.*"], {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\n")
      .filter((f) => /\.(tsx?|jsx?|mjs)$/.test(f))
    expect(src.length, "the deployable-source walk found nothing").toBeGreaterThan(200)
    const importRe = /(?:from\s+|import\(\s*|require\(\s*|readFileSync\([^)]*)['"`][^'"`]*(?:supabase\/(?:migrations|tests)|\.github)\//
    const offenders = src.filter((f) => importRe.test(readFileSync(path.join(REPO, f), "utf8")))
    expect(offenders, "deployable code reads a deploy-only subtree — skipping the deploy on it would ship stale code").toEqual([])
  })
})
