import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "fs"
import path from "path"

// Rot-guard for the app/insights/ CLIENT `page.tsx` blind spot.
//
// The component coverage gate (vitest.components.config.ts) reaches the insights
// board CLIENTS via the glob `app/insights/**/*Client.tsx`. But three insights
// surfaces are `"use client"` `page.tsx` files (squeeze-check, tc-report,
// pack-reality) instead of the `*Client.tsx` convention — so that glob missed
// them and they sat under app/ measured by NEITHER coverage gate, despite
// carrying real wallet-paste + fetch + row-mapping logic. This guard makes that
// class of hole impossible to reopen silently: any `"use client"` page.tsx under
// app/insights must be named `*Client.tsx` (so the existing glob catches it) OR
// added to the gate's include by explicit path OR allowlisted here with a reason.
//
// (Server page.tsx wrappers are deliberately NOT gated — they're async server
// components that can't be cleanly rendered in jsdom, and their board CLIENTS
// carry the logic; so we only enforce on CLIENT page.tsx files.)
//
// ⚠ SCOPE — READ THIS BEFORE TRUSTING THIS GUARD (added 2026-08-13).
// This file enforces on `app/insights/**` ONLY, and that limit is invisible from
// inside it: it walks INSIGHTS_DIR, so it is silent about client pages anywhere
// else by construction, no matter how many times it runs green. Measured
// 2026-08-13: **33 `"use client"` page.tsx files outside app/insights, 27,016
// LOC**, gated by neither coverage gate — `app/dashboard/page.tsx` (2,299),
// `[collection]/sniper` (1,748), `[collection]/analytics` (1,706). That whole
// population is held by a separate ratchet, `client-page-gate-ratchet.test.ts`.
// Same lesson CLAUDE.md records for the anon driver-message guard: a guard that
// derives its inputs from a narrow predicate is fixed to that predicate's scope.
// Ask what a guard CANNOT see, not just whether it passes.

const ROOT = path.resolve(__dirname, "..")
const INSIGHTS_DIR = path.join(ROOT, "app", "insights")
const CONFIG_PATH = path.join(ROOT, "vitest.components.config.ts")

// Client insights page.tsx files intentionally left out of the gate, each with a
// reason. Presentational-only (no branch/fetch logic worth a ratchet).
const KNOWN_UNMEASURED: Record<string, string> = {}

/** All `"use client"` page.tsx files under app/insights, as repo-relative paths. */
function clientInsightsPages(dir: string): string[] {
  const out: string[] = []
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()!
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry)
      if (statSync(full).isDirectory()) {
        stack.push(full)
      } else if (entry === "page.tsx") {
        const head = readFileSync(full, "utf8").slice(0, 200)
        if (/^\s*["']use client["']/.test(head)) {
          out.push(path.relative(ROOT, full).split(path.sep).join("/"))
        }
      }
    }
  }
  return out
}

describe("insights-gate include completeness (rot-guard)", () => {
  const configText = readFileSync(CONFIG_PATH, "utf8")
  const clientPages = clientInsightsPages(INSIGHTS_DIR)

  it("finds real client insights pages (guard is not silently inert)", () => {
    // There are at least the three known ones; if this hits zero the enumerator
    // broke and the guard would pass vacuously.
    expect(clientPages.length).toBeGreaterThanOrEqual(3)
  })

  it("every client insights page.tsx is measured by the component gate or allowlisted", () => {
    const uncovered = clientPages.filter((p) => {
      if (p in KNOWN_UNMEASURED) return false
      // Covered if the config include names the file by explicit path, or if the
      // file follows the *Client.tsx convention the general glob already catches.
      const namedExplicitly = configText.includes(`"${p}"`)
      const isClientConvention = p.endsWith("Client.tsx")
      return !namedExplicitly && !isClientConvention
    })
    expect(
      uncovered,
      `Client "use client" insights page(s) [${uncovered.join(", ")}] are measured by ` +
        `NEITHER coverage gate. Either rename to *Client.tsx (the existing ` +
        `app/insights/**/*Client.tsx glob catches it), add the file by explicit path to ` +
        `vitest.components.config.ts's coverage include (and write a render test), or ` +
        `add it to KNOWN_UNMEASURED here with a reason.`,
    ).toEqual([])
  })

  it("KNOWN_UNMEASURED has no stale entries (a now-gated page still allowlisted)", () => {
    const stale = Object.keys(KNOWN_UNMEASURED).filter(
      (p) => configText.includes(`"${p}"`) || p.endsWith("Client.tsx"),
    )
    expect(stale, `Remove now-gated page(s) [${stale.join(", ")}] from KNOWN_UNMEASURED.`).toEqual(
      [],
    )
  })

  it("KNOWN_UNMEASURED has no entries for files that no longer exist", () => {
    const ghosts = Object.keys(KNOWN_UNMEASURED).filter((p) => !clientPages.includes(p))
    expect(ghosts, `KNOWN_UNMEASURED names non-existent page(s) [${ghosts.join(", ")}].`).toEqual(
      [],
    )
  })
})
