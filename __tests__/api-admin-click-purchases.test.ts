import { describe, it, expect, beforeEach, vi } from "vitest"

// GET /api/admin/click-purchases — operator-token-gated click → presumed-purchase board.
// Pins: 401 without the token; a FAILED read is a 500, never "0 purchases"; dollars
// count each SALE once (two clicks on one sale) and exclude "possible"; a capped list
// says it was capped; days is clamped.

const state: any = {}

vi.mock("@/lib/supabase", () => {
  const table = (name: string) => {
    const b: any = {
      select: () => b,
      gte: (_c: string, v: string) => { state.gte[name] = v; return b },
      order: () => b,
      limit: () => Promise.resolve(state.tables[name]),
    }
    return b
  }
  const client: any = { from: (n: string) => table(n) }
  return { supabaseAdmin: client, supabase: client }
})

import { GET, ptDateDaysAgo } from "@/app/api/admin/click-purchases/route"

const authed = (qs = "") =>
  ({ headers: new Headers({ authorization: "Bearer tok" }), nextUrl: new URL(`https://x.test/api/admin/click-purchases${qs}`) }) as any

const P = (click_id: number, sale_ref: string, confidence: string, price: number) => ({
  click_id, clicked_at: "2026-09-30T20:00:00Z", collection_slug: "nba_top_shot", sale_source: "sales", sale_ref,
  nft_id: "1", sold_at: "2026-09-30T20:10:00Z", price_usd: price, match: "same_moment", confidence,
  buyer_is_clicker: confidence === "confirmed", minutes_after_click: 10,
  outbound_clicks: { surface: "alert", source: "alert", channel: "telegram", player_name: "A", set_name: "B", ask_price_usd: price },
})

beforeEach(() => {
  process.env.RPC_ADMIN_TOKEN = "tok"
  state.gte = {}
  state.tables = {
    click_purchase_funnel_daily: {
      data: [
        { day_pt: "2026-09-30", source: "alert", surface: "alert", collection_slug: "nba_top_shot", clicks: "5", clicks_human: "4", clicks_internal: "1", purchases_confirmed: "1", purchases_likely: "1", purchases_possible: "1", sales_confirmed_or_likely: "1", usd_confirmed_or_likely: "2.00" },
        { day_pt: "2026-09-29", source: "site", surface: "sniper", collection_slug: "nba_top_shot", clicks: "3", clicks_human: "3", clicks_internal: "0", purchases_confirmed: "0", purchases_likely: "0", purchases_possible: "0", sales_confirmed_or_likely: "0", usd_confirmed_or_likely: "0" },
      ],
      error: null,
    },
    click_attributed_purchases: {
      // two clicks on the SAME sale s1 ($2), one possible on s2 ($9)
      data: [P(1, "s1", "confirmed", 2), P(2, "s1", "likely", 2), P(3, "s2", "possible", 9)],
      error: null,
    },
  }
})

describe("GET /api/admin/click-purchases", () => {
  it("401s without the operator token", async () => {
    const res = await GET({ headers: new Headers(), nextUrl: new URL("https://x.test/a") } as any)
    expect(res.status).toBe(401)
  })

  it("totals: clicks summed, dollars count each sale once and exclude possible", async () => {
    const body = await (await GET(authed())).json()
    expect(body.totals).toMatchObject({
      clicks: 8, clicks_human: 7, clicks_internal: 1,
      purchases_confirmed: 1, purchases_likely: 1, purchases_possible: 1,
      sales_confirmed_or_likely: 1, usd_confirmed_or_likely: 2,
    })
    expect(body.purchases[0]).toMatchObject({ surface: "alert", channel: "telegram", ask_price_usd: 2 })
    expect(body.purchases_truncated).toBe(false)
  })

  it("a FAILED funnel read is a 500 — never an empty board reading as zero purchases", async () => {
    state.tables.click_purchase_funnel_daily = { data: null, error: { message: "boom" } }
    const res = await GET(authed())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.totals).toBeUndefined()
  })

  it("a FAILED purchases read is a 500 too", async () => {
    state.tables.click_attributed_purchases = { data: null, error: { message: "boom" } }
    expect((await GET(authed())).status).toBe(500)
  })

  it("days is clamped to 1..90 and the funnel is read from that PT day", async () => {
    const body = await (await GET(authed("?days=5000"))).json()
    expect(body.days).toBe(90)
    expect(state.gte.click_purchase_funnel_daily).toBe(ptDateDaysAgo(90))
  })

  it("ptDateDaysAgo is a Pacific calendar date", () => {
    // 2026-10-01 05:00Z is still Sep 30 in PT
    expect(ptDateDaysAgo(0, new Date("2026-10-01T05:00:00Z"))).toBe("2026-09-30")
  })
})
