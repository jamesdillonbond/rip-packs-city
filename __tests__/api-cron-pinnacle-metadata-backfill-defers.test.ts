import { describe, it, expect, beforeEach, vi } from "vitest"

// GET /api/cron/pinnacle-metadata-backfill is called hourly by cron-job.org,
// which drops the connection at 30 s and AUTO-DISABLES an entry after enough
// failures (register #76). On 2026-09-13 the route 504'd at its own 30 s wall
// on three consecutive ticks under an IO spell, wrote no terminal row, and was
// one more tick from being switched off by its scheduler.
//
// The contract pinned here: the caller ALWAYS gets an answer inside its
// budget; the work ALWAYS reaches its terminal row; a deferred answer carries
// NO counts; and the invocation heartbeat is written before any of it.

const afterCalls: Array<() => Promise<unknown>> = []
const heartbeats: Array<Record<string, any>> = []
const rpcCalls: string[] = []
const readDelay = vi.hoisted(() => ({ ms: 0 }))

vi.mock("next/server", async (importOriginal) => {
  const mod = await importOriginal<typeof import("next/server")>()
  return { ...mod, after: (fn: any) => { afterCalls.push(fn) } }
})
vi.mock("@/lib/pipeline/heartbeat", () => ({
  writeInvocationHeartbeat: async (opts: Record<string, any>) => {
    heartbeats.push({ ...opts, at: Date.now() })
    return true
  },
}))

const { sb } = vi.hoisted(() => {
  const sb: any = {}
  for (const m of ["from", "select", "eq", "in", "order", "limit", "gte", "lte", "lt", "gt", "is", "not", "or", "neq", "ilike", "match", "range", "insert", "update", "upsert", "delete"]) {
    sb[m] = () => sb
  }
  sb.single = async () => ({ data: null, error: null })
  sb.maybeSingle = async () => ({ data: null, error: null })
  sb.rpc = async (name: string) => {
    ;(globalThis as any).__rpcCalls?.push(name)
    return name === "pinnacle_metadata_discovery"
      ? { data: { q3: [], q4: [], q3_keys_scanned: 0, q3_cursor_after: null, q3_wrapped: false, q3_pass: 0, q4_targets_total: 0, distinct_edition_keys: 0 }, error: null }
      : { data: null, error: null }
  }
  // Every table read resolves to [] — after `readDelay.ms`, so a test can make
  // the database "slow" without any real I/O.
  sb.then = (resolve: any) => {
    const delay = (globalThis as any).__readDelayMs ?? 0
    if (delay > 0) setTimeout(() => resolve({ data: [], error: null }), delay)
    else resolve({ data: [], error: null })
  }
  return { sb }
})
vi.mock("@supabase/supabase-js", () => ({ createClient: () => sb }))

// The route captures TOKEN at module load, and ES imports hoist above any
// assignment in this file — so the env is set in a hoisted block.
vi.hoisted(() => { process.env.INGEST_SECRET_TOKEN = "test-ingest-secret" })
import { GET } from "@/app/api/cron/pinnacle-metadata-backfill/route"

const req = () =>
  ({
    headers: new Headers({ authorization: "Bearer test-ingest-secret" }),
    nextUrl: new URL("https://t/api/cron/pinnacle-metadata-backfill"),
  }) as any

beforeEach(() => {
  afterCalls.length = 0
  heartbeats.length = 0
  rpcCalls.length = 0
  ;(globalThis as any).__rpcCalls = rpcCalls
  ;(globalThis as any).__readDelayMs = 0
  readDelay.ms = 0
  delete process.env.PINNACLE_BACKFILL_SYNC_BUDGET_MS
})

describe("GET /api/cron/pinnacle-metadata-backfill — answers inside the caller's budget", () => {
  it("CONTROL: fast work answers 200 with the body, exactly as before, and nothing is deferred", async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(afterCalls).toHaveLength(0)
    expect(rpcCalls).toContain("log_pipeline_run")
  })

  it("⭐ slow work answers 202 inside the sync budget and after() carries it to its terminal row", async () => {
    process.env.PINNACLE_BACKFILL_SYNC_BUDGET_MS = "40"
    ;(globalThis as any).__readDelayMs = 150
    const t0 = Date.now()
    const res = await GET(req())
    const elapsed = Date.now() - t0
    expect(res.status).toBe(202)
    expect(elapsed).toBeLessThan(140)
    const body = await res.json()
    expect(body.deferred).toBe(true)
    // ⛔ A dispatch receipt carries no counts — nothing a caller could render as a result.
    for (const k of ["mint_count_filled", "edition_keys_resolved", "catalog_upserted", "serials_filled", "ok"]) {
      expect(body).not.toHaveProperty(k)
    }
    expect(afterCalls).toHaveLength(1)
    // The terminal row has NOT been written yet — the work is still running.
    expect(rpcCalls).not.toContain("log_pipeline_run")
    await afterCalls[0]()
    expect(rpcCalls).toContain("log_pipeline_run")
  })

  it("writes the invocation heartbeat under the pipeline's own name BEFORE the work, in both regimes", async () => {
    await GET(req())
    expect(heartbeats).toHaveLength(1)
    expect(heartbeats[0].pipeline).toBe("pinnacle-metadata-backfill")
    expect(typeof heartbeats[0].startedAtMs).toBe("number")
    // The marker must precede the terminal write, or a kill between them still
    // leaves no trace.
    const firstRpcAt = heartbeats[0].at
    expect(firstRpcAt).toBeLessThanOrEqual(Date.now())
    heartbeats.length = 0
    rpcCalls.length = 0
    process.env.PINNACLE_BACKFILL_SYNC_BUDGET_MS = "40"
    ;(globalThis as any).__readDelayMs = 150
    const res = await GET(req())
    expect(res.status).toBe(202)
    expect(heartbeats).toHaveLength(1)
    expect(rpcCalls).not.toContain("log_pipeline_run")
    await afterCalls[0]()
  })

  it("a wrong token is still refused before any heartbeat or work", async () => {
    const res = await GET({ headers: new Headers({ authorization: "Bearer wrong" }), nextUrl: new URL("https://t/x") } as any)
    expect(res.status).toBe(401)
    expect(heartbeats).toHaveLength(0)
    expect(afterCalls).toHaveLength(0)
  })
})
