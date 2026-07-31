import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "fs"
import path from "path"

// ── Component-gate rot-guard ─────────────────────────────────────────────────
//
// vitest.components.config.ts measures component coverage against an ALLOWLIST
// of subtrees (its `include` array), not the whole `components/` tree. That is
// the right call — a whole-tree include drowns the signal in presentational
// files — but it has a silent failure mode: a brand-new `components/<feature>/`
// directory contributes ZERO to the ratchet until a human remembers to add it
// to the include. Untested financial UI can land in a new subtree and nothing
// reds CI.
//
// This test closes that hole. Every `components/*/` subdirectory that contains
// logic-bearing .tsx files must be EITHER covered by the config's `include`
// globs OR listed in KNOWN_UNMEASURED below with a reason. A new subtree that is
// in neither fails this test — forcing a conscious "gate it or justify skipping
// it" decision instead of silent rot.
//
// When you add a subtree to the gate's `include`, delete its KNOWN_UNMEASURED
// entry here. When you intentionally leave a presentational-only subtree
// ungated, add it here with a one-line reason.

const ROOT = path.resolve(__dirname, "..")
const COMPONENTS_DIR = path.join(ROOT, "components")
const CONFIG_PATH = path.join(ROOT, "vitest.components.config.ts")

// Subtrees deliberately left out of the coverage gate, each with a reason.
// Presentational-only (no branch logic worth a ratchet) or shelved features.
const KNOWN_UNMEASURED: Record<string, string> = {
  cart: "shelved feature (Cart execution) — off the critical path, revivable",
  filters: "single presentational filter shell",
  legal: "static legal copy, no logic",
  play: "presentational hub shell (links only)",
  pricing: "static pricing marketing block",
  ui: "generic presentational primitives (no branches)",
  visual: "decorative visual chrome",
}

/** Extract the `components/<subdir>` prefixes named in the config's coverage include.
 *
 * We scan the whole config text rather than the first `include:` array, because
 * the file has two: the test-file glob (`include: ["__tests__/**"]`) comes first,
 * and the coverage `include` is the one carrying `components/<name>/` globs. The
 * only `"components/<name>/"` string literals in the file are the coverage globs,
 * so a whole-file scan is both correct and robust to array reordering. */
function includedSubtrees(configText: string): Set<string> {
  const subtrees = new Set<string>()
  for (const m of configText.matchAll(/["']components\/([A-Za-z0-9_-]+)\//g)) {
    subtrees.add(m[1])
  }
  // The bare "components/*.tsx" glob covers top-level files, not a subdir.
  return subtrees
}

/** True if the subdir holds at least one non-test .tsx file (i.e. is logic-capable). */
function hasComponentFiles(dir: string): boolean {
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()!
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry)
      if (statSync(full).isDirectory()) {
        stack.push(full)
      } else if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) {
        return true
      }
    }
  }
  return false
}

describe("component-gate include completeness (rot-guard)", () => {
  const configText = readFileSync(CONFIG_PATH, "utf8")
  const included = includedSubtrees(configText)

  const subdirs = readdirSync(COMPONENTS_DIR)
    .filter((e) => statSync(path.join(COMPONENTS_DIR, e)).isDirectory())
    .filter((e) => hasComponentFiles(path.join(COMPONENTS_DIR, e)))

  it("finds real subtrees and a real config include", () => {
    // Sanity: if these ever go empty the guard is silently inert.
    expect(subdirs.length).toBeGreaterThan(5)
    expect(included.size).toBeGreaterThan(5)
  })

  it("every components/<subtree> is gated or explicitly allowlisted", () => {
    const uncovered = subdirs.filter(
      (d) => !included.has(d) && !(d in KNOWN_UNMEASURED),
    )
    expect(
      uncovered,
      `New/unmeasured component subtree(s) [${uncovered.join(", ")}] are in ` +
        `neither vitest.components.config.ts's include nor the KNOWN_UNMEASURED ` +
        `allowlist. Add them to the gate (write tests) or allowlist them with a reason.`,
    ).toEqual([])
  })

  it("KNOWN_UNMEASURED has no stale entries (a gated subtree left in the allowlist)", () => {
    const stale = Object.keys(KNOWN_UNMEASURED).filter((d) => included.has(d))
    expect(
      stale,
      `Subtree(s) [${stale.join(", ")}] are now in the gate's include but still ` +
        `listed in KNOWN_UNMEASURED — remove them from the allowlist.`,
    ).toEqual([])
  })

  it("KNOWN_UNMEASURED has no entries for directories that no longer exist", () => {
    const ghosts = Object.keys(KNOWN_UNMEASURED).filter(
      (d) => !subdirs.includes(d),
    )
    expect(
      ghosts,
      `KNOWN_UNMEASURED names non-existent subtree(s) [${ghosts.join(", ")}] — remove them.`,
    ).toEqual([])
  })
})
