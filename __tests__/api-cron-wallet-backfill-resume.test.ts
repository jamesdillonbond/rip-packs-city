import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/cron/wallet-backfill-resume (#245, 2026-11-10): Vercel Cron drains the continuations a
// wallet-backfill walk could not dispatch (HTTP 508 on its self-POST). Pins auth, the heartbeat
// BEFORE the work, and a run row whose `ok` is the drain's — never a hardcoded true.

const h = vi.hoisted(() => {
  const state = {
    order: [] as string[],
    rpcCalls: [] as Array<{ name: string; args: any }>,
    drain: { ok: true, picked: 0, dispatched: 0, requeued: 0, dropped: [], errors: [] } as any,
    drainUrls: [] as string[],
    pending: [] as Promise<void>[],
  }
  const sb: any = {
    rpc: async (name: string, args: any) => {
      state.order.push(`rpc:${name}`)
      state.rpcCalls.push({ name, args })
      return { data: null, error: null }
    },
  }
  return { state, sb }
})

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: h.sb, supabase: h.sb }))
vi.mock("next/server", async (orig) => {
  const real: any = await orig()
  return { ...real, after: (fn: () => Promise<void>) => void h.state.pending.push(fn()) }
})
vi.mock("@/lib/pipeline/heartbeat", () => ({
  writeInvocationHeartbeat: async () => {
    h.state.order.push("heartbeat")
    return true
  },
}))
vi.mock("@/lib/chains/flow/wallet-backfill-resume", () => ({
  drainResumeQueue: async (_db: unknown, url: string) => {
    h.state.order.push("drain")
    h.state.drainUrls.push(url)
    return h.state.drain
  },
}))

import { GET } from "@/app/api/cron/wallet-backfill-resume/route"

const req = (auth?: string) =>
  ({ url: "https://www.rippackscity.com/api/cron/wallet-backfill-resume", headers: new Headers(auth ? { authorization: auth } : {}) }) as any

beforeEach(() => {
  h.state.order = []
  h.state.rpcCalls = []
  h.state.drainUrls = []
  h.state.pending = []
  h.state.drain = { ok: true, picked: 0, dispatched: 0, requeued: 0, dropped: [], errors: [] }
  process.env.CRON_SECRET = "cron-secret"
  process.env.INGEST_SECRET_TOKEN = "ingest-secret"
})

describe("GET /api/cron/wallet-backfill-resume", () => {
  it("401 without a valid bearer, and does no work", async () => {
    const res = await GET(req("Bearer nope"))
    expect(res.status).toBe(401)
    expect(h.state.pending.length).toBe(0)
  })

  it("202 with CRON_SECRET; heartbeat BEFORE the drain; the drain gets this request's URL", async () => {
    const res = await GET(req("Bearer cron-secret"))
    expect(res.status).toBe(202)
    await Promise.all(h.state.pending)
    expect(h.state.order).toEqual(["heartbeat", "drain", "rpc:log_pipeline_run"])
    expect(h.state.drainUrls).toEqual(["https://www.rippackscity.com/api/cron/wallet-backfill-resume"])
    expect(h.state.rpcCalls[0].args).toMatchObject({ p_pipeline: "wallet-backfill-resume", p_ok: true })
  })

  it("a drain that requeued or dropped a wallet logs ok=false and names it", async () => {
    h.state.drain = { ok: false, picked: 2, dispatched: 1, requeued: 0, dropped: [{ wallet: "0xa", depth: 3, error: "HTTP 508" }], errors: [] }
    await GET(req("Bearer ingest-secret"))
    await Promise.all(h.state.pending)
    expect(h.state.rpcCalls[0].args.p_ok).toBe(false)
    expect(h.state.rpcCalls[0].args.p_extra).toMatchObject({ picked: 2, dispatched: 1, dropped: [{ wallet: "0xa" }] })
  })
})
