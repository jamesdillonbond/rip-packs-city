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
 *
 * ⚠ THIS NUMBER WAS RESOLVED FROM A THREE-WAY COLLISION, so the arithmetic is
 * written out: two sessions ran this workstream at once and each lowered the
 * budget by its own conversions only (32 and 31). Neither was right — 33 minus
 * THREE conversions is 30. A ratchet is the one constant where "take mine" and
 * "take theirs" are both silently wrong, because the value is a COUNT of a
 * shared population, not an opinion. Re-derive it from the failing no-slack
 * assertion rather than picking a side.
 *
 * 33 -> 32 (concurrent session): `profile/edit` -> `ProfileEditClient.tsx`.
 * Landed with no note recording which page it converted; noted here because a
 * ratchet whose history has a gap cannot be audited later.
 *
 * 33 -> 32: `[collection]/packs/page.tsx` was a client page for ONE reason —
 * it called `useParams()` to read the collection slug, which a server page
 * receives as a prop. No `*Client.tsx` was needed, because everything below it
 * was already a gated component. ⚠ That is the cheapest shape of conversion, so
 * look for it first — and it is now EXHAUSTED: a sweep of the remaining 32
 * found none whose only client-side API is a routing hook. Every one left holds
 * real state, effects or handlers, so from here a conversion means a genuine
 * split plus enough tests to keep the component gate's aggregate up.
 *
 * 32 -> 31: `dashboard/notifications` — the first REAL split, and the one that
 * establishes the shape. The body moved to `NotificationsClient.tsx` and
 * `page.tsx` became a server wrapper owning the Suspense boundary that
 * `useSearchParams` requires. ⚠ Hoisting that boundary to the server is what
 * makes the client component renderable by a test at all; leaving it inside
 * would have moved the file into the gate without making it testable.
 *
 * ⚠ MEASURED COST OF A CONVERSION, because this is the number that decides
 * whether the next one is affordable: landing the file at 100/85.9/100/100 moved
 * the component gate's aggregate 90.72/82.09/89.55/93.68 -> 90.78/82.34/89.42/
 * 93.74. Statements, branches and lines went UP; FUNCTIONS went DOWN 0.13, and
 * that is the direction to watch — a page contributes many small handlers, so an
 * untested or partly-tested conversion hits `% Funcs` hardest, and that gate sits
 * at 89.1 with well under a point of room. Cover the handlers, not just the
 * fetch paths.
 */
const BUDGET = 30

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
