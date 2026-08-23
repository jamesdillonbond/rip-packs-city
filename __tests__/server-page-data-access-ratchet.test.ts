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
 *
 * ── THE NEXT-CHEAPEST TIER, NOW ALSO EXHAUSTED ─────────────────────────────
 * 23 -> 18 (2026-08-15, second pass): five `/insights` board pages —
 * squeeze, trophies, set-squeeze, offer-spread, pinnacle-scarcity — each held
 * ONE query that DUPLICATED its own `/api/public/insights/<board>` route's
 * query, while the page's comment claimed it read the view "exactly as the API
 * route does". Nothing enforced that claim. Each now shares one
 * `lib/insights/<board>-board.ts` with its route, which removes the drift AND
 * the ratchet entry in one move — the same shape as allday-scarcity.
 *
 * ⚠ Share the QUERY, not the POLICY. The module returns supabase-js's
 * `{ data, error }` untouched, because the two consumers legitimately differ:
 * the route needs `boardUnavailable()` (a 503 with no driver message), the page
 * needs `ok:false` (the degraded notice). Their `limit` defaults differ too,
 * deliberately. Normalising either would force one surface to re-derive what it
 * lost.
 *
 * ⚠ And copy the route's ordering EXACTLY, including secondary sorts. The
 * squeeze route tiebreaks every sort on `squeeze_pct`; a first draft of the
 * shared module dropped those, which would have silently changed the route's
 * row order for equal-valued rows.
 *
 * The 17 that remain all hold REAL queries — there is no cheap tier left.
 *
 * 2026-08-15 (test-coverage "do all of them" pass): 18 -> 17. The
 * /analytics/wallets/[address] page's three loaders moved to
 * lib/analytics/wallets/detail-fetchers.ts. That extraction was not done for the
 * ratchet — it was done because all three returned a bare `null` for BOTH "no
 * such wallet" and "the read failed", and the page answered `notFound()` on an
 * explicitly SEO-indexable surface served under ISR (revalidate=600), so one
 * statement timeout CACHED that 404 for ten minutes. Moving them into lib/ is
 * what let a behavioural test drive both branches; the ratchet entry falling off
 * is a side effect, and this line records that the budget was lowered in the
 * SAME commit that earned it rather than banked as slack.
 *
 * 2026-08-16: 14 -> 13 -> 12, both for the same reason as the wallets page —
 * the extraction was the way to REACH a defect, not the goal.
 *   • /[collection]/set/[slug]: `fetchFullTierMix` returned a bare `[]` on a
 *     query error, and `[]` was already the page's signal for a LEGITIMATE
 *     fallback to the first-100 sample. The tier bar prints ABSOLUTE COUNTS, so
 *     a failed read on a ~3,600-edition set rendered "COMMON · 62 · 62.0%"
 *     against a true ~2,200, identically to the accurate bar.
 *   • /pinnacle/moment/[id]: the densest page here (13 query sites, six in one
 *     Promise.all) published `Number(count ?? 0)` as "Tracked holders", so a
 *     statement timeout rendered a hard 0 — a claim about our own cache
 *     manufactured from our own outage, on a shareable pin URL.
 * ⚠ Both were already covered by comments asserting the right behaviour. The
 * comment is not the check; moving the code somewhere a test can drive it is.
 */
// 8 → 3 (2026-08-22), in four steps as each page's reads were extracted into
// `lib/`: `/[collection]/hot-floors`, `/[collection]/challenges`,
// `/analytics/wallets`, `/admin/flowty-errors` and `/[collection]/pack/[id]`
// (→ `lib/hot-floors/fetchers.ts`, `lib/challenges/hub-fetchers.ts`,
// `lib/analytics/wallet-directory.ts`, `lib/admin/error-triage.ts`,
// `lib/pack-detail/lifecycle.ts`). Taking the `@/lib/supabase` import out of a
// page is what removes it from this list.
// ⚠ Lowered every time because THIS FILE'S own no-slack assertion demanded it,
// never from a count carried over by hand — which is the check working exactly as
// intended, and the reason it fell four times without anyone tracking it.
const BUDGET = 3

/**
 * ── THE WALK WAS BLIND TO EVERYTHING THAT IS NOT A `page.tsx` (widened 2026-08-17) ──
 *
 * `serverPages()` matched `entry === "page.tsx"` and nothing else, so a server
 * component or a `layout.tsx` holding its own client was outside this ratchet
 * BY CONSTRUCTION — the same failure two other guards were caught in on the
 * same night: the derivation, not the membership, was the hole.
 *
 * Re-derived over `app/**` (minus `app/api`) + `components/**`: **10 files held
 * a direct client, 8 of them `page.tsx`, so 2 were invisible** —
 * `app/moment/[id]/layout.tsx` and `components/entity/PopularOnCollection.tsx`.
 *
 * ⚠ A filed count said THREE, and the third was wrong. `app/auth/confirm/
 * AuthConfirmClient.tsx` was named alongside them; it is a `"use client"`
 * component using `getSupabaseBrowser` from `@/lib/auth/supabase-client` — a
 * BROWSER auth client, not a server data reader. Adding it would have widened a
 * server-data-access ratchet over a sign-in flow. Re-derive a filed list before
 * acting on it.
 *
 * ⚠ SEPARATE CEILING, DELIBERATELY — `BUDGET` IS NOT RAISED TO ABSORB THIS.
 * Raising it is what this file's own header forbids in the strongest terms, and
 * a widened walk paying for itself with a bigger number is indistinguishable in
 * a diff from new debt being waved through. So the `page.tsx` promise stays
 * literally true and independently checkable at 8, and the newly-visible
 * surface gets its own ban at its own measured population.
 *
 * 2 -> 1 in the commit that widened this: `app/moment/[id]/layout.tsx`'s single
 * `resolve_moment_id` call moved to `lib/moment/resolve-moment-id.ts`. That was
 * not done for the ratchet — the layout FAILS OPEN on an unreadable answer so a
 * transient RPC error cannot 404 an indexed moment out of Google, a contract its
 * comment asserted and nothing checked because nothing could reach the code.
 *
 * 1 -> 0 immediately after: `components/entity/PopularOnCollection`'s four
 * queries moved to `lib/entity/popular-on-collection-fetchers.ts`. ⚠ **This is
 * now a BAN AT POPULATION ZERO, which this repo prefers to a ratchet** — it
 * costs no allowlist, so the next `layout.tsx` or server component that reaches
 * for a client reds on the spot. Lower by extracting, NEVER raise: at zero,
 * raising it is not loosening a budget, it is deleting the guard.
 *
 * ⚠ That extraction was also not for the count. `loadHubs` never destructured
 * `error` (the documented `Array.isArray(data) ? data : []` fabricated-empty
 * shape) and `loadLinks` collapsed error and empty into one `[]`, so a
 * statement timeout silently deleted the internal-link block the component
 * exists to provide — from a page that still returned 200 and still looked
 * complete. It cannot lie in words; it could vanish without trace.
 *
 * ⚠ Client components are NOT excluded. Today none match, and if one ever
 * imports `@/lib/supabase` that is a service-role client in the browser — the
 * loudest possible reason to be counted, not an exemption.
 */
const NON_PAGE_BUDGET = 0

const COMPONENTS_DIR = join(process.cwd(), "components")

/**
 * Every .ts/.tsx outside `app/api` — the route tree, which this guard is not about.
 *
 * ⚠ This used to read "which the primary gate already measures", and that is
 * false for the honesty property. The primary gate is the COVERAGE gate: it
 * measures whether lines execute, and an unhandled supabase error has no branch
 * to be uncovered, so a happy-path route test covers it completely. The route
 * tree was unchecked for that class until 2026-08-21, when it yielded 7 live
 * instances and a measured 259 reads that never destructure `error`.
 * Excluding app/api here is still correct — just not for that reason.
 */
function allSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === "api" && dir === APP_DIR) continue
      allSourceFiles(full, out)
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full)
    }
  }
  return out
}

function nonPageFilesWithDirectDataAccess(): string[] {
  return [...allSourceFiles(APP_DIR), ...allSourceFiles(COMPONENTS_DIR)]
    .filter((f) => !f.endsWith(`${sep}page.tsx`))
    .filter((f) => DIRECT_CLIENT.some((rx) => rx.test(readFileSync(f, "utf8"))))
    .map((f) => relative(process.cwd(), f).split(sep).join("/"))
    .sort()
}

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
    //
    // ⚠ It asserts on the WALK, not on how many pages are still dirty. This read
    // `expect(pages.length).toBeGreaterThan(10)` until 2026-08-16, when the
    // population reached 8 and the guard went red on its own success — the exact
    // failure the next comment names, in numeric form rather than by naming a
    // page. A not-vacuous check must be satisfiable at a population of ZERO,
    // which is the goal state; what it has to prove is that the enumerator can
    // still see the tree.
    expect(serverPages(APP_DIR).length, "the walk itself must find pages").toBeGreaterThan(50)
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

  // ── the surface the page.tsx-only walk could not see ─────────────────────

  it("the non-page walk still enumerates a real tree (not vacuously passing)", () => {
    // ⚠ On the WALK, never on a violation count — it has to stay satisfiable at
    // a population of ZERO, which is the goal. Naming the one remaining file
    // would make this a canary that dies the moment someone converts it.
    const scanned = [...allSourceFiles(APP_DIR), ...allSourceFiles(COMPONENTS_DIR)].filter(
      (f) => !f.endsWith(`${sep}page.tsx`),
    )
    expect(scanned.length, "the non-page walk found nothing — the enumerator is broken").toBeGreaterThan(200)
    // Self-consistency: everything reported must really carry the import.
    for (const rel of nonPageFilesWithDirectDataAccess()) {
      const src = readFileSync(join(process.cwd(), ...rel.split("/")), "utf8")
      expect(DIRECT_CLIENT.some((rx) => rx.test(src)), `${rel} should match`).toBe(true)
    }
  })

  it("non-page files with inline DB access do not grow", () => {
    const files = nonPageFilesWithDirectDataAccess()
    expect(
      files.length,
      `Non-page server files with inline DB access grew to ${files.length} (budget ${NON_PAGE_BUDGET}).\n` +
        `A layout or server component holding its own client is the same blind spot as a page:\n` +
        files.map((f) => `  - ${f}`).join("\n"),
    ).toBeLessThanOrEqual(NON_PAGE_BUDGET)
  })

  it("the non-page budget is not left slack above the real number", () => {
    const files = nonPageFilesWithDirectDataAccess()
    expect(
      NON_PAGE_BUDGET - files.length,
      `NON_PAGE_BUDGET is ${NON_PAGE_BUDGET} but only ${files.length} files qualify — lower it to ${files.length}.`,
    ).toBeLessThanOrEqual(0)
  })

  it("the two walks partition the surface — nothing is counted twice or dropped", () => {
    // The widening would be worthless if the two enumerators overlapped (a file
    // paying against both budgets) or left a gap between them (a file paying
    // against neither, which is the hole this closed).
    const pageSet = new Set(pages)
    const nonPageSet = new Set(nonPageFilesWithDirectDataAccess())
    for (const f of nonPageSet) expect(pageSet.has(f), `${f} counted twice`).toBe(false)
    const everything = [...allSourceFiles(APP_DIR), ...allSourceFiles(COMPONENTS_DIR)]
      .filter((f) => DIRECT_CLIENT.some((rx) => rx.test(readFileSync(f, "utf8"))))
      .map((f) => relative(process.cwd(), f).split(sep).join("/"))
      .filter((f) => !f.startsWith("app/api/"))
    for (const f of everything) {
      expect(pageSet.has(f) || nonPageSet.has(f), `${f} is in neither budget — the walks leave a gap`).toBe(true)
    }
  })

  it("the converted PopularOnCollection reads through lib/, not a client of its own", () => {
    // At NON_PAGE_BUDGET 0 the count assertion alone would pass if this file
    // were simply deleted, so pin the shape that earned the zero.
    const src = readFileSync(join(COMPONENTS_DIR, "entity", "PopularOnCollection.tsx"), "utf8")
    expect(src).toContain('from "@/lib/entity/popular-on-collection-fetchers"')
    expect(DIRECT_CLIENT.some((rx) => rx.test(src))).toBe(false)
  })

  it("the converted moment layout reads through lib/, not a client of its own", () => {
    // The non-page worked example, pinned for the same reason as pack-dist
    // below: an inline client here puts the FAIL-OPEN policy back outside every
    // gate, and that policy is what keeps a transient RPC error from 404-ing an
    // indexed moment.
    const src = readFileSync(join(APP_DIR, "moment", "[id]", "layout.tsx"), "utf8")
    expect(src).toContain('from "@/lib/moment/resolve-moment-id"')
    expect(DIRECT_CLIENT.some((rx) => rx.test(src))).toBe(false)
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
