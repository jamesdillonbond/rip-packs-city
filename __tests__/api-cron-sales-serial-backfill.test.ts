import { describe, it, expect, beforeAll, afterEach, vi } from "vitest"

// Route-integration test for /api/cron/sales-serial-backfill.
// Auth: Bearer CRON_SECRET or INGEST_SECRET_TOKEN (read at REQUEST time; proxies
// the sales-serial-backfill Supabase edge fn).
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// Success path: auth + env presence (SUPABASE_URL + INGEST) validate
// SYNCHRONOUSLY, then the handler returns 202 { ok:true, accepted:true }
// immediately, deferring the edge-fn POST to after(). after() is stubbed no-op so
// the accept is observable without any fetch to the edge function. Both bearer
// regimes (CRON_SECRET and INGEST) are driven.

// after() CAPTURES rather than no-ops, so the deferred edge-fn POST can be
// replayed and inspected. The auth/accept tests do not replay it, so they behave
// exactly as before.
const state = vi.hoisted(() => ({ afterCbs: [] as Array<() => unknown> }))
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://stub.supabase.co"

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/sales-serial-backfill/route")
})

describe("POST /api/cron/sales-serial-backfill", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/cron/sales-serial-backfill — success path (immediate 202 accept, edge trigger deferred)", () => {
  it("202s and reports ok:true + accepted:true + the pipeline name with the INGEST bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("sales-serial-backfill-trigger")
  })

  it("also accepts the CRON_SECRET bearer token (202)", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-cron-secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)
  })

  it("GET alias reaches the same 202 accept when authed", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 🚨 THE TOKEN MUST NOT TRAVEL IN THE URL.
// This route used to build `…/sales-serial-backfill?token=${ingest}`. Supabase
// edge-function logs record FULL REQUEST URLS, so INGEST_SECRET_TOKEN — a secret
// shared across ~15 edge functions — was written into the log store on every
// call, ~12×/day. The assertion below is an ABSENCE: the token never appears in
// the URL. Asserting only that the header is present would pass with the query
// param still there, which is the exact regression this guards.
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/cron/sales-serial-backfill — the edge-fn call carries the token as a HEADER", () => {
  afterEach(() => {
    state.afterCbs.length = 0
    vi.unstubAllGlobals()
  })

  it("never puts INGEST_SECRET_TOKEN in the URL, and sends it as an Authorization header", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        calls.push({ url: String(input), init })
        return { status: 202, json: async () => ({ ok: true }) } as unknown as Response
      }),
    )

    // The earlier accept tests never replayed their callbacks, so drop them:
    // replaying four deferred triggers would make this assert on the wrong call.
    state.afterCbs.length = 0
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
    for (const cb of state.afterCbs.splice(0)) await cb()

    expect(calls).toHaveLength(1)
    // ⛔ THE LOAD-BEARING ASSERTION.
    expect(calls[0].url).not.toContain("test-ingest-token")
    expect(calls[0].url).not.toContain("token=")
    expect(calls[0].url).toBe("https://stub.supabase.co/functions/v1/sales-serial-backfill")
    // And it is still authorized — the fix must not simply drop the credential.
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer test-ingest-token")
  })
})
