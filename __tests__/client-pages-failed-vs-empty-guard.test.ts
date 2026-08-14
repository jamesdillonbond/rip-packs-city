import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Source guard for the failed-vs-empty split on two more `"use client"` pages.
//
// Sibling of collection-analytics-failed-vs-empty-guard (same tab family, its own
// file) and of server-pages-error-vs-absent-guard (the server-side equivalent).
// All three exist for the same structural reason: `"use client"` `page.tsx` files
// are measured by NEITHER coverage gate — the component gate's include is
// `app/**/*Client.tsx`, and the primary gate does not look at `app/**/page.tsx` —
// so a source property is the only automated check available. The durable fix is
// the `*Client.tsx` split tracked by `client-page-gate-ratchet`.
//
// ── THE TWO SITES ───────────────────────────────────────────────────────────
//
// 1. /dashboard — the Hero-Moment picker rendered "No owned moments found." on a
//    failed `/api/profile/top-moments` read. That is the sharpest instance of
//    this class found so far, because the claim is about the READER'S OWN
//    COLLECTION: an outage told a collector they own nothing.
//
// 2. /[collection]/sniper — the relative-deals panel rendered "No relative deals
//    right now. Benchmark data may be too thin." A bare empty state would be bad
//    enough; this one DIAGNOSES a cause that is not the cause, sending the reader
//    to look at benchmark coverage when the actual problem was our read. Same
//    shape as the "try a longer time range or lower min FMV floor" copy fixed on
//    2026-08-12 — advice to fix a filter that was never the problem.
//
// ⚠ Both empty-state strings are KEPT. An empty result is a real answer and must
// still say so; what changed is that it is no longer reachable from a failure.

function read(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8")
}

/** `//`-comment lines removed — a guard must not read its own prose as evidence. */
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n")
}

describe("client pages — a failed read is not an empty result", () => {
  it("dashboard hero-picker distinguishes a failed moments read from owning nothing", () => {
    const src = stripComments(read("app", "dashboard", "page.tsx"))

    expect(src, "must track the failure").toContain("const [loadFailed, setLoadFailed] = useState(false)")
    // Reset per run, or a recovered picker stays stuck on the failure copy.
    expect(src, "must clear on re-fetch").toContain("setLoadFailed(false)")
    // Set on BOTH the null-body path and the thrown path.
    expect(src).toContain("if (!d?.moments) { setLoadFailed(true); setMoments([]); return; }")
    expect(src).toMatch(/\.catch\(\(\)\s*=>\s*\{\s*if \(!cancelled\) \{ setLoadFailed\(true\); setMoments\(\[\]\); \}\s*\}\)/)

    // The empty-state copy survives — owning nothing is a real answer.
    expect(src).toContain("No owned moments found.")
    // ...and the failure copy explicitly disclaims any statement about ownership.
    expect(src).toContain("This says nothing about what you own")
    // Ordering is what makes the fix non-inert.
    expect(
      src.indexOf("This says nothing about what you own"),
      "the failed branch must precede the empty branch",
    ).toBeLessThan(src.indexOf("No owned moments found."))
  })

  it("sniper relative-deals does not blame the benchmark data for a failed read", () => {
    const src = stripComments(read("app", "(collections)", "[collection]", "sniper", "page.tsx"))

    expect(src, "must track the failure").toContain(
      "const [relativeFailed, setRelativeFailed] = useState(false)",
    )
    expect(src, "must clear on re-fetch").toContain("setRelativeFailed(false)")
    expect(src).toContain("if (!Array.isArray(rel?.deals)) { setRelativeFailed(true); setRelativeDeals([]); }")
    // The catch leg must set it too — a thrown fetch is the same outcome.
    const catchBlock = src.slice(src.indexOf("} catch {", src.indexOf("setRelativeFailed(true)")))
    expect(catchBlock.slice(0, 200)).toContain("setRelativeFailed(true)")

    // The diagnosis copy survives for the case where it is actually true...
    expect(src).toContain("Benchmark data may be too thin.")
    // ...and the failure copy explicitly disclaims it.
    expect(src).toContain("This says nothing about the benchmark data")
    expect(
      src.indexOf("This says nothing about the benchmark data"),
      "the failed branch must precede the empty branch",
    ).toBeLessThan(src.indexOf("Benchmark data may be too thin."))
  })

  it("neither failure message diagnoses a cause it cannot know", () => {
    // The defect these replaced was not just silence — it was a CONFIDENT WRONG
    // EXPLANATION. A replacement that guesses a different wrong cause would be
    // the same mistake wearing new copy.
    const dash = read("app", "dashboard", "page.tsx")
    const sniper = read("app", "(collections)", "[collection]", "sniper", "page.tsx")
    for (const [name, src, marker] of [
      ["dashboard", dash, "Couldn&apos;t load your moments."],
      ["sniper", sniper, "Couldn&apos;t load relative deals."],
    ] as const) {
      const i = src.indexOf(marker)
      expect(i, `${name} failure copy must exist`).toBeGreaterThan(-1)
      const copy = src.slice(i, i + 260)
      expect(copy, `${name} must not blame the data`).not.toMatch(
        /too thin|not indexed|no coverage|try a (longer|different)|lower your/i,
      )
    }
  })
})
