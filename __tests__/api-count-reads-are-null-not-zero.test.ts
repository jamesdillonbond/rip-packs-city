import { describe, it, expect, vi, beforeEach } from "vitest"

// A COUNT we could not read must publish `null`, never `0`.
//
// ── THE TRAP ────────────────────────────────────────────────────────────────
// supabase-js RETURNS errors rather than throwing, so a count query that fails
// still RESOLVES, with `{ count: null, error }`. Every guard people reach for
// is therefore satisfied:
//
//   • `Promise.allSettled` reports `status: "fulfilled"`;
//   • a `try/catch` never fires;
//   • and `count ?? 0` turns the null into a confident zero.
//
// /api/overview-stats had the sharpest version. It already used `allSettled`
// deliberately — its own comment records that a single rejection in
// `Promise.all` once "sent the whole overview to 0/0/$0", landing Top Shot on
// an all-zero KPI strip. That fix bounds the BLAST RADIUS of a failure and does
// nothing about the failing leg itself asserting "there are none", because the
// realistic failure is not a rejection at all.
//
// ⚠ BOTH ARE LATENT, NOT LIVE, and the tests say so rather than implying a
// user-facing incident: no in-repo consumer renders `overview-stats`' fields,
// and the one consumer of /api/badges reads `json.editions` and ignores
// `meta.total`. They are fixed because both are documented endpoints whose
// field names promise a measurement — the same reasoning that fixed
// `meta.total_rows` on the insights routes, where the name was the defect.
//
// ⚠ WHICH HALF OF THE FIX IS LOAD-BEARING — recorded because a mutation
// survived and corrected the obvious reading. Both routes now branch on
// `error` before falling back, and that branch is REDUNDANT. Measured against
// every shape supabase-js produces:
//
//     { count: null, error: {…} }  ->  null  either way
//     { count: 0,    error: null } ->  0     either way
//     { count: 7,    error: null } ->  7     either way
//
// because a failed count nulls `count` as well as setting `error`. The change
// that removes the defect is `?? 0` becoming `?? null`; the error check is
// intent, not mechanism, and would only become load-bearing if supabase-js
// began returning a stale count alongside an error. Asserted as a COMPOSITE
// below — reverting the whole expression to the original `?? 0` shape reds two
// cases — rather than pretending the branch is doing the work.

const mockRpc = vi.fn()
const mockFrom = vi.fn()

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: (...a: unknown[]) => mockRpc(...a),
    from: (...a: unknown[]) => mockFrom(...a),
  },
}))

/** A head-count builder that resolves the way supabase-js really does. */
function countBuilder(result: { count: number | null; error: unknown }) {
  const b: Record<string, unknown> = {}
  for (const m of ["select", "eq", "or", "in", "gte", "lte", "order", "limit"]) {
    b[m] = () => b
  }
  // Thenable, so `await`ing the chain yields the result object.
  b.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res)
  return b
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRpc.mockResolvedValue({ data: [], error: null })
})

describe("/api/overview-stats — a failed count is not zero editions", () => {
  it("publishes null when the count RESOLVES with an error", async () => {
    // The realistic failure — not a rejection, which is why `allSettled` alone
    // could never have caught it.
    mockFrom.mockImplementation(() =>
      countBuilder({ count: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }),
    )
    const { GET } = await import("@/app/api/overview-stats/route")
    const res = await GET({ nextUrl: { searchParams: new URLSearchParams("collection=nba-top-shot") } } as never)
    const body = await res.json()

    expect(body.totalEditions).toBeNull()
    expect(body.highConfCount).toBeNull()
    // The defect, stated directly.
    expect(body.totalEditions).not.toBe(0)
  })

  it("a genuine zero is still published as 0", async () => {
    // The other direction. A collection really can have no HIGH-confidence
    // editions — UFC reads 0.0% and that is the honest answer — so turning
    // every zero into null would only move the dishonesty.
    mockFrom.mockImplementation(() => countBuilder({ count: 0, error: null }))
    const { GET } = await import("@/app/api/overview-stats/route")
    const res = await GET({ nextUrl: { searchParams: new URLSearchParams("collection=nba-top-shot") } } as never)
    const body = await res.json()

    expect(body.totalEditions).toBe(0)
    expect(body.highConfCount).toBe(0)
  })

  it("a real count passes through unchanged", async () => {
    mockFrom.mockImplementation(() => countBuilder({ count: 13211, error: null }))
    const { GET } = await import("@/app/api/overview-stats/route")
    const res = await GET({ nextUrl: { searchParams: new URLSearchParams("collection=nba-top-shot") } } as never)
    const body = await res.json()

    expect(body.totalEditions).toBe(13211)
  })

  it("one failed leg does not null the other — the allSettled isolation survives", async () => {
    // ⚠ This is the property the route's existing comment was written to
    // protect, and the fix must not cost it: the whole reason for `allSettled`
    // is that a slow FMV-HIGH count over a huge collection must not take the
    // edition count with it.
    let call = 0
    mockFrom.mockImplementation(() => {
      call += 1
      return call === 1
        ? countBuilder({ count: 13211, error: null })
        : countBuilder({ count: null, error: { message: "timeout" } })
    })
    const { GET } = await import("@/app/api/overview-stats/route")
    const res = await GET({ nextUrl: { searchParams: new URLSearchParams("collection=nba-top-shot") } } as never)
    const body = await res.json()

    expect(body.totalEditions).toBe(13211)
    expect(body.highConfCount).toBeNull()
  })
})
