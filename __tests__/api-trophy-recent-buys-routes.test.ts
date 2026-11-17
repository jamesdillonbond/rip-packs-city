// Route tests for the 2026-11-10 recent-buys lanes:
//   POST /api/profile/trophy-cases/sync-buys   — the picker's sync on open
//   GET  /api/cron/challenge-wallet-refresh     — the hourly open-challenge pass
// Pinned: the cron is fail-closed on auth, writes its heartbeat BEFORE the work,
// derives `ok` from the per-wallet results and names failing wallets; the sync
// route syncs ONLY the caller's own saved wallets and reports ok:false (never a
// clean "nothing new") when a wallet's sync could not run.
import { describe, it, expect, beforeEach, vi } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, { data: unknown; error: unknown }>,
    rpcCalls: [] as Array<{ name: string; args: any }>,
    order: [] as string[],
    syncCalls: [] as string[][],
    syncResult: [] as any[],
    pending: [] as Promise<void>[],
  }
  const chain = (table: string): any => {
    const c: any = {}
    for (const m of ["select", "eq", "in", "is", "or", "limit", "order", "not"]) c[m] = () => c
    c.then = (resolve: any) => resolve(state.tables[table] ?? { data: [], error: null })
    return c
  }
  const sb: any = {
    from: (t: string) => chain(t),
    rpc: async (name: string, args: any) => {
      state.rpcCalls.push({ name, args })
      state.order.push(`rpc:${name}`)
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
vi.mock("@/lib/trophy/recent-buys", () => ({
  syncRecentTopShotBuysForWallets: async (_db: unknown, wallets: string[]) => {
    h.state.order.push("sync")
    h.state.syncCalls.push([...wallets])
    return h.state.syncResult.length ? h.state.syncResult : wallets.map((w) => ({ wallet: w, candidates: 0, held: 0, added: 0, error: null }))
  },
}))
vi.mock("@/lib/auth/supabase-server", () => ({ requireUser: async () => ({ id: "user-1" }) }))
vi.mock("@/lib/api/bounded-read", async (orig) => {
  const real: any = await orig()
  return { ...real, boundedRead: (q: any) => Promise.resolve(q) }
})

import { GET as cronGET } from "@/app/api/cron/challenge-wallet-refresh/route"
import { POST as syncPOST } from "@/app/api/profile/trophy-cases/sync-buys/route"

const req = (auth?: string) => ({ headers: new Headers(auth ? { authorization: auth } : {}) }) as any

beforeEach(() => {
  process.env.CRON_SECRET = "test-cron-secret"
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  h.state.tables = {}
  h.state.rpcCalls.length = 0
  h.state.order.length = 0
  h.state.syncCalls.length = 0
  h.state.syncResult = []
  h.state.pending.length = 0
})

async function runCron(auth?: string) {
  const res = await cronGET(req(auth))
  await Promise.all(h.state.pending)
  return res
}

const logRow = () => h.state.rpcCalls.find((c) => c.name === "log_pipeline_run")?.args

describe("/api/cron/challenge-wallet-refresh", () => {
  it("401s without the bearer and does no work", async () => {
    const res = await cronGET(req())
    expect(res.status).toBe(401)
    expect(h.state.order).toEqual([])
  })

  it("heartbeat first, then syncs entrants' wallets, ok when every wallet synced", async () => {
    h.state.tables.trophy_challenges = { data: [{ id: "ch-1", ends_at: null }], error: null }
    h.state.tables.trophy_cases = { data: [{ user_id: "u1" }, { user_id: "u2" }], error: null }
    h.state.tables.saved_wallets = { data: [{ wallet_addr: "0x9b0079c2c8f0ccc9" }, { wallet_addr: "0x9b0079c2c8f0ccc9" }], error: null }
    const res = await runCron("Bearer test-cron-secret")
    expect(res.status).toBe(202)
    expect(h.state.order[0]).toBe("heartbeat")
    expect(h.state.syncCalls).toEqual([["0x9b0079c2c8f0ccc9"]])
    expect(logRow()).toMatchObject({ p_pipeline: "challenge-wallet-refresh", p_ok: true, p_extra: { wallets: 1 } })
  })

  it("a wallet whose sync failed makes the run not-ok and is named", async () => {
    h.state.tables.trophy_challenges = { data: [{ id: "ch-1", ends_at: null }], error: null }
    h.state.tables.trophy_cases = { data: [{ user_id: "u1" }], error: null }
    h.state.tables.saved_wallets = { data: [{ wallet_addr: "0xaaaaaaaaaaaaaaaa" }], error: null }
    h.state.syncResult = [{ wallet: "0xaaaaaaaaaaaaaaaa", candidates: 1, held: 0, added: 0, error: "Flow script HTTP 503" }]
    await runCron("Bearer test-cron-secret")
    expect(logRow().p_ok).toBe(false)
    expect(logRow().p_extra.errors).toEqual([{ wallet: "0xaaaaaaaaaaaaaaaa", error: "Flow script HTTP 503" }])
  })

  it("a failed population read is a failed run, not an empty one", async () => {
    h.state.tables.trophy_challenges = { data: null, error: { message: "db down" } }
    await runCron("Bearer test-cron-secret")
    expect(logRow().p_ok).toBe(false)
    expect(h.state.syncCalls).toEqual([])
  })

  it("no open challenge is a clean run with zero wallets", async () => {
    h.state.tables.trophy_challenges = { data: [], error: null }
    await runCron("Bearer test-cron-secret")
    expect(logRow()).toMatchObject({ p_ok: true, p_extra: { wallets: 0 } })
  })
})

describe("/api/profile/trophy-cases/sync-buys", () => {
  it("syncs only the caller's saved wallets and returns what was added", async () => {
    h.state.tables.saved_wallets = { data: [{ wallet_addr: "0x9b0079c2c8f0ccc9" }], error: null }
    h.state.syncResult = [{ wallet: "0x9b0079c2c8f0ccc9", candidates: 5, held: 5, added: 5, error: null }]
    const res = await syncPOST()
    expect(await res.json()).toEqual({ ok: true, wallets: 1, added: 5 })
    expect(h.state.syncCalls).toEqual([["0x9b0079c2c8f0ccc9"]])
  })

  it("a failed wallet sync is ok:false, never a clean 'nothing new'", async () => {
    h.state.tables.saved_wallets = { data: [{ wallet_addr: "0x9b0079c2c8f0ccc9" }], error: null }
    h.state.syncResult = [{ wallet: "0x9b0079c2c8f0ccc9", candidates: 0, held: 0, added: 0, error: "candidates: boom" }]
    const res = await syncPOST()
    expect(await res.json()).toMatchObject({ ok: false, added: 0 })
  })
})
