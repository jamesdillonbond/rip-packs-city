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
  legal: "presentational disclosure shell (variant/link toggles only, no logic)",
  play: "presentational hub shell (links only)",
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

// ── Every include glob must actually MATCH something ─────────────────────────
//
// ⚠ The failure this closes is not a missing entry — it is an entry that is
// PRESENT, syntactically valid, and matches zero files.
//
// Found live 2026-08-11: `app/(collections)/**/*Client.tsx` matched NOTHING.
// Next.js route groups are parenthesised and picomatch reads `(...)` as an
// extglob group, so the glob silently selected no files. The config read
// correctly, vitest raised no error, and the gate went on passing — the only
// visible symptom was that the measured statement TOTAL did not move. Dynamic
// segments (`[collection]`, `[id]`) are the same hazard, since `[...]` is a
// character class.
//
// So: assert that every app/ client component is matched by SOME include glob,
// and that no glob is dead weight.
describe("component gate — include globs actually match files", () => {
  const configText = readFileSync(CONFIG_PATH, "utf8")

  /** The coverage include globs (the `components/…` + `app/…` string literals). */
  function includeGlobs(): string[] {
    return [...configText.matchAll(/"((?:components|app)\/[^"]+)"/g)].map((m) => m[1])
  }

  /** Every *Client.tsx under app/, as repo-relative POSIX paths. */
  function appClientComponents(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) out.push(...appClientComponents(full))
      else if (entry.endsWith("Client.tsx")) out.push(path.relative(ROOT, full).split(path.sep).join("/"))
    }
    return out
  }

  it("every app/**/*Client.tsx is matched by an include glob", async () => {
    const picomatch = (await import("picomatch")).default
    const globs = includeGlobs()
    const clients = appClientComponents(path.join(ROOT, "app"))

    expect(clients.length, "found no app/ client components — the walker broke").toBeGreaterThan(20)

    const unmatched = clients.filter((f) => !globs.some((g) => picomatch(g)(f)))
    expect(
      unmatched,
      "These app/ client components are matched by NO include glob, so they are " +
        "measured by neither gate:\n" +
        unmatched.map((u) => `  - ${u}`).join("\n") +
        "\n\nIf you added a glob for them, check it is not a route-group path: " +
        "`app/(group)/**` matches nothing because `(...)` is extglob syntax. " +
        "Prefer `app/**/*Client.tsx`."
    ).toEqual([])
  })

  it("no include glob is dead (matches zero files in the repo)", async () => {
    const picomatch = (await import("picomatch")).default
    const all: string[] = []
    for (const root of ["components", "app"]) {
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = path.join(dir, entry)
          if (statSync(full).isDirectory()) walk(full)
          else all.push(path.relative(ROOT, full).split(path.sep).join("/"))
        }
      }
      walk(path.join(ROOT, root))
    }
    const dead = includeGlobs().filter((g) => !all.some((f) => picomatch(g)(f)))
    expect(
      dead,
      `These coverage include glob(s) match NO file, so they silently contribute ` +
        `nothing to the gate: [${dead.join(", ")}]. A parenthesised route-group ` +
        `path is the usual cause.`
    ).toEqual([])
  })
})
