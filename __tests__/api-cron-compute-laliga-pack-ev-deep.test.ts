import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture, type RecordedRpcCall } from "./helpers/route-harness"

// Deep-drive of /api/cron/compute-laliga-pack-ev — the Golazos pack-EV FMV
// fallback. Pins:
//   - an empty pool logs pool_empty=true / ok=true and writes nothing;
//   - a seeded pool computes gross_ev/pack_ev per dist, inserts pack_ev_history,
//     and writes PACK_EV sentinel fmv_snapshots ONLY for editions with no
//     sales-driven FMV;
//   - a real FMV (sales>0 or ask_proxy) BLOCKS the sentinel (never clobbered);
//   - a per-dist RPC error is counted, not fatal;
//   - a pool fetch error logs ok=false;
//   - a write throw hits the fatal catch -> ok=false;
//   - the auth guard.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

const { POST } = await import("@/app/api/cron/compute-laliga-pack-ev/route")

const GOLAZOS = "06248cc4-b85f-47cd-af67-1855d14acd75"

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures, opts?: { failWrites?: string[] }) {
  const spy = makeInstrumentedSupabaseFixture(
    {
      pack_drop_pool: { data: [], error: null },
      "rpc:compute_pack_ev_from_pool": {
        data: { ok: true, gross_ev: 12.5, pack_ev: 7.5, is_positive_ev: true, value_ratio: 1.5, fmv_coverage_pct: 80, edition_count: 2 },
        error: null,
      },
      pack_ev_history: { data: null, error: null },
      fmv_snapshots: { data: [], error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
      ...fixtures,
    },
    opts,
  )
  state.sb = spy.fixture
  return spy
}

function req(): NextRequest {
  return new NextRequest("https://t/api/cron/compute-laliga-pack-ev", {
    method: "POST",
    headers: new Headers({ authorization: "Bearer laliga-token" }),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args as any
}

beforeEach(() => {
  state.afterCbs.length = 0
  process.env.INGEST_SECRET_TOKEN = "laliga-token"
})

describe("compute-laliga-pack-ev — pool states", () => {
  it("no-ops with pool_empty=true when the Golazos pool is empty", async () => {
    const spy = install({})
    const res = await POST(req())
    expect(res.status).toBe(200)
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_pipeline: "compute-laliga-pack-ev", p_ok: true, p_rows_found: 0 })
    // The empty-pool branch nests the counters object (vs the happy path which
    // spreads it) — pin the nested shape.
    expect(log.p_extra.counters.pool_empty).toBe(true)
    // Never computed or wrote anything.
    expect(spy.rpcCalls.some((c) => c.name === "compute_pack_ev_from_pool")).toBe(false)
  })

  it("computes EV per dist, inserts pack_ev_history, and writes PACK_EV sentinels for no-FMV editions", async () => {
    const spy = install({
      pack_drop_pool: {
        data: [
          { dist_id: "d1", edition_id: "e1" },
          { dist_id: "d1", edition_id: "e2" },
        ],
        error: null,
      },
      fmv_snapshots: { data: [], error: null }, // no existing FMV for e1/e2
    })

    await POST(req())
    await runDeferred()

    // pack_ev_history row carries the computed EV (not the fixture echo — these
    // came out of the RPC result the handler mapped).
    const evRows = (spy.writes.pack_ev_history ?? []).flatMap((w) => w.rows)
    expect(evRows).toHaveLength(1)
    expect(evRows[0]).toMatchObject({
      collection_id: GOLAZOS,
      dist_id: "d1",
      gross_ev: 12.5,
      pack_ev: 7.5,
      is_positive_ev: true,
      algo_version: "pack-ev-v1-laliga",
    })

    // Both editions had no FMV -> two PACK_EV sentinel rows.
    const sentinels = (spy.writes.fmv_snapshots ?? []).filter((w) => w.method === "insert").flatMap((w) => w.rows)
    expect(sentinels).toHaveLength(2)
    expect(sentinels[0]).toMatchObject({ collection_id: GOLAZOS, fmv_usd: 0, confidence: "PACK_EV", algo_version: "pack-ev-v1-laliga" })

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(true)
    expect(log.p_extra).toMatchObject({ ev_rows_written: 1, sentinels_written: 2, dists_processed: 1 })
  })

  it("does NOT write a sentinel over an edition that already has a sales-driven FMV", async () => {
    const spy = install({
      pack_drop_pool: {
        data: [
          { dist_id: "d1", edition_id: "e1" },
          { dist_id: "d1", edition_id: "e2" },
        ],
        error: null,
      },
      // e1 has real sales -> protected; e2 has no snapshot -> sentinel.
      fmv_snapshots: { data: [{ edition_id: "e1", sales_count_30d: 5, ask_proxy_fmv: null }], error: null },
    })

    await POST(req())
    await runDeferred()

    const sentinels = (spy.writes.fmv_snapshots ?? []).filter((w) => w.method === "insert").flatMap((w) => w.rows)
    expect(sentinels).toHaveLength(1)
    expect(sentinels[0].edition_id).toBe("e2") // e1 protected

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_extra).toMatchObject({ sentinels_written: 1, sentinels_skipped_existing_fmv: 1 })
    expect(log.p_rows_skipped).toBe(1)
  })
})

describe("compute-laliga-pack-ev — failure honesty", () => {
  it("counts a per-dist RPC error without failing the whole run", async () => {
    const spy = install({
      pack_drop_pool: { data: [{ dist_id: "d1", edition_id: "e1" }], error: null },
      "rpc:compute_pack_ev_from_pool": { data: null, error: { message: "pool weighting timeout" } },
    })

    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(true)
    expect(log.p_extra.rpc_errors).toBe(1)
    expect(log.p_extra.ev_rows_written).toBe(0)
    expect(spy.writes.pack_ev_history ?? []).toHaveLength(0)
  })

  it("a pool fetch error logs ok=false", async () => {
    const spy = install({
      pack_drop_pool: { data: null, error: { message: "relation missing" } },
    })
    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("pool fetch: relation missing")
  })

  it("a pack_ev_history write throw hits the fatal catch -> ok=false", async () => {
    const spy = install(
      { pack_drop_pool: { data: [{ dist_id: "d1", edition_id: "e1" }], error: null } },
      { failWrites: ["pack_ev_history"] },
    )
    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("forced pack_ev_history insert failure")
  })

  it("401s without the token and registers no deferred work", async () => {
    install({})
    const res = await POST(new NextRequest("https://t/api/cron/compute-laliga-pack-ev", { method: "POST" }))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })
})
