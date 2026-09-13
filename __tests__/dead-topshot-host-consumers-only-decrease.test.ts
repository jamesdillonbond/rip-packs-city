import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// `lib/chains/flow/topshot.ts` posts to `https://public-api.nbatopshot.com/graphql`,
// which is DECOMMISSIONED. Not rate-limited, not WAF-blocked, not having a bad
// day — gone. Diagnosed 2026-08-30 (530 / `error code: 1033`), re-verified
// 2026-09-13 from Trevor's own residential IP so no egress explanation survives.
// Register #65 re-pointed six consumers onto Atlas-via-database on 09-06.
//
// ⛔ WHY A RATCHET AND NOT AN ALARM. The obvious instinct is a sentinel arm on
// "is Top Shot GraphQL up". That arm would be RED FOREVER, and this estate has
// already learned that a permanently-red instrument is indistinguishable from a
// broken one at a glance — it teaches people to ignore it. There is nothing to
// alarm about: the answer is known and permanent. What is actually unfinished is
// the MIGRATION, so the instrument should measure the migration.
//
// ⭐ AND THE REAL FAILURE THIS PREVENTS IS REDISCOVERY. The host's death was
// established on 08-30 and independently re-derived from scratch on 09-13,
// because nothing in the tree recorded how much of the estate still depended on
// it. A number that can only go down turns "someone should look into that again"
// into a visible, monotonic piece of work.
//
// ── HOW TO CHANGE IT ─────────────────────────────────────────────────────────
// When you re-point a consumer, LOWER the baseline in the same commit. Raising
// it is what this test exists to stop: a new import of a dead host is a defect
// on its way to production, not a number to adjust.
//
// ⚠ The target is NOT necessarily zero. `topshot-username-resolve.ts` keeps the
// dead call deliberately, as a fallback reached only when the Atlas read FAILS
// (#65) — a dead fallback behind a live primary is harmless and honest. Decide
// per consumer; the ratchet only insists the count never grows.

/** The importers as of 2026-09-13, after wallet-search's partial re-point. */
const BASELINE = 19

const ROOTS = ["app", "lib", "scripts", "workers", "supabase"]
/** The module that legitimately OWNS the dead endpoint. */
const OWNER = join("lib", "chains", "flow", "topshot.ts")
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", ".git"])

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    let s
    try {
      s = statSync(full)
    } catch {
      continue
    }
    if (s.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(full)
  }
  return out
}

function deadHostConsumers(): string[] {
  const cwd = process.cwd()
  const hits: string[] = []
  for (const root of ROOTS) {
    for (const file of walk(join(cwd, root))) {
      // Normalise to forward slashes: this walks with path.join, and a guard
      // authored on Linux that compares against "/"-prefixed paths goes red
      // only on Trevor's Windows box.
      const rel = relative(cwd, file).split(sep).join("/")
      if (rel === OWNER.split(sep).join("/")) continue
      let src: string
      try {
        src = readFileSync(file, "utf8")
      } catch {
        continue
      }
      if (src.includes("topshotGraphql")) hits.push(rel)
    }
  }
  return hits.sort()
}

describe("consumers of the decommissioned Top Shot GraphQL host", () => {
  const consumers = deadHostConsumers()

  it("the walk actually inspected something — a guard that finds nothing is not a passing guard", () => {
    // ⚠ Satisfiable at a population of zero on purpose: if the migration ever
    // completes, `consumers` is empty and this must still be meaningful. So it
    // asserts the WALK's reach, not the hit count.
    const walked = ROOTS.flatMap((r) => walk(join(process.cwd(), r)))
    expect(walked.length).toBeGreaterThan(500)
  })

  it("⛔ never grows — a NEW import of a dead host is a defect, not a number to adjust", () => {
    expect(
      consumers.length,
      `${consumers.length} files import topshotGraphql (baseline ${BASELINE}).\n` +
        `public-api.nbatopshot.com is DECOMMISSIONED — re-point to the Atlas-fed\n` +
        `database tables (register #65), do not add a caller.\n` +
        consumers.map((c) => `  - ${c}`).join("\n"),
    ).toBeLessThanOrEqual(BASELINE)
  })

  it("the baseline is not stale — lower it in the same commit that re-points a consumer", () => {
    // Keeps the number honest in the other direction: once someone migrates a
    // consumer without touching this file, the count drops and this reds,
    // prompting the one-line update. Without it the baseline silently rots
    // upward-permissive and stops constraining anything.
    expect(
      consumers.length,
      `Only ${consumers.length} files still import topshotGraphql — lower BASELINE to ${consumers.length}.`,
    ).toBe(BASELINE)
  })

  it("the module that owns the dead endpoint is excluded, and still exists", () => {
    // If the owner is ever deleted outright the exclusion becomes a lie about a
    // file that is gone, and every other assertion here silently changes meaning.
    expect(() => readFileSync(join(process.cwd(), OWNER), "utf8")).not.toThrow()
    expect(consumers).not.toContain("lib/chains/flow/topshot.ts")
  })
})
