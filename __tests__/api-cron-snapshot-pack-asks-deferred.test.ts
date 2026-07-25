import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Deep drive of /api/cron/snapshot-pack-asks' DEFERRED after() body (the sibling
// test only pins auth + the 202 ack). This route loops SUPPORTED_PACK_COLLECTIONS,
// fetches the live pack book per collection, filters lowestAsk>0, upserts via
// upsert_pack_ask_state, and accumulates totals into log_pipeline_run. The legs
// worth pinning: per-collection error ISOLATION (one collection's fetch throw or
// RPC {error} must set ok:false + record a per_collection entry WITHOUT aborting
// the others), the lowestAsk>0 filter, total accumulation, and the swallowed
// log-throw.

let capturedAfter: null | (() => Promise<void>) = null
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { capturedAfter = fn } }
})

const rpc = vi.hoisted(() =>
  // See api-cron-alerts-dispatch-deferred: rest params + `any` so callers can
  // spread args in and read mock.calls[n][1].
  vi.fn(async (..._a: any[]): Promise<any> => ({ data: {}, error: null })),
)
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: (...a: any[]) => rpc(...a) } }))

const fetchImpl = vi.hoisted(() => ({ fn: async (_c: string, _o?: any): Promise<any> => ({ listings: [] }) }))
vi.mock("@/lib/packs/live-pack-listings", () => ({
  SUPPORTED_PACK_COLLECTIONS: ["topshot", "allday"],
  fetchLivePackListings: (c: string, o?: any) => fetchImpl.fn(c, o),
}))

import { POST } from "@/app/api/cron/snapshot-pack-asks/route"

const url = "https://t/api/cron/snapshot-pack-asks"

// Route the upsert RPC per collection-slug; log_pipeline_run recorded/failable.
const upsertByCollection: Record<string, any> = {}
const logImpl = { fn: async (): Promise<any> => ({ error: null }) }

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "tok"
  capturedAfter = null
  rpc.mockClear()
  for (const k of Object.keys(upsertByCollection)) delete upsertByCollection[k]
  logImpl.fn = async () => ({ error: null })
  fetchImpl.fn = async () => ({ listings: [] })
  rpc.mockImplementation(async (name: string, params?: any) => {
    if (name === "log_pipeline_run") return logImpl.fn()
    if (name === "upsert_pack_ask_state") {
      const impl = upsertByCollection[params.p_collection_slug]
      return impl ? impl(params) : { data: {}, error: null }
    }
    return { data: null, error: null }
  })
})

function logParams() {
  return rpc.mock.calls.find((c) => c[0] === "log_pipeline_run")?.[1]
}
async function drive() {
  const res = await POST(makeReq({ url, auth: "Bearer tok" }))
  expect(res.status).toBe(202)
  expect(typeof capturedAfter).toBe("function")
  await capturedAfter!()
}

describe("/api/cron/snapshot-pack-asks — deferred body", () => {
  it("401 without the bearer, after() never scheduled", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer nope" }))
    expect(res.status).toBe(401)
    expect(capturedAfter).toBeNull()
  })

  it("success across collections → totals accumulate, lowestAsk<=0 filtered, ok:true", async () => {
    fetchImpl.fn = async (c: string) => ({
      listings: [
        { distId: `${c}-1`, packListingId: "L1", lowestAsk: 10 },
        { distId: `${c}-2`, packListingId: "L2", lowestAsk: 0 }, // filtered out
      ],
    })
    upsertByCollection.topshot = () => ({ data: { total_listed: 5, new: 2, changed: 1, dropped: 1 }, error: null })
    upsertByCollection.allday = () => ({ data: { total_listed: 3, new: 1, changed: 0, dropped: 2 }, error: null })

    await drive()

    // Each upsert gets only the lowestAsk>0 listing.
    const upserts = rpc.mock.calls.filter((c) => c[0] === "upsert_pack_ask_state")
    expect(upserts).toHaveLength(2)
    expect(upserts[0][1].p_listings).toEqual([{ dist_id: "topshot-1", pack_listing_id: "L1", lowest_ask: 10 }])

    const p = logParams()
    expect(p.p_ok).toBe(true)
    expect(p.p_error).toBeNull()
    expect(p.p_rows_found).toBe(8) // 5 + 3 total_listed
    expect(p.p_rows_written).toBe(4) // (2+1) + (1+0) new+changed
    expect(p.p_rows_skipped).toBe(3) // 1 + 2 dropped
    expect((p.p_extra.per_collection as any).topshot.total_listed).toBe(5)
  })

  it("one collection's RPC { error } sets ok:false but the other still processes", async () => {
    fetchImpl.fn = async (c: string) => ({ listings: [{ distId: `${c}-1`, packListingId: "L1", lowestAsk: 4 }] })
    upsertByCollection.topshot = () => ({ data: null, error: { message: "upsert failed" } })
    upsertByCollection.allday = () => ({ data: { total_listed: 2, new: 2, changed: 0, dropped: 0 }, error: null })

    await drive()

    const p = logParams()
    expect(p.p_ok).toBe(false)
    // errMsg is set per FAILING collection; only topshot failed (allday succeeded
    // and does not overwrite), so the surfaced message is topshot's.
    expect(p.p_error).toBe("topshot: upsert failed")
    expect((p.p_extra.per_collection as any).topshot).toEqual({ error: "upsert failed" })
    expect((p.p_extra.per_collection as any).allday.total_listed).toBe(2) // the other collection still ran
    expect(p.p_rows_found).toBe(2)
  })

  it("a fetch THROW for one collection is isolated (ok:false, per_collection error, others continue)", async () => {
    fetchImpl.fn = async (c: string) => {
      if (c === "topshot") throw new Error("upstream 502")
      return { listings: [{ distId: "allday-1", packListingId: "L1", lowestAsk: 9 }] }
    }
    upsertByCollection.allday = () => ({ data: { total_listed: 1, new: 1, changed: 0, dropped: 0 }, error: null })

    await drive()

    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect((p.p_extra.per_collection as any).topshot.error).toContain("upstream 502")
    expect((p.p_extra.per_collection as any).allday.total_listed).toBe(1)
  })

  it("log_pipeline_run throwing is swallowed — callback never rejects", async () => {
    logImpl.fn = async () => { throw new Error("log write failed") }
    const res = await POST(makeReq({ url, auth: "Bearer tok" }))
    expect(res.status).toBe(202)
    await expect(capturedAfter!()).resolves.toBeUndefined()
  })
})
