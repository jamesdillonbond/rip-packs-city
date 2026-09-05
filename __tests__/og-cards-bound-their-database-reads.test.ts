import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { stripCommentsWithState } from "../scripts/lib/strip-comments.mjs"

/**
 * NO OG CARD MAY WAIT FOREVER FOR A **DATABASE** READ.
 *
 * ── THE GAP, AND IT WAS A GAP BETWEEN TWO GUARDS THAT EACH LOOKED COMPLETE ──
 * `og-fetches-are-bounded` bans a bare `fetch()` under `app/api/og/**` and
 * `lib/og/**`. `api-routes-that-degrade-honestly-also-bound-their-reads` ratchets
 * unbounded Supabase reads. **Neither could see these 16 sites**, and the reason
 * is worth stating because it is the shape CLAUDE.md warns about — *an exclusion
 * justified by ANOTHER instrument is a claim about it; check that one can SEE the
 * property*:
 *
 *   - the OG guard walks the right directories but matches `fetch`, not `.rpc` /
 *     `.from`;
 *   - the ratchet matches the right calls but its POPULATION is "routes that call
 *     `apiErrorResponse()`/`boardUnavailable()`". An OG card returns `null` and
 *     falls back to a generic card — it never calls either — so every one of
 *     these routes was outside that population by construction, not by exemption.
 *
 * Measured 2026-09-04: **10 files, 16 read sites, ZERO bounded.**
 *
 * ── WHY IT MATTERS HERE MORE THAN ON A PAGE ────────────────────────────────
 * A card renders while a social crawler holds the connection, and the crawler
 * gives up long before Postgres does. `get_pack_lifecycle` — reached from
 * `app/api/og/pack/lifecycle` — measures a **3,129 ms mean and a 29,949 ms max**
 * over 10,455 calls, and that max is the 30 s `statement_timeout`, i.e. those
 * calls were killed. Unbounded, the card burns 30 s of lambda to render nothing
 * for an audience that left at 10.
 *
 * ⚠ Bounding these changed no COPY and introduced no new claim. Every site
 * already degraded on `{ data: null, error }` — to a generic card, or (on the two
 * `/insights` cards) to `fetched = false` / a withheld total. `boundedRead`
 * resolves into that same envelope, so a timeout now lands exactly where a
 * Postgrest error already landed. It converts a HANG into the existing honest
 * path; it does not invent one. That was checked per call site before shipping,
 * the same way the `fetch` bound was.
 *
 * ⚠ THE BUDGET IS THE OG ONE (`OG_FETCH_TIMEOUT_MS`, 10 s), not `boundedRead`'s
 * 8 s default. Same context, same trade, one number: a card waits this long for
 * ONE read before rendering degraded. If that number moves, it moves for fetches
 * and DB reads together.
 */

const ROOTS = [path.join(process.cwd(), "app/api/og"), path.join(process.cwd(), "lib/og")]

/**
 * ⚠ THE QUOTE IN THIS PATTERN IS LOAD-BEARING AND IT IS NOT STYLE.
 *
 * The first version of this detector matched a bare `\.from\(`, and it reported
 * `lib/og/img-data.ts` as an unbounded DB read. That file has no database access
 * at all — the match was **`Buffer.from(await res.arrayBuffer())`**. `Array.from`
 * and `Object.fromEntries` are the same trap.
 *
 * A supabase table read always names its table as a STRING literal; the JS
 * builtins take a buffer, an iterable or an array. Requiring the quote separates
 * them exactly. **A census that over-counts is still a wrong census** — it had me
 * one edit away from publishing "11 files" for a population of 10.
 */
const DB_READ = /\.rpc\(\s*["'`]|\.from\(\s*["'`]/g

/** Any of the repo's read-budget primitives. */
const BOUND = /boundedRead|withBoardBudget|withPagedBoardBudget|BOARD_LIVE_TIMEOUT_MS|OG_FETCH_TIMEOUT_MS/

export function dbReadSites(code: string): number {
  return (code.match(DB_READ) || []).length
}
export function looksBounded(code: string): boolean {
  return BOUND.test(code)
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(p)) out.push(p)
  }
  return out
}

type Row = { file: string; sites: number; bounded: boolean; stripped: boolean }

const FILES = ROOTS.flatMap((r) => walk(r))
const ROWS: Row[] = []
for (const file of FILES) {
  const raw = readFileSync(file, "utf8")
  const st = stripCommentsWithState(raw)
  // ⚠ A file the stripper leaves in `sq`/`dq` KEEPS its comments rather than
  // losing code — the safe direction, and the one the DEFECT-4 ratchet pins. So
  // it is still analysed. SKIPPING it would UNDER-report, which is the unsafe
  // direction: my first census did exactly that and could have hidden a site.
  const sites = dbReadSites(st.code)
  if (sites === 0) continue
  ROWS.push({ file: path.relative(process.cwd(), file), sites, bounded: looksBounded(st.code), stripped: st.endState === "code" && st.tplDepth === 0 })
}

describe("the detector, before anything is measured with it", () => {
  it("sees an unbounded DB read and does not see a bounded one", () => {
    const unbounded = `const { data } = await sb.rpc("get_thing", { p: 1 })`
    const bounded = `const { data } = await boundedRead(sb.rpc("get_thing", { p: 1 }), "og/x", OG_FETCH_TIMEOUT_MS)`
    expect(dbReadSites(unbounded)).toBe(1)
    expect(looksBounded(unbounded)).toBe(false)
    expect(dbReadSites(bounded)).toBe(1)
    expect(looksBounded(bounded)).toBe(true)
  })

  it("does NOT mistake Buffer.from / Array.from for a table read", () => {
    // The exact false positive this detector shipped with. See DB_READ's header.
    expect(dbReadSites(`const buf = Buffer.from(await res.arrayBuffer())`)).toBe(0)
    expect(dbReadSites(`const xs = Array.from(new Set(ys))`)).toBe(0)
    expect(dbReadSites(`const o = Object.fromEntries(m)`)).toBe(0)
    expect(dbReadSites(`sb.from("candy_secondary_board")`)).toBe(1)
  })

  it("walked a real tree and found a real population", () => {
    // Satisfiable at a population of zero unbounded — but NOT at a population of
    // zero files, which would mean the walker broke and every ban below passed
    // vacuously.
    expect(FILES.length, "no OG source files found — the walker is broken").toBeGreaterThan(20)
    expect(ROWS.length, "no OG file reads the database — the detector is broken").toBeGreaterThan(5)
  })
})

describe("every OG card bounds the database read it degrades on", () => {
  it("has ZERO unbounded DB reads (a ban, not a ratchet)", () => {
    const offenders = ROWS.filter((r) => !r.bounded)
    expect(
      offenders.map((o) => `${o.file} (${o.sites} read site${o.sites > 1 ? "s" : ""})`),
      "An OG card renders while a social crawler holds the connection. Unbounded, " +
        "a slow read burns the whole lambda and the crawler gets nothing. Wrap it in " +
        "boundedRead(..., OG_FETCH_TIMEOUT_MS) — it resolves to the same { data, error } " +
        "these routes already destructure, so a timeout lands on the branch that is " +
        "already there.",
    ).toEqual([])
  })

  it("reports how many sites it is actually holding", () => {
    // A ban that inspected nothing would pass. Assert the COUNT it inspected —
    // CLAUDE.md: ask what RUNS a guard, and assert the count it inspected.
    const sites = ROWS.reduce((a, r) => a + r.sites, 0)
    expect(sites, `only ${sites} DB read sites seen under app/api/og + lib/og`).toBeGreaterThanOrEqual(16)
  })
})
