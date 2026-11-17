import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/seed-wallet-refresh. Auth accepts either
// ?token= or Authorization: Bearer, compared to process.env.INGEST_SECRET_TOKEN
// at CALL time (string compare, not 500-when-unset): no/wrong token → 401. Then
// a cohort-param guard (1<=of<=8, 0<=cohort<of) → 400. The wallet-fanout work
// runs inside after() — stubbed to a no-op so the immediate 202 is observable
// without dispatching any backfill.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: () => ({}) }) }))

import { GET } from "@/app/api/seed-wallet-refresh/route"

const TOKEN = "test-ingest-token"

function req(opts: { token?: string; auth?: string; qs?: string } = {}) {
  const url = "https://t/api/seed-wallet-refresh" + (opts.token ? `?token=${opts.token}` : opts.qs ? `?${opts.qs}` : "")
  const u = new URL(url)
  return {
    nextUrl: u,
    url: url,
    headers: new Headers(opts.auth ? { authorization: opts.auth } : {}),
  } as any
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  // The 2026-07-18 cost lever gates execution to `utcHour % 12 < 2` waves and
  // returns 200 {skipped} outside them. Without this the suite is FLAKY BY THE
  // CLOCK — green during wave hours, red the other ~10/12 of the day. This is the
  // documented escape hatch; it isolates dispatch policy from the cadence gate.
  process.env.SEED_WALLET_REFRESH_EVERY_WAVE = "1"
})

describe("GET /api/seed-wallet-refresh", () => {
  it("401s with no token", async () => {
    expect((await GET(req())).status).toBe(401)
  })

  it("401s with a wrong token", async () => {
    expect((await GET(req({ token: "wrong" }))).status).toBe(401)
  })

  it("400s on invalid cohort params (of=0)", async () => {
    const res = await GET(req({ qs: `token=${TOKEN}&of=0` }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("invalid cohort params")
  })

  it("400s when cohort >= of", async () => {
    const res = await GET(req({ qs: `token=${TOKEN}&of=2&cohort=2` }))
    expect(res.status).toBe(400)
  })

  it("202s with a valid token via ?token=", async () => {
    const res = await GET(req({ token: TOKEN }))
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)
  })

  it("202s with a valid Bearer header", async () => {
    const res = await GET(req({ auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(202)
  })
})
