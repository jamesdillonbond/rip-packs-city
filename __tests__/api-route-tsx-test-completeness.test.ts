import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "fs"
import path from "path"

// ── `route.tsx` test-completeness + coverage-gate rot-guard ─────────────────
//
// THE HOLE THIS CLOSES
// Both coverage gates address route handlers by EXTENSION, and both said `.ts`:
//   • primary   (vitest.config.ts)            include: "app/api/**/route.ts"
//   • component (vitest.components.config.ts)  include: "components/**", "app/insights/**/*Client.tsx"
// So the 44 `app/api/**/route.tsx` files — 43 OG social cards plus the 844-LOC
// exportable Trophy Case PDF, ~8,000 LOC — were measured by NEITHER gate, and
// 43 of 44 had no test whatsoever. That matters more than a coverage percentage
// suggests, because these routes have a KNOWN silent failure mode: emitting
// HTTP 200 with a ZERO-BYTE body, which blanks every social unfurl while every
// status-based check stays green (memory: share-og-image-zero-bytes).
//
// Sibling guards already close this class for other trees —
// component-gate-include-completeness (components/**),
// insights-gate-include-completeness (app/insights/**),
// worker-test-completeness (workers/**). This is the same guard for `route.tsx`.
//
// It asserts two independent things, because either alone is insufficient:
//   1. Every `route.tsx` is referenced by some test — otherwise a new card
//      lands untested and nothing reddens.
//   2. The primary gate's coverage include still names `route.tsx` — otherwise
//      the tests run but contribute nothing to the ratchet, and coverage there
//      can rot back to zero silently. (Exactly the pre-existing state.)
//
// Opt a file out by adding it to KNOWN_UNTESTED with a one-line reason.

const ROOT = path.resolve(__dirname, "..")
const API_DIR = path.join(ROOT, "app", "api")
const TESTS_DIR = __dirname
const PRIMARY_CONFIG = path.join(ROOT, "vitest.config.ts")

/** `route.tsx` files deliberately left without a test, each with a reason. */
const KNOWN_UNTESTED: Record<string, string> = {}

/** Every `route.tsx` under app/api, as repo-relative POSIX paths. */
function allRouteTsx(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...allRouteTsx(full))
    } else if (entry === "route.tsx") {
      out.push(path.relative(ROOT, full).split(path.sep).join("/"))
    }
  }
  return out
}

function testFiles(): string[] {
  return readdirSync(TESTS_DIR).filter((f) => f.endsWith(".test.ts") || f.endsWith(".test.tsx"))
}

function allTestText(): string {
  return testFiles()
    .map((f) => readFileSync(path.join(TESTS_DIR, f), "utf8"))
    .join("\n")
}

describe("app/api/**/route.tsx test-completeness rot-guard", () => {
  const routes = allRouteTsx(API_DIR)

  it("finds the route.tsx files (sanity)", () => {
    // Guards against the walker silently matching nothing (a rename of the file
    // convention would otherwise make this whole suite vacuously pass).
    expect(routes.length).toBeGreaterThan(30)
  })

  it("every route.tsx is referenced by at least one test", () => {
    const text = allTestText()
    const missing = routes.filter((r) => {
      if (r in KNOWN_UNTESTED) return false
      // Match the import specifier without its extension: tests import
      // "@/app/api/og/deal/route", never the .tsx path.
      const spec = r.replace(/\.tsx$/, "")
      return !text.includes(spec)
    })

    expect(
      missing,
      `These app/api/**/route.tsx files have no test referencing them.\n` +
        `Add a render test (see __tests__/api-og-cards-render-sweep.test.ts — assert REAL\n` +
        `bytes, not just status 200) or allowlist with a reason in KNOWN_UNTESTED.\n\n` +
        missing.map((m) => `  - ${m}`).join("\n")
    ).toEqual([])
  })

  it("the primary coverage gate still measures route.tsx", () => {
    const cfg = readFileSync(PRIMARY_CONFIG, "utf8")
    // Without this the suite above can be fully green while the files
    // contribute nothing to the ratchet — the exact state before 2026-08-11.
    expect(
      cfg.includes("app/api/**/route.tsx"),
      "vitest.config.ts coverage.include must name app/api/**/route.tsx — " +
        "a `route.ts`-only glob silently drops all 44 card/PDF routes from the gate."
    ).toBe(true)
  })

  it("the primary coverage gate measures lib/**/*.tsx too", () => {
    const cfg = readFileSync(PRIMARY_CONFIG, "utf8")
    // Same extension bug one directory over: `lib/**/*.ts` misses
    // lib/og/entity-card.tsx (shared by 5 OG cards) and
    // lib/warmup/WarmupContext.tsx (tested, but was measured by neither gate).
    expect(
      cfg.includes("lib/**/*.tsx"),
      "vitest.config.ts coverage.include must name lib/**/*.tsx — otherwise " +
        "lib/og/entity-card.tsx and lib/warmup/WarmupContext.tsx go unmeasured."
    ).toBe(true)
  })

  it("every allowlisted exception still exists and carries a reason", () => {
    for (const [file, reason] of Object.entries(KNOWN_UNTESTED)) {
      expect(routes, `KNOWN_UNTESTED names ${file}, which no longer exists — delete the entry.`).toContain(file)
      expect(reason.trim().length, `KNOWN_UNTESTED[${file}] needs a real reason.`).toBeGreaterThan(15)
    }
  })
})
