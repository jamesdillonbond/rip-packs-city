import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import path from "path"

// ARCHITECTURE GUARD — FMV recalc PostgREST .in() chunking.
//
// Per CLAUDE.md (fmv-recalc silent stall, RESOLVED dd84526): an unchunked
// `.in("edition_id", …)` on a ~1,100-edition page blew past PostgREST's URL cap
// and supabase-js surfaced it as a non-throwing deleteError, so the route
// crashed silently inside after() before log_pipeline_run — a fully invisible
// stall. The fix chunks every `.in()` site at 500 (PostgREST also clamps an
// unpaginated response to 1000 rows, so 500 is the safe chunk).
//
// This guard reads the route source and asserts every *_CHUNK constant stays
// <= 500 and that the known chunk sites still exist — so re-introducing a large
// or removed chunk (the exact regression that caused the stall) fails here.

const REPO = process.cwd()
const ROUTE = path.join(REPO, "app", "api", "fmv-recalc", "route.ts")
const MAX_CHUNK = 500

const src = readFileSync(ROUTE, "utf8")

function chunkConstants(): { name: string; value: number }[] {
  const re = /const\s+(\w*CHUNK\w*)\s*=\s*(\d+)/g
  const out: { name: string; value: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.push({ name: m[1], value: Number(m[2]) })
  return out
}

describe("invariant: fmv-recalc chunks every .in() at <= 500", () => {
  const chunks = chunkConstants()

  it("still declares the id/meta/ask chunk constants (chunking not removed)", () => {
    const names = chunks.map((c) => c.name)
    expect(names).toEqual(expect.arrayContaining(["IN_CHUNK", "META_CHUNK", "ASK_CHUNK"]))
  })

  it("no chunk size exceeds the 500-row PostgREST-safe bound", () => {
    const offenders = chunks.filter((c) => c.value > MAX_CHUNK)
    expect(
      offenders,
      `These chunk sizes risk the silent PostgREST truncation/URL-cap stall:\n` +
        offenders.map((o) => `  ${o.name} = ${o.value}`).join("\n"),
    ).toEqual([])
  })

  // ── 2026-08-03: the SAME 1000-row cap, one layer up ────────────────────────
  // The chunk guards above covered every `.in()` site but not the edition PAGE
  // fetch. `fmv_recalc_edition_page` was called over PostgREST with p_limit=2500,
  // PostgREST clamped the result to 1000, and `hasMore = length === limit` read
  // false → cursor_after=null → every run restarted at offset 0. 74% of the
  // actively-traded catalogue went un-repriced for as long as the cursor existed,
  // with ok=true on every run. These guards make that regression fail here.
  describe("page size stays under the PostgREST 1000-row cap", () => {
    function constant(name: string): number {
      const m = new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)`).exec(src)
      if (!m) throw new Error(`${name} not found in fmv-recalc route`)
      return Number(m[1])
    }

    it("DEFAULT_LIMIT is below the cap", () => {
      expect(
        constant("DEFAULT_LIMIT"),
        "A page at/over 1000 is silently truncated by PostgREST; hasMore then " +
          "reads false and the sweep cursor resets to 0 on every run.",
      ).toBeLessThan(1000)
    })

    it("an explicit body.limit cannot exceed the cap either", () => {
      expect(
        constant("MAX_PAGE_LIMIT"),
        "body.limit is clamped to MAX_PAGE_LIMIT — above 1000 a manual call " +
          "re-triggers the truncation and re-breaks the cursor.",
      ).toBeLessThan(1000)
      // The clamp must actually be wired to MAX_PAGE_LIMIT, not a bare literal.
      expect(src).toMatch(/Math\.min\(.*MAX_PAGE_LIMIT/)
    })

    it("limit parsing is NaN-guarded (Math.min does not sanitize NaN)", () => {
      expect(src).toMatch(/Number\.isFinite\(\s*rawLimit\s*\)/)
    })

    it("hasMore uses >= so a truncated page cannot read as 'no more pages'", () => {
      const m = /const\s+hasMore\s*=\s*pageEditionIds\.length\s*(===?|>=)\s*limit/.exec(src)
      expect(m, "hasMore comparison not found — did the pagination shape change?").toBeTruthy()
      expect(
        m![1],
        "`=== limit` reads false whenever the page is truncated BELOW the " +
          "requested limit — the exact silent failure of 2026-08-03.",
      ).toBe(">=")
    })

    it("logs pagination state so a stalled cursor is visible in pipeline_runs.extra", () => {
      expect(src).toMatch(/page_size:/)
      expect(src).toMatch(/has_more:/)
    })
  })

  it("each chunked loop paginates and logs on error (fatal path reaches log_pipeline_run)", () => {
    // The dd84526 fix added log_pipeline_run to the fatal-catch + chunk error
    // paths so a future silent stall surfaces in pipeline_runs. Guard that the
    // route still references both, so the observability isn't refactored away.
    expect(src).toMatch(/log_pipeline_run/)
    expect(src).toMatch(/chunkErr|chunk fetch error/)
  })
})
