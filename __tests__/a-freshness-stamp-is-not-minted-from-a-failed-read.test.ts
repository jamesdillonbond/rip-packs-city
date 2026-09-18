import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "fs"
import path from "path"

// BAN AT ZERO — no server page may stamp a board "Updated <now>" from the render
// clock without first checking that the read SUCCEEDED.
//
// ── THE CLASS ───────────────────────────────────────────────────────────────
// `initialFetchedAt={new Date().toISOString()}` is a claim about the DATA's
// freshness manufactured from OUR clock. On a successful read it is true and
// useful. On a FAILED read it told the reader our numbers were current at the
// very moment the board had none — the fabricated-number family, applied to a
// timestamp instead of a count.
//
// Found 2026-09-02 on SEVEN public /insights boards at once, every one of which
// ALREADY passed a degraded flag beside it. That is the point: each page carried
// an honest `initialDegraded`/`loadError` and an unconditional freshness stamp in
// the same JSX block, so the board rendered "Updated just now" directly above
// "we couldn't load this". ⭐ **A page with one honest error branch is not an
// honest page — fix per PANEL.**
//
// The fix is `ok ? new Date().toISOString() : null`. `FreshnessStamp` already
// renders null as "—" and its own doc fixes that as meaning "no timestamp was
// supplied", which is the true statement when the read failed.
//
// ⚠ ASSERTS THE PROPERTY, NOT THE SPELLING: any conditional is accepted, so a
// rewrite that carries the read's real `computed_at` keeps passing. What is
// banned is the UNGUARDED clock.

const ROOT = "app"
/** `initialFetchedAt={new Date()…}` with nothing between `=` and `new`. */
const UNGUARDED = /initialFetchedAt=\{\s*new Date\(/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx$/.test(entry)) out.push(full)
  }
  return out
}

function pagesWithAStamp(): string[] {
  return walk(path.join(process.cwd(), ROOT))
    .filter((f) => readFileSync(f, "utf8").includes("initialFetchedAt="))
    .map((f) => path.relative(process.cwd(), f))
}

describe("a freshness stamp is not minted from a failed read", () => {
  it("inspects the pages it claims to — a walk that found nothing would pass vacuously", () => {
    // ⚠ The count is the assertion that this guard RAN. A bad root or extension
    // filter returns [] and the ban below passes over an empty set.
    const pages = pagesWithAStamp()
    expect(pages.length).toBeGreaterThanOrEqual(7)
  })

  it("no page stamps the render clock unconditionally", () => {
    const offenders = pagesWithAStamp().filter((f) => UNGUARDED.test(readFileSync(f, "utf8")))
    expect(offenders).toEqual([])
  })

  it("POSITIVE CONTROL: the matcher catches the shape that shipped, and clears the fix", () => {
    // Quoted from the code as it stood before 2026-09-02.
    expect(UNGUARDED.test(`initialFetchedAt={new Date().toISOString()}`)).toBe(true)
    // …and accepts a guarded stamp, so the ban is not simply always-true.
    expect(UNGUARDED.test(`initialFetchedAt={ok ? new Date().toISOString() : null}`)).toBe(false)
    expect(UNGUARDED.test(`initialFetchedAt={!loadError ? new Date().toISOString() : null}`)).toBe(false)
    // …and a real data timestamp, the better fix, is not flagged either.
    expect(UNGUARDED.test(`initialFetchedAt={row?.computed_at ?? null}`)).toBe(false)
  })
})

// ── 2026-09-18 · R95 · THE SAME CLASS, ONE LEVEL OF INDIRECTION AWAY ─────────
//
// The ban above is TEXTUAL and scoped to `initialFetchedAt={new Date(…)}` written
// inline in a page. Deep-audit R95 found three public boards still printing
// `UPDATED SEP 18, 2026, 11:32 AM PDT` — the moment of load — beneath their own
// "treat the affected sections as unknown rather than zero" banner, and every one
// of them PASSED the regex, because the clock was minted one call away:
//
//   app/insights/top-sales/page.tsx   `return { rows: [], fetchedAt: new Date().toISOString(), ok: false }`
//   lib/insights/board-page-fetch.ts  stamped once, returned on BOTH branches
//
// ⭐ The reusable lesson, and why these arms are structural rather than textual:
// a guard that bans a SPELLING is silent about the same claim assembled from two
// places. The fix moved the policy into the VALUE — `BoardPageFetch.fetchedAt` is
// now `string | null` and is null on failure — so the compiler, not a regex, is
// what finds the next one. It immediately found three more boards nobody had
// named: market-pulse, parallel-premiums and set-completers, all taking the
// render clock through the same helper.

describe("R95 — the stamp is not minted one level of indirection away", () => {
  it("no /insights page mints a stamp on a branch it is already calling failed", () => {
    // The exact indirect shape that shipped: a clock and `ok: false` in the same
    // returned object literal. Asserts the PROPERTY (a stamp on a failure branch),
    // so any spelling of the clock is caught and a `null` there is not.
    const offenders: string[] = []
    for (const f of walk(path.join(process.cwd(), ROOT))) {
      const src = readFileSync(f, "utf8")
      for (const m of src.matchAll(/\{[^{}]*\bok:\s*false[^{}]*\}/g)) {
        if (/fetchedAt:\s*new Date\(/.test(m[0])) {
          offenders.push(path.relative(process.cwd(), f))
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("POSITIVE CONTROL: that matcher catches the literal line that shipped", () => {
    const shipped = `return { rows: [], fetchedAt: new Date().toISOString(), ok: false }`
    const hit = [...shipped.matchAll(/\{[^{}]*\bok:\s*false[^{}]*\}/g)].some((m) =>
      /fetchedAt:\s*new Date\(/.test(m[0]),
    )
    expect(hit).toBe(true)
    // …and clears the fix, so the ban is not simply always-true.
    const fixed = `return { rows: [], fetchedAt: null, ok: false }`
    const hitFixed = [...fixed.matchAll(/\{[^{}]*\bok:\s*false[^{}]*\}/g)].some((m) =>
      /fetchedAt:\s*new Date\(/.test(m[0]),
    )
    expect(hitFixed).toBe(false)
  })

  // ── The client-side lock ────────────────────────────────────────────────────
  // The page fix alone is not enough: a REFETCH that fails after mount leaves the
  // previous stamp sitting in state beside the newly-failed board. So each client
  // also refuses to stamp while its own failure flag is set. These arms feed the
  // component a failed flag AND a perfectly good timestamp — the pre-fix
  // combination — and require the dash anyway.
  const STAMPED = "2026-09-18T18:32:00.000Z"
  /** The formatted forms the three stamp renderers can emit for STAMPED. */
  const LOOKS_LIKE_A_DATE = /Sep 18, 2026/

  it("SSR top-sales: a failed seed renders the dash even with a valid stamp in hand", async () => {
    const { renderToString } = await import("react-dom/server")
    const { createElement } = await import("react")
    const C = (await import("@/app/insights/top-sales/TopSalesBoardClient")).default
    const html = renderToString(
      createElement(C, { initialRows: [], initialFetchedAt: STAMPED, initialFailed: true }),
    )
    expect(html).not.toMatch(LOOKS_LIKE_A_DATE)
  })

  it("SSR top-sales NO-CHANGE CONTROL: a successful read still shows the stamp", async () => {
    const { renderToString } = await import("react-dom/server")
    const { createElement } = await import("react")
    const C = (await import("@/app/insights/top-sales/TopSalesBoardClient")).default
    const html = renderToString(
      createElement(C, { initialRows: [], initialFetchedAt: STAMPED, initialFailed: false }),
    )
    expect(html).toMatch(LOOKS_LIKE_A_DATE)
  })

  it("SSR serial-premiums: a failed seed renders the dash even with a valid stamp", async () => {
    const { renderToString } = await import("react-dom/server")
    const { createElement } = await import("react")
    const C = (await import("@/app/insights/serial-premiums/SerialPremiumsBoardClient")).default
    const html = renderToString(
      createElement(C, { initialRows: [], initialFetchedAt: STAMPED, initialFailed: true }),
    )
    expect(html).not.toMatch(LOOKS_LIKE_A_DATE)
  })

  it("SSR serial-premiums NO-CHANGE CONTROL: a successful read still shows the stamp", async () => {
    const { renderToString } = await import("react-dom/server")
    const { createElement } = await import("react")
    const C = (await import("@/app/insights/serial-premiums/SerialPremiumsBoardClient")).default
    const html = renderToString(
      createElement(C, { initialRows: [], initialFetchedAt: STAMPED, initialFailed: false }),
    )
    expect(html).toMatch(LOOKS_LIKE_A_DATE)
  })

  it("SSR rookie-board: a failed seed renders the dash even with a valid stamp", async () => {
    const { renderToString } = await import("react-dom/server")
    const { createElement } = await import("react")
    const C = (await import("@/app/insights/rookie-board/RookieBoardClient")).default
    const html = renderToString(
      createElement(C, { initialRows: [], initialFetchedAt: STAMPED, initialFailed: true }),
    )
    expect(html).not.toMatch(LOOKS_LIKE_A_DATE)
  })

  it("SSR rookie-board NO-CHANGE CONTROL: a successful read still shows the stamp", async () => {
    const { renderToString } = await import("react-dom/server")
    const { createElement } = await import("react")
    const C = (await import("@/app/insights/rookie-board/RookieBoardClient")).default
    const html = renderToString(
      createElement(C, { initialRows: [], initialFetchedAt: STAMPED, initialFailed: false }),
    )
    expect(html).toMatch(LOOKS_LIKE_A_DATE)
  })

  // ── The three the COMPILER found, which no sweep had named ─────────────────
  // These take the stamp straight from `fetchBoardForPage`, so the null now
  // arrives from the helper. The arms prove they render it as a dash rather than
  // as "Invalid Date" or the epoch — the two ways a nullable clock usually fails.
  it("SSR market-pulse renders a dash, not Invalid Date, for a null stamp", async () => {
    const { renderToString } = await import("react-dom/server")
    const { createElement } = await import("react")
    const C = (await import("@/app/insights/market-pulse/MarketPulseClient")).default
    const html = renderToString(createElement(C, { initialRows: [], fetchedAt: null }))
    expect(html).not.toMatch(/Invalid Date|Jan 1, 1970|Dec 31, 1969/)
    expect(html).toMatch(/Updated\s*(<!-- -->)?\s*—/)
  })

  it("SSR market-pulse NO-CHANGE CONTROL: a real stamp still renders as a date", async () => {
    const { renderToString } = await import("react-dom/server")
    const { createElement } = await import("react")
    const C = (await import("@/app/insights/market-pulse/MarketPulseClient")).default
    const html = renderToString(createElement(C, { initialRows: [], fetchedAt: STAMPED }))
    // ⚠ These two format month/day/time WITHOUT a year, unlike FreshnessStamp.
    expect(html).toMatch(/Sep 18, \d/)
  })

  it("SSR parallel-premiums renders a dash, not Invalid Date, for a null stamp", async () => {
    const { renderToString } = await import("react-dom/server")
    const { createElement } = await import("react")
    const C = (await import("@/app/insights/parallel-premiums/ParallelPremiumsBoardClient")).default
    const html = renderToString(
      createElement(C, { initialRows: [], initialFetchedAt: null, initialFailed: true }),
    )
    expect(html).not.toMatch(/Invalid Date|Jan 1, 1970|Dec 31, 1969/)
    expect(html).toMatch(/Updated\s*(<!-- -->)?\s*—/)
  })

  it("SSR parallel-premiums NO-CHANGE CONTROL: a real stamp still renders as a date", async () => {
    const { renderToString } = await import("react-dom/server")
    const { createElement } = await import("react")
    const C = (await import("@/app/insights/parallel-premiums/ParallelPremiumsBoardClient")).default
    const html = renderToString(
      createElement(C, { initialRows: [], initialFetchedAt: STAMPED, initialFailed: false }),
    )
    // ⚠ No year in this board's format either — see the market-pulse control.
    expect(html).toMatch(/Sep 18, \d/)
  })
})
