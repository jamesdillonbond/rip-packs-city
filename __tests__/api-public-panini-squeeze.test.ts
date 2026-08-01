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
  board: [] as any[] | null,
  boardErr: null as any,
  cov: [] as any[] | null,
  covErr: null as any,
  feed: [] as any[] | null,
  feedErr: null as any,
}))

vi.mock("@/lib/supabase", () => {
  const make = (table: string) => {
    // Must be table-AWARE for every table the route reads. A catch-all `else` that returns
    // the board rows silently feeds board data into the coverage/feed blocks, so their
    // assertions pass against the wrong fixture.
    const result =
      table === "panini_coverage_summary"
        ? { data: state.cov, error: state.covErr }
        : table === "panini_sale_feed_status"
          ? { data: state.feed, error: state.feedErr }
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
  serial_low_ask_usd: 5, is_rookie: false, is_debut: false, serials_with_recorded_price: 2,
}
const COV = {
  total_editions: 1647, trustworthy_editions: 768, pct_trustworthy: 46.6,
  listing_gated_editions: 102, listing_gated_families: 12, families: 54,
  best_family_checklist_pct: 64.5, worst_family_checklist_pct: 8.6,
  checklist_players_seen: 487, checklist_players_new_24h: 26,
}

// Upstream stopped supplying serial sale prices on 2026-07-29, so this is the DEAD-feed
// shape (feed_ok false). serials_with_recorded_price is then a fossil count as of
// last_supplied_on rather than current price coverage.
const FEED = {
  last_supplied_on: "2026-07-28", days_since_last_supplied: 4, total_serials: 49208,
  priced_serials: 3925, preserved_fossils: 0, pct_serials_priced: 7.98, feed_ok: false,
}

beforeEach(() => {
  state.board = [ROW]; state.boardErr = null
  state.cov = [COV]; state.covErr = null
  state.feed = [FEED]; state.feedErr = null
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

// A SECOND, independent disclosure. Coverage is about which cards we have ever seen
// (listing-gated discovery). This one is about a field going dead: upstream stopped
// supplying brought_at_price on 2026-07-29, so serials_with_recorded_price — which this
// route still returns on every row — is a fossil count, not current price coverage.
describe("GET /api/public/insights/panini-squeeze — sale-price feed disclosure contract", () => {
  it("carries meta.sale_price_feed with the self-measured figures and the staleness note", async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.sale_price_feed).toMatchObject({
      last_supplied_on: "2026-07-28",
      days_since_last_supplied: 4,
      priced_serials: 3925,
      pct_serials_priced: 7.98,
      feed_ok: false,
    })
    const note = body.meta.sale_price_feed.note
    // Load-bearing: the count must be described as historical, not current coverage.
    expect(note).toMatch(/HISTORICAL count/i)
    expect(note).toMatch(/floor/i)
    // Equally load-bearing the OTHER way — without this a reader assumes FMV died too.
    // FMV comes from a separate upstream feed that is still live and still moving.
    expect(note).toMatch(/NOT affect fmv/i)
  })

  it("says the feed is healthy when upstream is supplying again", async () => {
    state.feed = [{ ...FEED, feed_ok: true, days_since_last_supplied: 0 }]
    const body = await (await GET(req())).json()
    expect(body.meta.sale_price_feed.note).toMatch(/supplying serial sale prices normally/i)
    expect(body.meta.sale_price_feed.note).not.toMatch(/HISTORICAL count/i)
  })

  it("is FAIL-SOFT: a feed-status error nulls the block but still serves the board", async () => {
    state.feedErr = { message: "feed view missing" }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.sale_price_feed).toBeNull()
    expect(body.rows).toHaveLength(1) // board still served — the disclosure is never load-bearing
  })

  it("nulls the block when the status view returns no row", async () => {
    state.feed = []
    const body = await (await GET(req())).json()
    expect(body.meta.sale_price_feed).toBeNull()
  })
})
