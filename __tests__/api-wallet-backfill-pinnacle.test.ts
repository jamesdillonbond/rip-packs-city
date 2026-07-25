import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/wallet-backfill-pinnacle. Bearer INGEST_SECRET_TOKEN
// gated → fail-closed 401, then the body guards. Beyond that this drives BOTH
// execution modes by mocking runPinnacleDetailsBackfill (an earlier revision of this
// test called sync mode untestable "because it needs live Cadence" — it only
// needs the helper stubbed):
//   • default → 202 fire-and-forget, with the deferred after() body captured and
//     run so its record_wallet_backfill_scan call (and that call failing) is
//     covered rather than skipped;
//   • ?sync=true → the inline checkpoint payload: complete / next_checkpoint,
//     the max_duration_ms clamp to [30s, 540s], and the ?checkpoint= resume.
// Also pins the force flag (body OR query) forcing skip_cached false, and the
// resolveWalletInput rejection → 400.

const st = vi.hoisted(() => ({
  cap: null as null | (() => Promise<void>),
  result: { rowsFound: 12, complete: true, nextStartIndex: null as number | null },
  runArgs: [] as any[],
  scanCalls: [] as any[],
  scanThrows: false,
  resolve: { ok: true, wallet: "0xbd94cade097e50ac", input: "", reason: null } as any,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: any) => { st.cap = fn } }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string, args: any) => {
      if (name === "record_wallet_backfill_scan") {
        if (st.scanThrows) throw new Error("scan rpc down")
        st.scanCalls.push(args)
      }
      return { data: null, error: null }
    },
    from: () => ({}),
  },
}))
vi.mock("@/lib/chains/flow/wallet-backfill-helpers", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  isStorageLimitError: () => false,
  isNoCollectionCapabilityError: () => false,
  resolveWalletInput: async () => st.resolve,
  runPinnacleDetailsBackfill: async (args: any) => { st.runArgs.push(args); return st.result },
}))

import { POST } from "@/app/api/wallet-backfill-pinnacle/route"

const url = "https://t/api/wallet-backfill-pinnacle"
const TOKEN = "test-ingest-secret"
const req = (headers: Record<string, string> = {}, body: any = {}) =>
  ({ headers: new Headers(headers), json: async () => body }) as any

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  st.cap = null
  st.result = { rowsFound: 12, complete: true, nextStartIndex: null }
  st.runArgs = []
  st.scanCalls = []
  st.scanThrows = false
  st.resolve = { ok: true, wallet: "0xbd94cade097e50ac", input: "", reason: null }
})
afterEach(() => { delete process.env.INGEST_SECRET_TOKEN })

describe("POST /api/wallet-backfill-pinnacle — auth + body guards", () => {
  it("401s without the bearer token", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    expect((await POST(req())).status).toBe(401)
  })
  it("401s with a wrong bearer token", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer wrong", body: { wallet: "0xbd94cade097e50ac" } }))).status).toBe(401)
  })
  it("400s on malformed JSON", async () => {
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}`, badJson: true }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })
  it("400s on a missing wallet field", async () => {
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}`, body: {} }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet field required")
  })
  it("400s when the wallet input cannot be resolved", async () => {
    st.resolve = { ok: false, error: "not a wallet", input: "bogus", reason: "bad_format" }
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}`, body: { wallet: "bogus" } }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("not a wallet")
    expect(body.reason).toBe("bad_format")
  })
})

describe("POST /api/wallet-backfill-pinnacle — default fire-and-forget", () => {
  const ok = (body: any = { wallet: "0xbd94cade097e50ac" }, u = url) =>
    makeReq({ url: u, auth: `Bearer ${TOKEN}`, body })

  it("202-accepts and defers the walk", async () => {
    const res = await POST(ok())
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.collection).toBe("disney_pinnacle")
    expect(body.wallet_address).toBe("0xbd94cade097e50ac")
    expect(body.skip_cached).toBe(true)
    expect(body.force).toBe(false)
    expect(st.cap).toBeTypeOf("function")
  })

  it("runs the deferred walk and records the scan count", async () => {
    await POST(ok())
    await st.cap!()
    expect(st.runArgs).toHaveLength(1)
    expect(st.scanCalls[0]).toMatchObject({
      p_wallet: "0xbd94cade097e50ac",
      p_collection_slug: "disney_pinnacle",
      p_found_count: 12,
    })
  })

  it("swallows a record_wallet_backfill_scan failure inside after()", async () => {
    st.scanThrows = true
    await POST(ok())
    await expect(st.cap!()).resolves.toBeUndefined()
  })

  it("skip_cached:false in the body is honoured", async () => {
    const body = await (await POST(ok({ wallet: "0xbd94cade097e50ac", skip_cached: false }))).json()
    expect(body.skip_cached).toBe(false)
  })

  it("force via the body turns skip_cached off", async () => {
    const body = await (await POST(ok({ wallet: "0xbd94cade097e50ac", force: true }))).json()
    expect(body.force).toBe(true)
    expect(body.skip_cached).toBe(false)
  })

  it("force via ?force=true and ?force=1 both apply", async () => {
    for (const q of ["?force=true", "?force=1"]) {
      const body = await (await POST(ok({ wallet: "0xbd94cade097e50ac" }, url + q))).json()
      expect(body.force).toBe(true)
      expect(body.skip_cached).toBe(false)
    }
  })
})

describe("POST /api/wallet-backfill-pinnacle — ?sync=true checkpoint mode", () => {
  const sync = (qs = "") =>
    makeReq({ url: `${url}?sync=true${qs}`, auth: `Bearer ${TOKEN}`, body: { wallet: "0xbd94cade097e50ac" } })

  it("runs inline and returns a complete checkpoint payload", async () => {
    const res = await POST(sync())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mode).toBe("sync")
    expect(body.complete).toBe(true)
    expect(body.next_checkpoint).toBeNull()
    expect(body.rows_processed).toBe(12)
    expect(st.cap).toBeNull() // no after() in sync mode
    expect(st.scanCalls).toHaveLength(1)
  })

  it("returns next_checkpoint as a string when the walk is incomplete", async () => {
    st.result = { rowsFound: 100, complete: false, nextStartIndex: 1000 }
    const body = await (await POST(sync())).json()
    expect(body.complete).toBe(false)
    expect(body.next_checkpoint).toBe("1000")
  })

  it("defaults max_duration_ms to 270000 and clamps to [30000, 540000]", async () => {
    expect((await (await POST(sync())).json()).max_duration_ms).toBe(270_000)
    expect((await (await POST(sync("&max_duration_ms=9999999"))).json()).max_duration_ms).toBe(540_000)
    expect((await (await POST(sync("&max_duration_ms=1"))).json()).max_duration_ms).toBe(30_000)
  })

  it("passes a numeric ?checkpoint= through as startIndex and ignores a junk one", async () => {
    await POST(sync("&checkpoint=2000"))
    expect(st.runArgs[0].startIndex).toBe(2000)
    st.runArgs = []
    await POST(sync("&checkpoint=abc"))
    expect(st.runArgs[0].startIndex).toBeUndefined()
  })

  it("swallows a scan-record failure and still returns the checkpoint", async () => {
    st.scanThrows = true
    const res = await POST(sync())
    expect(res.status).toBe(200)
    expect((await res.json()).complete).toBe(true)
  })
})
