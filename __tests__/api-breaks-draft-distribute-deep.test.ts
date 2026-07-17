import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
} from "./helpers/route-harness"

// Deep-drive of the (shelved-but-live-gated) break admin routes:
//   POST /api/breaks/[id]/draft      — RandomBeacon seed -> deterministic team draft
//   POST /api/breaks/[id]/distribute — chunked multi-transfer of pending results
// Both are BREAKS_ADMIN_TOKEN-gated state machines with clear status guards,
// idempotency, and per-chunk failure isolation — exactly the shape that pays
// off from pinning. The real deterministicShuffle (draft-shuffle lib) runs
// unmocked so the assignment contract is exercised end-to-end; fcl / Flow REST
// / hot-wallet authz are stubbed.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  fclQueryResult: null as unknown,
  fclQueryThrows: false,
  mutateThrows: false,
  sealThrows: false,
  mutateTxId: "0x" + "e".repeat(64),
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
vi.mock("@onflow/fcl", () => ({
  query: async () => {
    if (state.fclQueryThrows) throw new Error("random-source query failed")
    return state.fclQueryResult
  },
  mutate: async () => {
    if (state.mutateThrows) throw new Error("mutate rejected")
    return state.mutateTxId
  },
  tx: () => ({
    onceSealed: async () => {
      if (state.sealThrows) throw new Error("never sealed")
      return { status: 4 }
    },
  }),
}))
vi.mock("@onflow/types", () => ({
  UInt64: "UInt64",
  Address: "Address",
  Array: () => "Array",
}))
vi.mock("@/lib/breaks/server-authz", () => ({
  configureFcl: () => {},
  getFlowAccessNode: () => "https://flow-rest.test",
  buildHotWalletAuthz: () => ({ addr: "0x73f55c4450b8d466" }),
}))

process.env.BREAKS_ADMIN_TOKEN = "breaks-token"

const draft = await import("@/app/api/breaks/[id]/draft/route")
const distribute = await import("@/app/api/breaks/[id]/distribute/route")

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(id: string, token: string | null = "breaks-token"): [NextRequest, { params: Promise<{ id: string }> }] {
  const headers = new Headers()
  if (token) headers.set("authorization", `Bearer ${token}`)
  return [
    new NextRequest(`https://t/api/breaks/${id}/draft`, { method: "POST", headers }),
    { params: Promise.resolve({ id }) },
  ]
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
function stubFetch(stubs: FetchStub[]) {
  fetchMock = installFetchMock(stubs)
  return fetchMock
}
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.BREAKS_ADMIN_TOKEN = "breaks-token"
  state.afterCbs.length = 0
  state.fclQueryResult = null
  state.fclQueryThrows = false
  state.mutateThrows = false
  state.sealThrows = false
})

const TEAM_POOL = [
  "Blazers", "Lakers", "Celtics", "Warriors", "Heat", "Bucks",
  "Nuggets", "Suns", "Sixers", "Nets", "Knicks", "Bulls",
]

describe("breaks/draft", () => {
  it("401 without the admin token; 404 when the break is missing", async () => {
    install({ breaks: { data: null, error: null } })
    expect((await draft.POST(...req("b1", null))).status).toBe(401)
    expect((await draft.POST(...req("b1"))).status).toBe(404)
  })

  it("409 when the break isn't locked", async () => {
    install({ breaks: { data: { id: "b1", status: "open", format: "team_draft" }, error: null } })
    const res = await draft.POST(...req("b1"))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain("not 'locked'")
  })

  it("short-circuits with no_draft_needed for a non-draft format", async () => {
    install({ breaks: { data: { id: "b1", status: "locked", format: "personal" }, error: null } })
    const res = await draft.POST(...req("b1"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, no_draft_needed: true, format: "personal" })
  })

  it("idempotently returns the existing assignment when already drafted", async () => {
    install({
      breaks: {
        data: {
          id: "b1", status: "locked", format: "team_draft",
          draft_seed_target_height: 100, draft_seed_source: "abcd",
          team_pool: TEAM_POOL, draft_assignment: { "0": "Blazers", "1": "Lakers" },
        },
        error: null,
      },
    })
    const res = await draft.POST(...req("b1"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true, idempotent: true, seed_source_hex: "abcd",
      assignment: { "0": "Blazers", "1": "Lakers" },
    })
  })

  it("425 (too early) while the target block isn't sealed yet", async () => {
    install({
      breaks: {
        data: {
          id: "b1", status: "locked", format: "team_draft",
          draft_seed_target_height: 500, draft_seed_source: null,
          team_pool: TEAM_POOL, draft_assignment: null,
        },
        error: null,
      },
    })
    stubFetch([jsonRoute("/v1/blocks", [{ header: { height: "480" } }])])
    const res = await draft.POST(...req("b1"))
    expect(res.status).toBe(425)
    const body = await res.json()
    expect(body).toMatchObject({ not_yet: true, current_height: 480, target_height: 500 })
    expect(body.seconds_remaining).toBe(20)
  })

  it("happy path: reads the beacon, deterministically assigns teams, persists the assignment", async () => {
    const spy = install({
      breaks: {
        data: {
          id: "b1", status: "locked", format: "team_draft",
          draft_seed_target_height: 100, draft_seed_source: null,
          team_pool: TEAM_POOL, draft_assignment: null,
        },
        error: null,
      },
      break_spots: {
        data: [
          { id: "s0", spot_index: 0 },
          { id: "s1", spot_index: 1 },
          { id: "s2", spot_index: 2 },
        ],
        error: null,
      },
    })
    stubFetch([jsonRoute("/v1/blocks", [{ header: { height: "150" } }])])
    // 32-byte RandomBeacon source.
    state.fclQueryResult = Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256)

    const res = await draft.POST(...req("b1"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(typeof body.seed_source_hex).toBe("string")
    // Exactly one team per spot, all drawn from the pool, all distinct.
    const teams = Object.values(body.assignment) as string[]
    expect(teams).toHaveLength(3)
    expect(new Set(teams).size).toBe(3)
    for (const team of teams) expect(TEAM_POOL).toContain(team)

    // Each spot got a team_assignment update, and the break was finalized.
    const spotUpdates = spy.writes.break_spots?.filter((w) => w.method === "update") ?? []
    expect(spotUpdates).toHaveLength(3)
    const brkUpdate = spy.writes.breaks?.find((w) => w.method === "update")
    expect(brkUpdate?.rows[0]).toMatchObject({ draft_seed_source: body.seed_source_hex })
    expect((brkUpdate?.rows[0] as Record<string, unknown>).draft_assignment).toEqual(body.assignment)

    // Determinism: the same seed + pool + spot count reproduces the assignment.
    const res2 = await draft.POST(...req("b1"))
    expect((await res2.json()).assignment).toEqual(body.assignment)
  })

  it("502 when the beacon query returns empty entropy", async () => {
    install({
      breaks: {
        data: {
          id: "b1", status: "locked", format: "random_team",
          draft_seed_target_height: 100, draft_seed_source: null,
          team_pool: TEAM_POOL, draft_assignment: null,
        },
        error: null,
      },
    })
    stubFetch([jsonRoute("/v1/blocks", [{ header: { height: "150" } }])])
    state.fclQueryResult = []
    const res = await draft.POST(...req("b1"))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain("empty random source")
  })
})

function distReq(id: string, token: string | null = "breaks-token"): [NextRequest, { params: Promise<{ id: string }> }] {
  const headers = new Headers()
  if (token) headers.set("authorization", `Bearer ${token}`)
  return [
    new NextRequest(`https://t/api/breaks/${id}/distribute`, { method: "POST", headers }),
    { params: Promise.resolve({ id }) },
  ]
}

function result(id: string, spotIndex: number, wallet: string, moment: string) {
  return {
    id, break_id: "b1", spot_id: `sp${id}`, moment_id: moment, transfer_status: "pending",
    break_spots: { spot_index: spotIndex, customer_wallet: wallet },
  }
}

describe("breaks/distribute", () => {
  it("401 without the token; 409 on a wrong status", async () => {
    install({ breaks: { data: { id: "b1", status: "open" }, error: null } })
    expect((await distribute.POST(...distReq("b1", null))).status).toBe(401)
    const res = await distribute.POST(...distReq("b1"))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain("not 'ripping' or 'distributing'")
  })

  it("no pending results -> marks the break complete and reports a zero-chunk run", async () => {
    const spy = install({
      breaks: { data: { id: "b1", status: "distributing" }, error: null },
      break_results: [
        { data: [], error: null }, // pending fetch: none
        { count: 0, error: null } as never, // maybeMarkComplete: none unfinished
      ],
    })
    const res = await distribute.POST(...distReq("b1"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ chunks_total: 0, results_transferred: 0 })
    // Break flipped to complete.
    const brkUpdate = spy.writes.breaks?.find((w) => w.method === "update")
    expect(brkUpdate?.rows[0]).toMatchObject({ status: "complete" })
  })

  it("happy path: chunks pending results, transfers on-chain, flips results transferred, completes the break", async () => {
    const spy = install({
      breaks: { data: { id: "b1", status: "ripping" }, error: null },
      break_results: [
        { data: [result("r1", 0, "0x1111111111111111", "100"), result("r2", 1, "0x2222222222222222", "101")], error: null },
        { count: 0, error: null } as never, // all transferred after the run
      ],
      break_distributions: [
        { data: null, error: null }, // existing chunk-index lookup: none
        { data: { id: "dist-1" }, error: null }, // insert .single()
      ],
    })
    const res = await distribute.POST(...distReq("b1"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ chunks_total: 1, sealed: 1, failed: 0, results_transferred: 2, break_complete: true })

    // A distribution row was inserted with the recipient/moment counts.
    const distInsert = spy.writes.break_distributions?.find((w) => w.method === "insert")
    expect(distInsert?.rows[0]).toMatchObject({ break_id: "b1", chunk_index: 0, recipient_count: 2, moment_count: 2 })
    // Results flipped to transferred with the tx hash.
    const resUpdate = spy.writes.break_results?.find((w) => w.method === "update" && (w.rows[0] as Record<string, unknown>).transfer_status === "transferred")
    expect(resUpdate?.rows[0]).toMatchObject({ transfer_status: "transferred", transfer_tx_hash: state.mutateTxId })
    // Break marked complete.
    expect(spy.writes.breaks?.some((w) => w.method === "update" && (w.rows[0] as Record<string, unknown>).status === "complete")).toBe(true)
  })

  it("a mutate failure marks the chunk failed, leaves results pending, and does NOT complete the break", async () => {
    state.mutateThrows = true
    const spy = install({
      breaks: { data: { id: "b1", status: "ripping" }, error: null },
      break_results: [
        { data: [result("r1", 0, "0x1111111111111111", "100")], error: null },
        { count: 1, error: null } as never, // still 1 unfinished
      ],
      break_distributions: [
        { data: null, error: null },
        { data: { id: "dist-1" }, error: null },
      ],
    })
    const res = await distribute.POST(...distReq("b1"))
    const body = await res.json()
    expect(body).toMatchObject({ sealed: 0, failed: 1, break_complete: false })
    // The distribution row was marked failed with a mutate error.
    const failUpdate = spy.writes.break_distributions?.find((w) => w.method === "update" && (w.rows[0] as Record<string, unknown>).status === "failed")
    expect(String((failUpdate?.rows[0] as Record<string, unknown>).error_message)).toContain("mutate")
    // Results were NOT flipped to transferred.
    expect((spy.writes.break_results ?? []).some((w) => w.method === "update" && (w.rows[0] as Record<string, unknown>).transfer_status === "transferred")).toBe(false)
    // Break stays in-progress (update to 'distributing', not 'complete').
    expect(spy.writes.breaks?.some((w) => (w.rows[0] as Record<string, unknown>).status === "complete")).toBe(false)
  })

  it("a seal timeout marks the chunk failed after broadcast", async () => {
    state.sealThrows = true
    const spy = install({
      breaks: { data: { id: "b1", status: "ripping" }, error: null },
      break_results: [
        { data: [result("r1", 0, "0x1111111111111111", "100")], error: null },
        { count: 1, error: null } as never,
      ],
      break_distributions: [
        { data: null, error: null },
        { data: { id: "dist-1" }, error: null },
      ],
    })
    const res = await distribute.POST(...distReq("b1"))
    expect((await res.json())).toMatchObject({ sealed: 0, failed: 1 })
    // Broadcast happened (tx hash recorded) then seal failed.
    const updates = spy.writes.break_distributions?.filter((w) => w.method === "update") ?? []
    expect(updates.some((w) => (w.rows[0] as Record<string, unknown>).status === "broadcast")).toBe(true)
    expect(updates.some((w) => (w.rows[0] as Record<string, unknown>).status === "failed" && String((w.rows[0] as Record<string, unknown>).error_message).includes("seal"))).toBe(true)
  })
})
