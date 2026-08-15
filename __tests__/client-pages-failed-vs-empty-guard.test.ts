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

  // ── SITE 3: /alerts (added 2026-08-15) ────────────────────────────────────
  //
  // Found by sweeping client-page empty-state copy rather than by a report. Its
  // `load()` ran three fetches under one Promise.all, guarded each with
  // `if (res.ok)`, and on a !ok response simply left state at its initial `[]` —
  // with a bare `catch { /* ignore */ }` swallowing a thrown fetch entirely.
  //
  // EVERY claim on this page is about the reader's OWN account, which makes it
  // the sharpest instance of this class after the dashboard hero-picker:
  //
  //   • "No alerts yet. Create one above."  — invites a DUPLICATE of an alert
  //     the collector already has.
  //   • "No watched editions yet."
  //   • the channel list rendered every channel as "not linked" with a Link
  //     button, telling someone whose Telegram IS linked that it is not.
  //
  // Per-leg rather than one flag on purpose: the three endpoints fail
  // independently, and a single flag would blank all three sections whenever any
  // one of them broke.
  describe("/alerts — three independent legs, three independent failures", () => {
    const src = stripComments(read("app", "alerts", "page.tsx"))

    it("tracks failure per leg and clears it on re-fetch", () => {
      expect(src).toContain(
        "const [failed, setFailed] = useState({ channels: false, subs: false, fmv: false })",
      )
      // Reset at the top of load(), or a recovered page stays stuck on the
      // failure copy.
      expect(src).toContain("setFailed({ channels: false, subs: false, fmv: false })")
    })

    it("sets the flag on every !ok leg", () => {
      expect(src).toContain('setFailed((f) => ({ ...f, channels: true }))')
      expect(src).toContain('setFailed((f) => ({ ...f, subs: true }))')
      expect(src).toContain('setFailed((f) => ({ ...f, fmv: true }))')
    })

    it("a thrown fetch fails ALL three legs", () => {
      // One Promise.all — if it throws, no leg's state was populated, so trusting
      // any of them would be inventing an answer for two sections as well as one.
      expect(src).toContain("setFailed({ channels: true, subs: true, fmv: true })")
      expect(src, "the catch must not silently swallow").not.toMatch(
        /catch \{\s*\/\* ignore \*\/\s*\}/,
      )
    })

    it("the empty-state copy SURVIVES — owning nothing is still a real answer", () => {
      expect(src).toContain("No alerts yet. Create one above.")
      expect(src).toContain("No watched editions yet.")
    })

    it("the failure branch precedes the empty branch in both lists", () => {
      // Ordering is what makes the fix non-inert.
      expect(src.indexOf("failed.subs ?")).toBeGreaterThan(-1)
      expect(src.indexOf("failed.subs ?")).toBeLessThan(src.indexOf("No alerts yet."))
      expect(src.indexOf("failed.fmv ?")).toBeGreaterThan(-1)
      expect(src.indexOf("failed.fmv ?")).toBeLessThan(src.indexOf("No watched editions yet."))
    })

    it("the channel list carries a notice, since 'not linked' is itself the false claim", () => {
      // This leg has no empty state to guard — the false claim IS the per-channel
      // status, so the disclaimer has to sit above the list.
      expect(src).toContain("failed.channels &&")
      expect(src.indexOf("failed.channels &&")).toBeLessThan(src.indexOf("not linked"))
    })

    it("no failure message diagnoses a cause it cannot know", () => {
      for (const marker of [
        "Couldn&apos;t load your alerts just now",
        "Couldn&apos;t load your watched editions just now",
        "Couldn&apos;t load your channel status just now",
      ]) {
        const i = src.indexOf(marker)
        expect(i, `${marker} must exist`).toBeGreaterThan(-1)
        expect(src.slice(i, i + 240)).toMatch(/says nothing about/)
      }
    })
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
