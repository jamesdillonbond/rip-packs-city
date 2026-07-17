import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of POST /api/wallet-backfill-multicollection — the 5-collection
// orchestrator. Captures after() and runs the real dispatch body under fake
// timers (the 30s CHILD_STAGGER_MS sleeps and sync backoffs are virtual). Pins:
//   - the dispatch/complete telemetry pair (Round 12 contract): dispatch row
//     first with all-zero pending map; complete row with the real per-collection
//     outcome, sync round-trip detail, and the "dispatch gaps" error string;
//   - fire-and-forget child fan-out bodies (auth + skip_cached passthrough);
//   - the sync-poll loop: checkpoint resumption, transient-5xx retry with
//     recovered_after_retry, hard-4xx break, null-checkpoint abort, and the
//     per-collection round-trip cap (nfl_all_day = 4);
//   - the 202 accept surface and param guards.

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

const { POST } = await import("@/app/api/wallet-backfill-multicollection/route")

const WALLET = "0xbd94cade097e50ac"
const ALL_SLUGS = ["nba_top_shot", "laliga_golazos", "ufc_strike", "nfl_all_day", "disney_pinnacle"]

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures = {}) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function post(body: unknown, opts: { auth?: string | null; badJson?: boolean } = {}): NextRequest {
  const headers = new Headers({ "content-type": "application/json" })
  if (opts.auth !== null) headers.set("authorization", opts.auth ?? "Bearer multi-token")
  return new NextRequest("https://t/api/wallet-backfill-multicollection", {
    method: "POST",
    headers,
    body: opts.badJson ? "{nope" : JSON.stringify(body),
  })
}

// Drives the captured after() work to completion under fake timers, advancing
// the virtual clock until the callback settles (staggers + backoffs are 30s+).
async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) {
    let settled = false
    const p = Promise.resolve()
      .then(cb)
      .finally(() => {
        settled = true
      })
    let guard = 0
    while (!settled) {
      if (++guard > 500) throw new Error("runDeferred: after() work did not settle under fake timers")
      await vi.advanceTimersByTimeAsync(30_000)
    }
    await p
  }
}

type ChildResponse = { status: number; json?: unknown; throw?: string }
/** Sequenced responses per exact child pathname; the last entry repeats. */
function childStub(path: string, responses: ChildResponse[]): FetchStub {
  let i = 0
  return {
    match: (url) => new URL(url).pathname === path,
    respond: () => {
      const r = responses[Math.min(i, responses.length - 1)]
      i++
      if (r.throw) throw new Error(r.throw)
      return { status: r.status, json: r.json ?? {} }
    },
  }
}

const ok202: ChildResponse[] = [{ status: 202, json: { accepted: true } }]
const syncDone = (rows = 0): ChildResponse[] => [
  { status: 200, json: { ok: true, complete: true, rows_processed: rows } },
]

function stubs(over: Partial<Record<string, ChildResponse[]>> = {}) {
  return [
    childStub("/api/wallet-backfill-allday", over.allday ?? syncDone()),
    childStub("/api/wallet-backfill-pinnacle", over.pinnacle ?? syncDone()),
    childStub("/api/wallet-backfill-golazos", over.golazos ?? ok202),
    childStub("/api/wallet-backfill-ufc", over.ufc ?? ok202),
    childStub("/api/wallet-backfill", over.topshot ?? ok202),
  ]
}

function logsFor(rpcCalls: RecordedRpcCall[], pipeline: string) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run" && c.args?.p_pipeline === pipeline)
}

function syncCallsTo(f: ReturnType<typeof installFetchMock>, path: string) {
  return f.calls.filter((c) => new URL(c.url).pathname === path)
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
  vi.useRealTimers()
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "multi-token"
  state.afterCbs.length = 0
  vi.useFakeTimers()
})

describe("wallet-backfill-multicollection — telemetry pair + fan-out", () => {
  it("happy path: dispatch row first (all pending), staggered fan-out with auth, complete row all-green", async () => {
    fetchMock = installFetchMock(stubs({ allday: syncDone(120), pinnacle: syncDone(60) }))
    const spy = install()

    const res = await POST(post({ wallet: WALLET }))
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({
      wallet_address: WALLET,
      skip_cached: true,
      accepted_count: 5,
      collection_count: 5,
      sync_collections: ["nfl_all_day", "disney_pinnacle"],
      fire_and_forget_collections: ["nba_top_shot", "laliga_golazos", "ufc_strike"],
    })
    await runDeferred()

    // DISPATCH row lands before any child fetch and marks everything pending.
    const dispatch = logsFor(spy.rpcCalls, "wallet-backfill-multicollection-dispatch")
    expect(dispatch).toHaveLength(1)
    expect(dispatch[0].args).toMatchObject({ p_ok: true, p_rows_found: 1, p_rows_written: 0 })
    const dExtra = dispatch[0].args?.p_extra as Record<string, unknown>
    expect(dExtra.phase).toBe("dispatch")
    expect(dExtra.wallet_address).toBe(WALLET)
    expect(dExtra.dispatched_per_collection).toEqual(
      Object.fromEntries(ALL_SLUGS.map((s) => [s, 0])),
    )

    // Fire-and-forget children each got an authed POST with the wallet body.
    for (const path of ["/api/wallet-backfill", "/api/wallet-backfill-golazos", "/api/wallet-backfill-ufc"]) {
      const calls = syncCallsTo(fetchMock, path)
      expect(calls).toHaveLength(1)
      expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer multi-token")
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ wallet: WALLET, skip_cached: true })
    }
    // Sync children got the sync-poll query contract, no checkpoint on rt0.
    const alldayCalls = syncCallsTo(fetchMock, "/api/wallet-backfill-allday")
    expect(alldayCalls).toHaveLength(1)
    const u = new URL(alldayCalls[0].url)
    expect(u.searchParams.get("sync")).toBe("true")
    expect(u.searchParams.get("max_duration_ms")).toBe("270000")
    expect(u.searchParams.has("checkpoint")).toBe(false)

    // COMPLETE row: everything dispatched, both sync children final.
    const complete = logsFor(spy.rpcCalls, "wallet-backfill-multicollection-complete")
    expect(complete).toHaveLength(1)
    expect(complete[0].args).toMatchObject({
      p_ok: true,
      p_rows_written: 5,
      p_rows_skipped: 0,
      p_error: null,
    })
    const cExtra = complete[0].args?.p_extra as Record<string, unknown>
    expect(cExtra.phase).toBe("complete")
    expect(cExtra.dispatched_per_collection).toEqual(
      Object.fromEntries(ALL_SLUGS.map((s) => [s, 1])),
    )
    expect(cExtra.sync_completed_collections).toEqual(["nfl_all_day", "disney_pinnacle"])
    expect(cExtra.sync_round_trips_actual).toEqual([
      {
        collection: "nfl_all_day",
        round_trips: 1,
        ok: true,
        final_complete: true,
        transient_retries: 0,
        recovered_after_retry: false,
        round_trip_cap: 4,
      },
      {
        collection: "disney_pinnacle",
        round_trips: 1,
        ok: true,
        final_complete: true,
        transient_retries: 0,
        recovered_after_retry: false,
        round_trip_cap: 4,
      },
    ])
  })

  it("resumes a sync child from its returned checkpoint until complete", async () => {
    fetchMock = installFetchMock(
      stubs({
        allday: [
          { status: 200, json: { ok: true, complete: false, next_checkpoint: "cp-1", rows_processed: 40 } },
          { status: 200, json: { ok: true, complete: true, rows_processed: 60 } },
        ],
      }),
    )
    const spy = install()

    await POST(post({ wallet: WALLET, skip_cached: false }))
    await runDeferred()

    const alldayCalls = syncCallsTo(fetchMock, "/api/wallet-backfill-allday")
    expect(alldayCalls).toHaveLength(2)
    expect(new URL(alldayCalls[0].url).searchParams.has("checkpoint")).toBe(false)
    expect(new URL(alldayCalls[1].url).searchParams.get("checkpoint")).toBe("cp-1")
    // skip_cached=false propagated to every round trip.
    expect(JSON.parse(String(alldayCalls[1].init?.body))).toEqual({ wallet: WALLET, skip_cached: false })

    const cExtra = logsFor(spy.rpcCalls, "wallet-backfill-multicollection-complete")[0].args
      ?.p_extra as Record<string, unknown>
    const allday = (cExtra.sync_round_trips_actual as Array<Record<string, unknown>>).find(
      (r) => r.collection === "nfl_all_day",
    )
    expect(allday).toMatchObject({ round_trips: 2, ok: true, final_complete: true })
  })

  it("a transient 5xx retries without advancing the checkpoint and flags recovered_after_retry", async () => {
    fetchMock = installFetchMock(
      stubs({
        allday: [
          { status: 503, json: { error: "lambda pool exhausted" } },
          { status: 200, json: { ok: true, complete: true, rows_processed: 10 } },
        ],
      }),
    )
    const spy = install()

    await POST(post({ wallet: WALLET }))
    await runDeferred()

    const alldayCalls = syncCallsTo(fetchMock, "/api/wallet-backfill-allday")
    expect(alldayCalls).toHaveLength(2)
    // Retry did NOT advance the checkpoint (child is idempotent-resumable).
    expect(new URL(alldayCalls[1].url).searchParams.has("checkpoint")).toBe(false)

    const complete = logsFor(spy.rpcCalls, "wallet-backfill-multicollection-complete")[0].args
    expect(complete?.p_ok).toBe(true)
    const cExtra = complete?.p_extra as Record<string, unknown>
    expect(cExtra.transient_retries_total).toBe(1)
    expect(cExtra.recovered_after_retry).toBe(1)
    const allday = (cExtra.sync_round_trips_actual as Array<Record<string, unknown>>).find(
      (r) => r.collection === "nfl_all_day",
    )
    expect(allday).toMatchObject({
      round_trips: 2,
      ok: true,
      transient_retries: 1,
      recovered_after_retry: true,
    })
  })
})

describe("wallet-backfill-multicollection — dispatch gaps + caps", () => {
  it("a dead fire-and-forget child and a 4xx sync child produce the honest gap accounting", async () => {
    fetchMock = installFetchMock(
      stubs({
        topshot: [{ status: 0, throw: "connect ECONNREFUSED" }],
        allday: [{ status: 401, json: { error: "Unauthorized" } }],
      }),
    )
    const spy = install()

    await POST(post({ wallet: WALLET }))
    await runDeferred()

    // 4xx is a real client/auth bug — no retry burned on it.
    expect(syncCallsTo(fetchMock, "/api/wallet-backfill-allday")).toHaveLength(1)

    const complete = logsFor(spy.rpcCalls, "wallet-backfill-multicollection-complete")[0].args
    expect(complete?.p_ok).toBe(false)
    expect(String(complete?.p_error)).toContain("dispatch gaps:")
    expect(String(complete?.p_error)).toContain("nba_top_shot")
    expect(String(complete?.p_error)).toContain("nfl_all_day")
    const cExtra = complete?.p_extra as Record<string, unknown>
    expect(cExtra.dispatched_per_collection).toEqual({
      nba_top_shot: 0,
      laliga_golazos: 1,
      ufc_strike: 1,
      nfl_all_day: 0,
      disney_pinnacle: 1,
    })
    const samples = cExtra.dispatch_error_samples as Record<string, string[]>
    expect(samples.nba_top_shot[0]).toContain("ECONNREFUSED")
    expect(samples.nfl_all_day[0]).toContain("HTTP 401")
  })

  it("enforces the per-collection round-trip cap and aborts on a null checkpoint", async () => {
    fetchMock = installFetchMock(
      stubs({
        // Never completes, always hands back a checkpoint -> burns the full cap (4).
        allday: [{ status: 200, json: { ok: true, complete: false, next_checkpoint: "cp-n" } }],
        // complete=false with NO checkpoint -> fatal abort after one round trip.
        pinnacle: [{ status: 200, json: { ok: true, complete: false, next_checkpoint: null } }],
      }),
    )
    const spy = install()

    await POST(post({ wallet: WALLET }))
    await runDeferred()

    expect(syncCallsTo(fetchMock, "/api/wallet-backfill-allday")).toHaveLength(4)
    expect(syncCallsTo(fetchMock, "/api/wallet-backfill-pinnacle")).toHaveLength(1)

    const complete = logsFor(spy.rpcCalls, "wallet-backfill-multicollection-complete")[0].args
    expect(complete?.p_ok).toBe(false)
    const cExtra = complete?.p_extra as Record<string, unknown>
    const samples = cExtra.dispatch_error_samples as Record<string, string[]>
    expect(samples.nfl_all_day.join("|")).toContain("hit SYNC_ROUND_TRIP_CAP=4")
    expect(samples.disney_pinnacle.join("|")).toContain("complete=false but next_checkpoint=null")
    expect(cExtra.sync_completed_collections).toEqual([])
  })
})

describe("wallet-backfill-multicollection — guards", () => {
  it("401s without auth, 400s on bad JSON and missing wallet; none defer work", async () => {
    install()
    expect((await POST(post({ wallet: WALLET }, { auth: null }))).status).toBe(401)
    expect((await POST(post(null, { badJson: true }))).status).toBe(400)
    expect((await POST(post({}))).status).toBe(400)
    expect(state.afterCbs).toHaveLength(0)
  })
})
