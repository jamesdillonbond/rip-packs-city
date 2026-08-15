import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

// RATCHET on the largest untested surface in the repo: server `page.tsx` files
// that talk to the database directly.
//
// ── THE HOLE ────────────────────────────────────────────────────────────────
// Neither coverage gate measures `app/**/page.tsx`:
//   • primary   (vitest.config.ts)           → lib/** + app/**/route.ts(x) + proxy.ts
//   • component (vitest.components.config.ts) → components/** + app/**/*Client.tsx
// Measured 2026-08-13: that leaves **48,325 LOC** unmeasured — comparable to the
// ENTIRE component gate's surface (45,875 LOC) — of which the files below hold a
// Supabase client and query it inline.
//
// This is not a hypothetical gap. Every honesty defect this repo keeps re-finding
// lives exactly here: a fetch helper that returns `[]` or `null` or `0` on a query
// ERROR, whose caller then renders that as a fact. The pack-dist page was printing
// "Drop-pool contents aren't indexed for this distribution yet" — a claim about our
// index — whenever the pool read timed out, and nothing could catch it because
// nothing measured the file.
//
// ── WHY A RATCHET AND NOT A BAN ─────────────────────────────────────────────
// The honest options were: (a) require every one of these pages to move its data
// access into `lib/`, which ships a guard with a 36-entry allowlist and is
// therefore theatre; or (b) freeze the debt where it is. This is (b), and it is
// the same instrument the coverage thresholds already are: the number may fall,
// never rise. New pages must route data access through a `lib/` module — where a
// gate already watches it and the `{ data, ok }` contract is testable — instead of
// adding a 38th unmeasured inline reader.
//
// ⚠ WHAT THIS DOES NOT CLAIM. Passing says the blind spot did not GROW. It says
// nothing about whether the 36 pages below are correct; they are still unmeasured.
// Two of them carry hand-written source guards
// (server-pages-error-vs-absent-guard.test.ts) precisely because there is no
// coverage to rely on. Lower the number by extracting — see lib/pack-dist/fetchers.ts
// for the worked example and lib/insights/board-status.ts for the contract.
//
// ── HOW TO SATISFY IT ───────────────────────────────────────────────────────
// Move the reads into `lib/<feature>/fetchers.ts` returning `{ data, ok }` with an
// injectable client, import them from the page, and drop the page's direct
// `@/lib/supabase` / `@supabase/supabase-js` import. Then lower BUDGET by the
// number of pages you converted, in the same commit.

const APP_DIR = join(process.cwd(), "app")

/**
 * The ceiling. Lower it when you extract a page's reads into `lib/`; NEVER raise
 * it to make a build pass — raising it re-opens the exact hole this exists to
 * hold shut. It was 37 when this landed, became 36 when the pack-dist page was
 * converted in the same wave, 35 when app/moment/[id] followed, and 34 when the
 * edition page's last two direct readers (market bundle + insight links) moved
 * to lib/entity/edition-market-fetchers.ts, 26 when EIGHT /insights board pages
 * moved to lib/insights/board-page-fetch.ts in one shared helper, and 25 when a
 * DEAD import was deleted from app/(analytics)/analytics/page.tsx.
 *
 * ⚠ RANK CANDIDATES BY CALL SITES, NOT LOC. Both cheap wins above looked
 * expensive and were not. The edition page is 1,131 LOC but only TWO of its
 * fetchers still held a client — every other section already routed through
 * lib/entity-section-rpc.ts. The eight insights pages did not query anything at
 * all: they imported `supabaseAdmin` purely to hand it to a fetcher that ALREADY
 * lived in `lib/`, wrapped in eight byte-identical copies of one try/catch, so
 * injecting the client inside a shared helper removed the import, the
 * duplication and the ratchet entry at once.
 *
 * So: grep a candidate for `supabaseAdmin` first. A page whose only reference is
 * an ARGUMENT is a five-minute conversion; a page holding its own
 * `.from(...).select(...)` is a real one. ⚠ Beware the spelling — a naive
 * `\.rpc\(` grep misses `(supabaseAdmin.rpc as any)(`, which mis-sorted two
 * analytics pages into the cheap bucket during the 08-15 sweep.
 */
const BUDGET = 23

/** Direct data access = the page itself holds a Supabase client. */
const DIRECT_CLIENT = [/from ["']@\/lib\/supabase["']/, /from ["']@supabase\/supabase-js["']/]

function serverPages(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      // `app/api/**` is the ROUTE tree — already measured by the primary gate.
      if (entry === "api" && dir === APP_DIR) continue
      serverPages(full, out)
    } else if (entry === "page.tsx") {
      out.push(full)
    }
  }
  return out
}

function pagesWithDirectDataAccess(): string[] {
  return serverPages(APP_DIR)
    .filter((p) => {
      const src = readFileSync(p, "utf8")
      return DIRECT_CLIENT.some((rx) => rx.test(src))
    })
    .map((p) => relative(process.cwd(), p).split(sep).join("/"))
    .sort()
}

describe("server-page data-access ratchet", () => {
  const pages = pagesWithDirectDataAccess()

  it("the enumerator finds real pages (the guard is not vacuously passing)", () => {
    // Without this, a broken walk would silently report zero and the ratchet
    // would pass forever while the blind spot grew — the failure mode that makes
    // a guard worse than no guard, because it reads as active protection.
    expect(pages.length).toBeGreaterThan(10)
    // Self-consistency rather than naming a specific page: every page the walk
    // returns must really carry the import. Naming one would be a canary that
    // dies the moment someone converts it — which is the goal, so the guard
    // would punish its own success.
    for (const rel of pages) {
      const src = readFileSync(join(process.cwd(), ...rel.split("/")), "utf8")
      expect(DIRECT_CLIENT.some((rx) => rx.test(src)), `${rel} should match`).toBe(true)
    }
  })

  it("does not measure app/api — that tree is already gated", () => {
    expect(pages.filter((p) => p.startsWith("app/api/"))).toEqual([])
  })

  it("no page is counted for a Supabase import it never uses", () => {
    // ⚠ This ratchet detects an IMPORT, not actual data access, so a DEAD import
    // inflates it — the page reads nothing yet occupies a slot, and the next
    // person to look sees a number that overstates the real work left.
    // `app/(analytics)/analytics/page.tsx` sat here exactly that way (found
    // 2026-08-15; `tsc` was clean without the import, so nothing else caught it —
    // an unused import is not a type error).
    //
    // The over-count is the SAFE direction, which is why this is an assertion
    // rather than a change to the enumerator: a page holding a live client must
    // always be counted, even if this heuristic cannot see the call.
    const deadImports = pages.filter((rel) => {
      const src = readFileSync(join(process.cwd(), ...rel.split("/")), "utf8")
      // Strip the import statements themselves, then look for any remaining
      // mention of a client binding.
      const body = src.replace(/^\s*import[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
      return !/\bsupabaseAdmin\b|\bcreateClient\b|\bsupabase\b/.test(body)
    })
    expect(
      deadImports,
      `These pages import a Supabase client but never use it — delete the import ` +
        `and lower BUDGET, rather than leaving the ratchet overstating the work left:\n` +
        deadImports.map((p) => `  - ${p}`).join("\n"),
    ).toEqual([])
  })

  it(`no more than ${BUDGET} server pages query the database inline`, () => {
    // If this fails on a page you just added: put the reads in lib/ and import
    // them. If it fails because you EXTRACTED one, lower BUDGET — that is the
    // whole point of the ratchet.
    expect(
      pages.length,
      `Server pages with inline DB access grew to ${pages.length} (budget ${BUDGET}).\n` +
        `New/changed pages must read through a lib/ module so the logic is covered.\n` +
        pages.map((p) => `  - ${p}`).join("\n"),
    ).toBeLessThanOrEqual(BUDGET)
  })

  it("the budget is not left slack above the real number", () => {
    // A ratchet with headroom is not a ratchet: it silently licenses the next N
    // additions. This repo has already paid for that lesson once — the component
    // gate drifted ~13 branch points above its threshold before anyone noticed.
    expect(
      BUDGET - pages.length,
      `BUDGET is ${BUDGET} but only ${pages.length} pages qualify — lower BUDGET to ${pages.length}.`,
    ).toBeLessThanOrEqual(0)
  })

  it("the converted pack-dist page reads through lib/, not a client of its own", () => {
    // The worked example, pinned so a future edit cannot quietly reintroduce the
    // inline client and put the honesty logic back outside every gate.
    const src = readFileSync(
      join(APP_DIR, "(collections)", "[collection]", "pack", "dist", "[distId]", "page.tsx"),
      "utf8",
    )
    expect(src).toContain('from "@/lib/pack-dist/fetchers"')
  })
})
