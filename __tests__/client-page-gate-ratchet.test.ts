import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

// RATCHET on the SECOND unmeasured surface: `"use client"` page.tsx files.
//
// ── HOW THIS WAS MISSED, WHICH IS THE POINT ─────────────────────────────────
// A guard for exactly this already existed — insights-gate-include-completeness
// — and it is a good guard. It requires every `"use client"` page.tsx to be
// named `*Client.tsx` (so the component gate's `app/**/*Client.tsx` glob catches
// it), or added to the gate by path, or allowlisted with a reason.
//
// It is scoped to `app/insights/**`.
//
// So it could never have said anything about the 33 client pages OUTSIDE that
// directory — `app/dashboard/page.tsx` (2,299 lines), `[collection]/sniper`
// (1,748), `[collection]/analytics` (1,706), `[collection]/collection` (1,330).
// Measured 2026-08-13: **27,016 LOC of `"use client"` pages, of which only the
// three under app/insights are gated at all.** Same structural lesson CLAUDE.md
// records for the anon driver-message guard: deriving a guard's inputs from a
// narrow predicate fixes its scope to that predicate, and it stays silent about
// everything outside by construction. Ask what a guard cannot see.
//
// ── WHY THIS IS A RATCHET AND NOT AN INCLUDE ────────────────────────────────
// Adding `app/**/page.tsx` to the component gate's `include` would drop ~25k
// LOC of largely-untested code into the measured set and crater the ratchet
// below its own threshold, failing CI on arrival. The honest move is the same
// one the server-page ratchet makes: freeze the debt, and force NEW work into
// the convention that is already gated.
//
// ── THE CONVENTION ──────────────────────────────────────────────────────────
// Put the client body in a `*Client.tsx` beside the page and keep `page.tsx` a
// thin server wrapper. `app/**/*Client.tsx` is already in the component gate's
// include, so the logic is measured the day it lands. That is what the ~24
// existing `*Client.tsx` files do; these 33 predate the convention.
//
// ⚠ Passing means the blind spot did not GROW. It does NOT mean these 33 files
// are correct — they are unmeasured, and the honesty defects found on
// [collection]/analytics (8 fetch sites whose failure renders as an empty
// section) came out of exactly this population.

const APP_DIR = join(process.cwd(), "app")

/**
 * The ceiling. Lower it when you convert a page to the `*Client.tsx` split;
 * NEVER raise it. 33 when this landed.
 */
const BUDGET = 33

/** Client pages already named in the component gate's include, by path. */
const GATED_BY_PATH = new Set([
  "app/insights/squeeze-check/page.tsx",
  "app/insights/tc-report/page.tsx",
  "app/insights/pack-reality/page.tsx",
])

const USE_CLIENT = /^\s*["']use client["']/

function pageFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === "api" && dir === APP_DIR) continue // route tree, already gated
      pageFiles(full, out)
    } else if (entry === "page.tsx") {
      out.push(full)
    }
  }
  return out
}

function ungatedClientPages(): string[] {
  return pageFiles(APP_DIR)
    .filter((p) => USE_CLIENT.test(readFileSync(p, "utf8").slice(0, 200)))
    .map((p) => relative(process.cwd(), p).split(sep).join("/"))
    .filter((rel) => !GATED_BY_PATH.has(rel))
    .sort()
}

describe("client-page gate ratchet", () => {
  const pages = ungatedClientPages()

  it("the enumerator finds real client pages (not vacuously passing)", () => {
    expect(pages.length).toBeGreaterThan(10)
    // Self-consistency rather than naming a page: naming one makes a canary that
    // dies the moment someone converts it, so the guard would punish its own
    // success (the mistake the server-page ratchet made and had corrected).
    for (const rel of pages) {
      const src = readFileSync(join(process.cwd(), ...rel.split("/")), "utf8")
      expect(USE_CLIENT.test(src.slice(0, 200)), `${rel} should be a client page`).toBe(true)
    }
  })

  it("the three explicitly-gated insights pages are excluded, and really are gated", () => {
    // If someone drops them from the component gate's include, this stops being
    // a legitimate exclusion — so verify against the config rather than trusting
    // the local list.
    const config = readFileSync(join(process.cwd(), "vitest.components.config.ts"), "utf8")
    for (const rel of GATED_BY_PATH) {
      expect(config, `${rel} must be in the component gate include`).toContain(rel)
      expect(pages).not.toContain(rel)
    }
  })

  it(`no more than ${BUDGET} client pages sit outside both coverage gates`, () => {
    expect(
      pages.length,
      `Ungated "use client" page.tsx grew to ${pages.length} (budget ${BUDGET}).\n` +
        `Put the client body in a *Client.tsx beside the page — that glob IS gated —\n` +
        `and keep page.tsx a thin server wrapper.\n` +
        pages.map((p) => `  - ${p}`).join("\n"),
    ).toBeLessThanOrEqual(BUDGET)
  })

  it("the budget is not left slack above the real number", () => {
    expect(
      BUDGET - pages.length,
      `BUDGET is ${BUDGET} but only ${pages.length} pages qualify — lower BUDGET to ${pages.length}.`,
    ).toBeLessThanOrEqual(0)
  })
})
