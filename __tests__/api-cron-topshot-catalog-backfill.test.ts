import { describe, it, expect, beforeEach, vi } from "vitest"

// The wrapper exists because /api/admin/backfill-topshot-catalog accepts ONLY
// RPC_ADMIN_TOKEN, while Vercel cron sends only CRON_SECRET. Pointing a
// vercel.json entry straight at the admin route would 401 every tick — and a
// 401 writes no pipeline_runs row, so it would look identical to "never
// scheduled". These tests pin the three things that make the wrapper worth
// having: it accepts BOTH scheduler secrets, it rejects everything else, and it
// forwards an admin-authorized request rather than the caller's credentials.

const state = vi.hoisted(() => ({
  calls: [] as Array<{ auth: string | null; url: string }>,
  response: () => new Response(JSON.stringify({ ok: true, editions_upserted: 7 }), { status: 200 }),
}))

vi.mock("@/app/api/admin/backfill-topshot-catalog/route", () => ({
  GET: async (req: any) => {
    state.calls.push({ auth: req.headers.get("authorization"), url: req.nextUrl.toString() })
    return state.response()
  },
}))

const route = await import("@/app/api/cron/topshot-catalog-backfill/route")

const req = (headers: Record<string, string> = {}, url = "https://t/api/cron/topshot-catalog-backfill") =>
  new (require("next/server").NextRequest)(url, { headers })

beforeEach(() => {
  state.calls.length = 0
  process.env.CRON_SECRET = "cron-secret"
  process.env.INGEST_SECRET_TOKEN = "ingest-secret"
  process.env.RPC_ADMIN_TOKEN = "admin-token"
})

describe("/api/cron/topshot-catalog-backfill", () => {
  it("accepts CRON_SECRET — the secret Vercel cron actually injects", async () => {
    const res = await route.GET(req({ authorization: "Bearer cron-secret" }))
    expect(res.status).toBe(200)
    expect(state.calls).toHaveLength(1)
  })

  it("accepts INGEST_SECRET_TOKEN too, so a manual/backstop run is not locked out", async () => {
    const res = await route.POST(req({ authorization: "Bearer ingest-secret" }))
    expect(res.status).toBe(200)
    expect(state.calls).toHaveLength(1)
  })

  it("rejects a missing, wrong, or RPC_ADMIN bearer without ever calling the walker", async () => {
    for (const auth of [undefined, "Bearer nope", "Bearer admin-token", ""]) {
      const res = await route.GET(req(auth ? { authorization: auth } : {}))
      expect(res.status).toBe(401)
    }
    expect(state.calls).toHaveLength(0)
  })

  it("forwards the ADMIN token to the walker, never the caller's cron secret", async () => {
    await route.GET(req({ authorization: "Bearer cron-secret" }))
    expect(state.calls[0].auth).toBe("Bearer admin-token")
    expect(state.calls[0].auth).not.toContain("cron-secret")
  })

  it("preserves the query string so ?limitSets= still works through the wrapper", async () => {
    await route.GET(
      req({ authorization: "Bearer cron-secret" }, "https://t/api/cron/topshot-catalog-backfill?limitSets=3"),
    )
    expect(state.calls[0].url).toContain("limitSets=3")
    expect(state.calls[0].url).toContain("/api/admin/backfill-topshot-catalog")
  })

  it("500s loudly when RPC_ADMIN_TOKEN is unset rather than letting it read as a 401", async () => {
    // A misconfiguration must not be indistinguishable from "the walker
    // declined the request" — that conflation is the class this route exists
    // to remove, so it must not reintroduce it one layer up.
    delete process.env.RPC_ADMIN_TOKEN
    const res = await route.GET(req({ authorization: "Bearer cron-secret" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/RPC_ADMIN_TOKEN/)
    expect(state.calls).toHaveLength(0)
  })
})
