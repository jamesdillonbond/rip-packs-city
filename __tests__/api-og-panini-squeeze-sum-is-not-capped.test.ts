import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { installOgCapture, resetOgCapture, ogText, type OgCapture } from "./helpers/og-capture"

// ─────────────────────────────────────────────────────────────────────────────
// /api/og/insights/panini-squeeze — an EXACT count next to a CAPPED sum.
//
// ── THE DEFECT (measured live 2026-09-03) ───────────────────────────────────
// The card read `.select("sealed_fmv_exposure_usd", { count: "exact" })` with no
// bound and summed the returned rows in JS. PostgREST caps an unbounded
// `.select()` at 1,000 rows and reports no error, while `count: "exact"` is a
// real COUNT(*) over the whole view. So the card paired an exact edition count
// with a sum over the first 1,000 rows in PHYSICAL order:
//
//     view holds 4,813 rows totalling  $2,358,840
//     the card published                 $143,849   ← 16.4x low
//     …beside "4,813 editions", which was correct
//
// ⛔ The PAIRING is what makes it worse than either half alone: an exact count
// sitting next to a truncated sum reads as one coherent measurement. And this is
// a SOCIAL CARD, so the number travels without the page around it.
//
// ⚠ WHY THE ROUTE'S `catch` COULD NEVER HAVE CAUGHT IT: supabase-js RESOLVES
// with `{ data, error }` rather than throwing. The cap does not even set `error`
// — the read simply SUCCEEDS and returns fewer rows than exist. Nothing at
// runtime distinguishes it from a small board.
//
// ── WHAT IS PINNED ──────────────────────────────────────────────────────────
// 1. the sum covers every page, not the first one
// 2. a walk that cannot be completed publishes NOTHING rather than a partial
// 3. a genuinely small board still publishes (over-correcting is its own defect)
// ─────────────────────────────────────────────────────────────────────────────

const capture: { c: OgCapture | null } = { c: null }

type Row = { sealed_fmv_exposure_usd: number | null }

/**
 * A supabase stub that PAGES like PostgREST: `.range(from, to)` returns that
 * slice, and `count` is the exact population on the first call.
 *
 * ⚠ `failFromPage` fails a page by RESOLVING with `{ error }` — the shape
 * supabase-js actually produces. A stub that threw would prove the route
 * survives something that cannot happen.
 */
function mockBoard(opts: { total: number; perRow: number; failFromPage?: number }) {
  const all: Row[] = Array.from({ length: opts.total }, () => ({
    sealed_fmv_exposure_usd: opts.perRow,
  }))
  // ⚠ SHARED ACROSS BUILDERS. The route calls `.from()` once PER PAGE, so a
  // counter scoped inside `from()` resets every page and the table never appears
  // to move — which let the missing-`.order()` mutant survive. Measured.
  const shared = { call: 0 }
  vi.doMock("@/lib/supabase", () => ({
    supabaseAdmin: {
      from: () => {
        const b: Record<string, unknown> = {}
        const chain = () => b
        // ⚠ MODELS PHYSICAL ORDER. An unordered `.range()` does not read the
        // right rows twice — it reads SOME rows twice and skips others, and
        // because the duplicates and omissions cancel, a count-based check
        // still passes. So this stub only serves a stable window when the read
        // asked for a deterministic order; without one it rotates the table
        // between calls, which is what Postgres is free to do. A mock that
        // sliced positionally regardless made the missing `.order()` invisible
        // — measured: that mutant SURVIVED until this was added.
        let ordered = false
        Object.assign(b, {
          select: chain,
          not: chain,
          order: (col: string) => {
            if (col === "id") ordered = true
            return b
          },
          // The top-3 leaderboard read ends in .limit()
          limit: async () => ({ data: [], error: null }),
          range: async (from: number, to: number) => {
            const page = Math.floor(from / 1000)
            if (opts.failFromPage != null && page >= opts.failFromPage) {
              return { data: null, count: null, error: { message: "statement timeout" } }
            }
            const off = shared.call * 137
            const view = ordered ? all : all.slice(off).concat(all.slice(0, off))
            shared.call++
            return { data: view.slice(from, to + 1), count: opts.total, error: null }
          },
        })
        return b
      },
    },
  }))
}

/** Distinct per-row values, so a wrong SET of rows produces a wrong SUM. With a
 *  constant value the overlaps and omissions cancel exactly and the defect is
 *  unobservable — which is the whole reason unordered paging survives review. */
function mockBoardDistinct(total: number) {
  const all: Row[] = Array.from({ length: total }, (_, i) => ({ sealed_fmv_exposure_usd: i + 1 }))
  const shared = { call: 0 }
  vi.doMock("@/lib/supabase", () => ({
    supabaseAdmin: {
      from: () => {
        const b: Record<string, unknown> = {}
        const chain = () => b
        let ordered = false
        Object.assign(b, {
          select: chain,
          not: chain,
          order: (col: string) => {
            if (col === "id") ordered = true
            return b
          },
          limit: async () => ({ data: [], error: null }),
          range: async (from: number, to: number) => {
            const off = shared.call * 137
            const view = ordered ? all : all.slice(off).concat(all.slice(0, off))
            shared.call++
            return { data: view.slice(from, to + 1), count: total, error: null }
          },
        })
        return b
      },
    },
  }))
}

async function renderText(): Promise<string> {
  const { GET } = await import("@/app/api/og/insights/panini-squeeze/route")
  await GET({} as never)
  return ogText(capture.c!.element())
}

/** The neutral tagline the card falls back to when it has no figure to stand behind. */
const TAGLINE = "still-in-packs supply + FMV"

beforeEach(() => {
  resetOgCapture()
  capture.c = installOgCapture()
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  vi.resetModules()
  vi.doUnmock("@/lib/supabase")
  vi.restoreAllMocks()
  resetOgCapture()
})

describe("panini-squeeze OG card does not pair an exact count with a capped sum", () => {
  it("sums EVERY page, not the first 1,000 rows", async () => {
    // 4,813 rows at $490 each — the real population size, so the regression this
    // pins is the one that shipped rather than a toy.
    mockBoard({ total: 4813, perRow: 490 })
    const text = await renderText()

    expect(text).toContain("4,813 editions")
    // $2,358,370 = 4813 * 490. The capped read would have said $490,000.
    expect(text).toContain("$2,358,370")
    expect(
      text,
      "the first-1000 sum is the defect — it must not be what the card publishes",
    ).not.toContain("$490,000")
  })

  it("a walk it cannot finish publishes NOTHING, not a partial total", async () => {
    // Page 0 succeeds, page 1 fails: the old code would have rendered the page-0
    // subtotal as if it were the whole board — the same defect one order smaller.
    mockBoard({ total: 4813, perRow: 490, failFromPage: 1 })
    const text = await renderText()

    expect(text).toContain(TAGLINE)
    expect(text).not.toContain("editions ·")
    expect(text, "a partial sum must never render as a total").not.toContain("$490,000")
  })

  it("pages on a DETERMINISTIC key, so the walk cannot re-read and skip rows", async () => {
    // 2,500 rows valued 1..2500 => 3,126,250. Under an unordered `.range()` the
    // stub rotates the table between calls, so the walk double-counts some rows
    // and misses others and the sum lands elsewhere — while the ROW COUNT still
    // comes out right, which is exactly why this class survives count checks.
    mockBoardDistinct(2500)
    const text = await renderText()
    expect(text).toContain("2,500 editions")
    expect(text).toContain("$3,126,250")
  })

  it("NO-CHANGE CONTROL: a genuinely small board still publishes its figures", async () => {
    // Without this, withholding unconditionally would satisfy both cases above,
    // and a guard that can be passed by deleting the feature is not a guard.
    mockBoard({ total: 12, perRow: 100 })
    const text = await renderText()

    expect(text).toContain("12 editions")
    expect(text).toContain("$1,200")
    expect(text).not.toContain(TAGLINE)
  })
})
