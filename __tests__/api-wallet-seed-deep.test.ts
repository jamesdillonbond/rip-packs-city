import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Deep drive of POST /api/wallet/seed (the sibling test pins auth).
//
// ⛔ INVERTED 2026-11-02. This file used to pin the route's own writer: it
// mocked an `editions` row whose external_id was the MOMENT id ("m1") and
// asserted the upsert carried that edition — the premise was the defect (an
// edition's external_id is a `set:play` key, so production matched nothing and
// wrote fmv_usd: null over every cached moment, then deleted custodied All Day
// moments through the full-set writer). The route now delegates to
// /api/wallet-backfill-multicollection. What is pinned here is the ABSENCE of the
// old writes and the honesty of the hand-off report.

const rpc = vi.hoisted(() => vi.fn(async () => ({ data: null, error: null })))
const from = vi.hoisted(() => vi.fn())

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: (...a: any[]) => rpc(...(a as [])), from: (...a: any[]) => from(...(a as [])) },
}))

import { POST } from "@/app/api/wallet/seed/route"

const req = (opts: { token?: string; body?: any; badJson?: boolean }) =>
  ({
    url: "https://example.test/api/wallet/seed",
    headers: new Headers(opts.token ? { "x-ingest-token": opts.token } : {}),
    json: async () => { if (opts.badJson) throw new Error("bad"); return opts.body ?? {} },
  }) as any

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "tok"
  rpc.mockClear()
  from.mockClear()
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => "{}" }))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const seedBody = { walletAddress: "0xBD94cade097e50AC", ownerKey: "ok1" }

describe("POST /api/wallet/seed", () => {
  it("401 without the x-ingest-token", async () => {
    expect((await POST(req({ token: "nope", body: {} }))).status).toBe(401)
  })

  it("400 on invalid JSON body", async () => {
    const res = await POST(req({ token: "tok", badJson: true }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("Invalid JSON")
  })

  it("400 when walletAddress is missing/blank", async () => {
    expect((await POST(req({ token: "tok", body: {} }))).status).toBe(400)
    expect((await POST(req({ token: "tok", body: { walletAddress: "" } }))).status).toBe(400)
  })

  it("hands the wallet to the multicollection walker (lowercased, skip_cached) and reports dispatch=sent", async () => {
    const res = await POST(req({ token: "tok", body: seedBody }))
    expect(res.status).toBe(202)
    const json = await res.json()
    expect(json).toMatchObject({ ok: true, dispatch: "sent", walletAddress: "0xbd94cade097e50ac", ownerKey: "ok1" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, any]
    expect(url).toBe("https://example.test/api/wallet-backfill-multicollection")
    expect(init.headers.Authorization).toBe("Bearer tok")
    expect(JSON.parse(init.body)).toEqual({ wallet: "0xbd94cade097e50ac", skip_cached: true })
  })

  it("THE DEFECT IS ABSENT: no upsert_wallet_moments, no editions-by-moment-id lookup, no Flow script of its own", async () => {
    await POST(req({ token: "tok", body: seedBody }))
    expect(rpc).not.toHaveBeenCalled()
    expect(from).not.toHaveBeenCalled()
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes("onflow.org"))).toBe(false)
  })

  it("a walker non-2xx is a FAILED hand-off, not ok", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, text: async () => "" })
    const res = await POST(req({ token: "tok", body: seedBody }))
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.dispatch).toBe("failed")
    expect(json.error).toContain("503")
  })

  it("a network error is a FAILED hand-off", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"))
    const json = await (await POST(req({ token: "tok", body: seedBody }))).json()
    expect(json).toMatchObject({ ok: false, dispatch: "failed" })
  })

  it("our bounded wait expiring is reported as sent_unconfirmed, never as a completed walk", async () => {
    const e = new Error("timed out")
    e.name = "TimeoutError"
    fetchMock.mockRejectedValueOnce(e)
    const json = await (await POST(req({ token: "tok", body: seedBody }))).json()
    expect(json).toMatchObject({ ok: true, dispatch: "sent_unconfirmed" })
    expect(json.results).toBeUndefined()
  })
})

// ── The seeder is Cadence-only and says so (2026-09-20) ────────────────────
describe("POST /api/wallet/seed — an unsupported chain is not an empty wallet", () => {
  const CANDY = "12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK"

  it("400s a base58 wallet with a typed reason, dispatching nothing", async () => {
    const res = await POST(req({ token: "tok", body: { walletAddress: CANDY, ownerKey: "ok1" } }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.error).toBe("unsupported_chain_for_seeder")
    expect(json.chain).toBe("solana")
    expect(json.results).toBeUndefined()
    expect(json.walletAddress).toBe(CANDY)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("hex no-change arm: a real Flow address is still handed off", async () => {
    const res = await POST(req({ token: "tok", body: seedBody }))
    expect(res.status).toBe(202)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
