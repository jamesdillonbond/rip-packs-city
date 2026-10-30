import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeSupabaseFixture } from "./helpers/route-harness"

// #215 (2026-10-30) — a capped ASK_ONLY price (_salescap / _histcap) is a SALES
// figure, but the Market page marked it "from asks". The edition-market RPCs do
// not return algo_version, so /api/market reads the latest snapshot per ASK_ONLY
// edition and sets `fmvCapped` — only when that snapshot IS the row's price.

const state = vi.hoisted(() => ({ sb: null as unknown }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))

import { GET } from "@/app/api/market/route"

const ALLDAY = "dee28451-5d62-409e-a1ad-a83f763ac070"
const req = (u: string) => ({ nextUrl: new URL(u) }) as never

const row = (o: Record<string, unknown>) => ({
  edition_id: "e1", external_id: "ad-1", player_name: "Capped Player", team_name: "T",
  set_name: "Base", series_name: "1", tier: "RARE", circulation_count: 100, floor_ask: 8000,
  listed_count: 1, fmv_usd: 114, discount_pct: null, confidence: "ASK_ONLY", thumbnail_url: null,
  badges: null, last_listed_at: "2026-10-01T00:00:00Z", ...o,
})

function install(rows: unknown[], wide: { data: unknown; error: unknown }) {
  state.sb = makeSupabaseFixture({
    "rpc:get_allday_market_editions_v4": { data: rows, error: null },
    "rpc:get_editions_latest_fmv_wide": wide,
    editions: { data: [], error: null },
  } as never)
}

async function listings() {
  const res = await GET(req(`https://t/api/market?collectionId=${ALLDAY}`))
  expect(res.status).toBe(200)
  const body = await res.json()
  return body.listings as Array<{ playerName: string; fmvCapped: boolean | null }>
}

beforeEach(() => { state.sb = null })

describe("GET /api/market — fmvCapped on ASK_ONLY edition rows (#215)", () => {
  it("flags a _salescap price as capped", async () => {
    install([row({})], { data: [{ edition_id: "e1", fmv_usd: 114, algo_version: "allday-v7_salescap" }], error: null })
    expect((await listings())[0].fmvCapped).toBe(true)
  })

  it("an uncapped ASK_ONLY price is false, not capped", async () => {
    install([row({})], { data: [{ edition_id: "e1", fmv_usd: 114, algo_version: "allday-v7" }], error: null })
    expect((await listings())[0].fmvCapped).toBe(false)
  })

  it("does not pair a snapshot whose price differs from the row's (a different snapshot)", async () => {
    install([row({})], { data: [{ edition_id: "e1", fmv_usd: 120, algo_version: "allday-v7_salescap" }], error: null })
    expect((await listings())[0].fmvCapped).toBeNull()
  })

  it("a failed snapshot read leaves every row unchecked, and the market still answers", async () => {
    install([row({})], { data: null, error: { message: "timeout" } })
    const l = await listings()
    expect(l[0].playerName).toBe("Capped Player")
    expect(l[0].fmvCapped).toBeNull()
  })
})
