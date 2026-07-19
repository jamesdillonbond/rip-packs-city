import { describe, it, expect, beforeEach, vi } from "vitest"

// Route test for GET /api/public/insights/panini-squeeze — the public JSON behind the
// (still proxy-gated) Panini squeeze board.
//
// The contract that matters here is meta.coverage. Panini publishes no full checklist, so
// an edition enters our index only once it has been LISTED — completeness is structurally
// partial. Carrying the coverage figures in the response CONTRACT (not just the UI) is what
// stops a consumer rendering this board as a census by accident. It must also be FAIL-SOFT:
// the board rows are the primary payload, so a coverage-query error omits the block rather
// than 500-ing the whole response.

const state = vi.hoisted(() => ({
  board: [] as any[],
  boardErr: null as any,
  cov: [] as any[],
  covErr: null as any,
}))

vi.mock("@/lib/supabase", () => {
  const make = (table: string) => {
    const result =
      table === "panini_coverage_summary"
        ? { data: state.cov, error: state.covErr }
        : { data: state.board, error: state.boardErr }
    const p: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (resolve: any) => resolve(result)
          return () => p
        },
      },
    )
    return p
  }
  return { supabaseAdmin: { from: (t: string) => make(t) } }
})

import { GET } from "@/app/api/public/insights/panini-squeeze/route"

const req = (qs = "") => ({ url: "https://t/api/public/insights/panini-squeeze" + qs }) as any

const ROW = {
  player_name: "Khuliso Mudau", set_name: "Base Prizms Red", tier: "COMMON", mint_cap: 124,
  pulled_count: 108, still_in_packs: 16, rip_pct: 87.1, fmv_usd: 5, sealed_fmv_exposure_usd: 80,
  serial_low_ask_usd: 5, is_rookie: false, is_debut: false, real_sales: 2,
}
const COV = {
  total_editions: 1647, trustworthy_editions: 768, pct_trustworthy: 46.6,
  listing_gated_editions: 102, listing_gated_families: 12, families: 54,
  best_family_checklist_pct: 64.5, worst_family_checklist_pct: 8.6,
  checklist_players_seen: 487, checklist_players_new_24h: 26,
}

beforeEach(() => {
  state.board = [ROW]; state.boardErr = null
  state.cov = [COV]; state.covErr = null
})

describe("GET /api/public/insights/panini-squeeze — param guard", () => {
  it("400s on an invalid tier", async () => {
    const res = await GET(req("?tier=BOGUS"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/invalid tier/i)
  })

  it("500s when the backing board query errors", async () => {
    state.boardErr = { message: "board exploded" }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("board exploded")
  })
})

describe("GET /api/public/insights/panini-squeeze — coverage disclosure contract", () => {
  it("carries meta.coverage with the self-measured figures and the honesty note", async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toHaveLength(1)
    expect(body.meta.coverage).toMatchObject({
      total_editions: 1647,
      pct_trustworthy: 46.6,
      listing_gated_editions: 102,
      listing_gated_families: 12,
      families: 54,
      basis: "listing_gated",
      // The RANGE is the honest headline — a single percentage reads as "we have X% of
      // the set", which is wrong in both directions (best family ~65%, worst ~9%).
      best_family_checklist_pct: 64.5,
      worst_family_checklist_pct: 8.6,
      checklist_players_seen: 487,
      checklist_players_new_24h: 26,
    })
    // The note is the load-bearing bit — it must say this is not a census.
    expect(body.meta.coverage.note).toMatch(/floor, not a census/i)
    expect(body.meta.coverage.note).toMatch(/no full checklist/i)
    // Anti-misreading guards, added after a self-audit. pct_trustworthy is a COMPOSITION
    // share, not a coverage %, and the checklist denominator is discovered data that is
    // still growing — so percent-of-checklist figures are best-case. If someone strips
    // either caveat from the note, this fails.
    expect(body.meta.coverage.note).toMatch(/COMPOSITION share/i)
    expect(body.meta.coverage.note).toMatch(/LOWER bound/i)
  })

  it("is FAIL-SOFT: a coverage error nulls the block but still serves the board", async () => {
    state.covErr = { message: "coverage view missing" }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.coverage).toBeNull()
    expect(body.rows).toHaveLength(1) // board still served — coverage is never load-bearing
  })

  it("nulls coverage when the summary view returns no row", async () => {
    state.cov = []
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).meta.coverage).toBeNull()
  })
})
