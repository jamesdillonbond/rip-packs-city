import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/cron/panini-ingest (POST push ingest).
// Auth: Bearer INGEST_SECRET_TOKEN exactly, else 401. Body { cards[], packs[] }.
// The upserts + log_pipeline_run run inside after() (stubbed no-op), so the 202
// ack is observable without DB I/O. Empty body => 202 { accepted:false, skipped }.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})

// The route imports supabaseAdmin from @/lib/supabase, which calls createClient
// at module load — stub the seam so import doesn't touch the network.
vi.mock("@supabase/supabase-js", () => {
  const sb: any = {}
  for (const m of ["from", "select", "eq", "in", "order", "limit", "gte", "lte", "lt", "gt", "is", "not", "or", "range", "match", "insert", "update", "upsert", "delete", "returns"]) sb[m] = () => sb
  sb.single = async () => ({ data: {}, error: null })
  sb.maybeSingle = async () => ({ data: {}, error: null })
  sb.rpc = async () => ({ data: null, error: null })
  sb.then = (resolve: any) => resolve({ data: [], error: null })
  return { createClient: () => sb }
})

import { POST } from "@/app/api/cron/panini-ingest/route"

const url = "https://t/api/cron/panini-ingest"
const savedIngest = process.env.INGEST_SECRET_TOKEN

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
})
afterEach(() => {
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
})

describe("POST /api/cron/panini-ingest — auth guard", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(makeReq({ url }))).status).toBe(401)
  })
  it("401s with a wrong bearer token", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer wrong" }))).status).toBe(401)
  })
})

describe("POST /api/cron/panini-ingest — empty body no-op", () => {
  it("202s accepted:false skipped:empty with a valid token and no rows", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret", body: {} }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(false)
    expect(body.skipped).toBe("empty")
  })
})

describe("POST /api/cron/panini-ingest — happy path (accept, work deferred)", () => {
  it("202s accepted:true and echoes the batch counts", async () => {
    const payload = {
      cards: [
        { sku: "packcard-2332_1_1_13", psku: "packcard-2332_1_1_13", athlete: "Test Player", cardset: "Base Silver", card_rarity: "Uncommon", end_seq: 259, market_stats: { with_collectors_count: 100, unopened_pack_count: 159, for_sale_count: 4, burned_count: 0, floor_price: 6, recent_sale: 5, volume_txns: 3, avg_sale: 5.5 } },
      ],
      packs: [
        { pack_sku: "1038", pack_name: "WC Prizm Hobby", cards_per_subpack: 5, total_pack_qty: 50480, market_stats: { unopen_pack_count: 9504 } },
      ],
    }
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret", body: payload }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.cards).toBe(1)
    expect(body.packs).toBe(1)
  })

  it("202s accepted:true when market fields are TOP-LEVEL (not nested under market_stats)", async () => {
    // live-verified 2026-07-16: some feed shapes expose avg_sale/end_seq/etc directly on the card
    const payload = {
      cards: [
        { sku: "packcard-2332_2_2_87", psku: "packcard-2332_2_2_87", athlete: "Top Level", cardset: "Prizmania", card_rarity: "Epic", end_seq: 25, with_collectors_count: 20, unopened_pack_count: 5, for_sale_count: 1, burned_count: 0, floor_price: 36, recent_sale: 25, volume_txns: 4, avg_sale: 27.5 },
      ],
    }
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret", body: payload }))
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)
  })
})
