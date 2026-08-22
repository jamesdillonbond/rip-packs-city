import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// While the rewards programme is not shipped, no user-facing surface may
// promise points, Status or Credits — Trevor, 2026-08-16: "we haven't fully
// built out the rewards program so we shouldn't have it anywhere user-facing."
//
// ⚠ THIS GUARD RETIRES ITSELF. Its precondition is read from the product, not
// asserted as a constant: it only enforces while `app/rewards/layout.tsx` calls
// notFound() unconditionally. The day rewards ships, that call goes and this
// guard stops enforcing on its own — so it can never become the thing blocking
// the launch it was written to protect. A guard whose removal is a prerequisite
// for shipping a feature gets deleted in a hurry by someone who does not know
// why it existed.

const ROOT = process.cwd()

/** Comment-stripped, offset-preserving. */
/*
 * ⚠ MIGRATED 2026-08-22 to the ONE shared stripper (scripts/lib/strip-comments.mjs).
 * The local copy stripped BLOCK comments before LINE comments, so an ordinary
 * line comment mentioning a glob path opened a block comment running to the next
 * close-comment anywhere in the file, blanking real source this guard then
 * reported as clean (103,590 chars across 49 product files). The shared version
 * blanks rather than deletes, so offsets and line numbers survive.
 * Do not re-inline a local copy.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue
      walk(p, out)
    } else if (/\.tsx?$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

/**
 * Surfaces a signed-out or signed-in COLLECTOR can read. `/admin` is excluded
 * (operator-only), and `app/rewards/**` is excluded because that page is behind
 * the notFound() — its copy is dormant, not published, and it is what gets
 * un-hidden when the programme ships.
 */
function userFacingFiles(): string[] {
  return [...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "components"))].filter(
    (p) => !p.includes(`${path.sep}admin${path.sep}`) && !p.includes(`${path.sep}rewards${path.sep}`),
  )
}

/** Does this layout source unconditionally 404? Comment-stripped, so a
 *  commented-out call correctly reads as NOT hidden. */
function detectsHidden(src: string): boolean {
  return /notFound\(\)/.test(stripComments(src))
}

const rewardsIsHidden = (() => {
  const layout = path.join(ROOT, "app/rewards/layout.tsx")
  if (!fs.existsSync(layout)) return false
  return detectsHidden(fs.readFileSync(layout, "utf8"))
})()

describe("no rewards promises while the programme is unshipped", () => {
  it("the precondition DETECTOR works — pinned instead of the current state", () => {
    // ⚠ THIS DELIBERATELY DOES NOT ASSERT `rewardsIsHidden === true`, and the
    // reason is a defect this guard shipped with for about ten minutes: that
    // assertion HARD-FAILS the day rewards ships, so the guard written to
    // protect the launch would have RED CI on launch day — precisely the
    // outcome its own header promised to avoid. Found by mutating
    // `notFound()` out of the layout, not by review.
    //
    // What is pinned instead is the DETECTOR: that it reads the real file, and
    // that it discriminates. If it silently stopped detecting, every
    // enforcement case below would skip and the guard would pass while
    // checking nothing — the vacuous-guard trap this repo keeps paying for.
    const layout = path.join(ROOT, "app/rewards/layout.tsx")
    expect(fs.existsSync(layout), "app/rewards/layout.tsx is gone — re-point this guard").toBe(true)
    expect(detectsHidden("export default function L(){ notFound(); return null }")).toBe(true)
    expect(detectsHidden("export default function L(){ return null }")).toBe(false)
    // And a commented-out call must NOT read as hidden, or shipping rewards by
    // commenting the line would leave the guard enforcing forever.
    expect(detectsHidden("export default function L(){ // notFound();\n return null }")).toBe(false)
  })

  it.runIf(rewardsIsHidden)("no user-facing surface promises Status / Credits / points", () => {
    // ⚠ COMMENTS ARE STRIPPED FIRST, AND THAT IS REQUIRED RATHER THAN TIDY: the
    // comments explaining these very removals quote the removed copy verbatim
    // ("earn Status + Credits", "+500 credits"). Without stripping, the fix
    // documents itself into a violation — this repo's most repeated guard bug.
    const PROMISE = [
      /\+\s*\d+\s*(status|credits?|points)\b/i,
      /earns?\s+\d+\s+(status|credits?|points)\b/i,
      /earn\s+(status|credits)\b/i,
    ]
    const offenders: string[] = []
    for (const file of userFacingFiles()) {
      const src = stripComments(fs.readFileSync(file, "utf8"))
      for (const rx of PROMISE) {
        const m = src.match(rx)
        if (m) offenders.push(`${path.relative(ROOT, file)}: ${m[0].trim()}`)
      }
    }
    expect(offenders, `Rewards promises on user-facing surfaces:\n${offenders.join("\n")}`).toEqual([])
  })

  it.runIf(rewardsIsHidden)("nothing links a collector to /rewards, which is a hard 404", () => {
    // /profile/edit sent every collector there to equip a cosmetic. 19 of 20
    // have none, so it was a dead end for almost everyone who read it.
    const offenders: string[] = []
    for (const file of userFacingFiles()) {
      const src = stripComments(fs.readFileSync(file, "utf8"))
      if (/href=\{?["']\/rewards["']\}?/.test(src)) offenders.push(path.relative(ROOT, file))
    }
    expect(offenders, `Links to the 404'd /rewards:\n${offenders.join("\n")}`).toEqual([])
  })

  it("the sweep actually walks a realistic file set", () => {
    // Not-vacuous check. Satisfiable at zero offenders, but not at zero FILES —
    // a broken walk would otherwise report a clean sweep of nothing.
    const files = userFacingFiles()
    expect(files.length).toBeGreaterThan(100)
    expect(files.some((f) => f.endsWith(path.join("app", "pricing", "page.tsx")))).toBe(true)
  })
})
