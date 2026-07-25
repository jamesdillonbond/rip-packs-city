import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"

// Deep test for POST /api/early-access/submit — drives the persisted-row + auto-
// approval computation the shallow test (validation guards + dup echo + 500)
// skips. Assertions target what the handler COMPUTES/WRITES: the defaulted +
// deduped collections passed to the submit RPC, the wallet+username dedup 409,
// and the scored auto-approval decision (pending / auto_approved / rejected)
// that sets both the persisted allow_list status and the response status.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  rpcCalls: [] as { name: string; args: Record<string, unknown> | undefined }[],
  writes: {} as Record<string, { method: string; rows: Record<string, unknown>[] }[]>,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

// Neutralize after() — the slow on-chain re-score + Telegram ping are fire-and-
// forget; the synchronous response contract is what we assert here.
const cap = vi.hoisted(() => ({ fn: null as null | (() => Promise<void>) }))
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: any) => { cap.fn = fn } }
})

import { POST } from "@/app/api/early-access/submit/route"

function install(fixtures: Record<string, unknown>) {
  const spy = makeInstrumentedSupabaseFixture(fixtures as never)
  state.sb = spy.fixture
  state.rpcCalls = spy.rpcCalls
  state.writes = spy.writes
}

function req(body: unknown, opts: { badJson?: boolean } = {}): never {
  return {
    headers: new Headers({ "x-forwarded-for": "1.2.3.4", "user-agent": "vitest" }),
    json: async () => {
      if (opts.badJson) throw new Error("bad json")
      return body
    },
  } as never
}

const ALL_FIVE = ["nba_top_shot", "nfl_all_day", "laliga_golazos", "disney_pinnacle", "ufc_strike"]

beforeEach(() => {
  state.sb = null
  state.rpcCalls = []
  state.writes = {}
})

describe("POST /api/early-access/submit — collections persistence", () => {
  it("defaults an empty collections selection to all five published slugs at the submit RPC", async () => {
    install({
      "rpc:submit_allow_list_request": { data: { ok: true, duplicate: false, status: "pending" }, error: null },
      "rpc:auto_approve_eligible": { data: { score: 0, reasons: [], blocked_by: [] }, error: null },
      allow_list: { data: null, error: null }, // no row id → auto-approval decision no-ops
    })

    const res = await POST(req({ email: "  New@Collector.com ", username: "collector" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, duplicate: false, status: "pending", auto_approval: null })

    const submit = state.rpcCalls.find((c) => c.name === "submit_allow_list_request")!
    expect(submit.args?.p_collections).toEqual(ALL_FIVE)
    expect(submit.args?.p_email).toBe("new@collector.com") // trimmed + lowercased
    expect(submit.args?.p_wallet_addr).toBeNull()
    expect(submit.args?.p_username).toBe("collector")
  })

  it("validates + dedups an explicit collections list before persisting it", async () => {
    install({
      "rpc:submit_allow_list_request": { data: { ok: true, duplicate: false, status: "pending" }, error: null },
      "rpc:auto_approve_eligible": { data: { score: 0, reasons: [], blocked_by: [] }, error: null },
      allow_list: { data: null, error: null },
    })

    await POST(
      req({
        email: "a@b.com",
        username: "collector",
        collections: ["nba_top_shot", "nba_top_shot", "not_a_collection", "ufc_strike"],
      }),
    )
    const submit = state.rpcCalls.find((c) => c.name === "submit_allow_list_request")!
    expect(submit.args?.p_collections).toEqual(["nba_top_shot", "ufc_strike"])
  })
})

describe("POST /api/early-access/submit — dedup", () => {
  it("409s when the same wallet+username is already active under a different email", async () => {
    install({
      allow_list: { data: [{ email: "someone-else@x.com" }], error: null },
    })

    const res = await POST(
      req({ email: "me@x.com", username: "collector", wallet: "0xabcdef0123456789" }),
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toMatchObject({ ok: false, duplicate: true, existing_account: true })
    // Dedup short-circuits before the submit RPC ever runs.
    expect(state.rpcCalls.find((c) => c.name === "submit_allow_list_request")).toBeUndefined()
  })
})

describe("POST /api/early-access/submit — auto-approval decision", () => {
  it("auto-approves a >=90 score: writes status=active and returns status active", async () => {
    install({
      "rpc:submit_allow_list_request": { data: { ok: true, duplicate: false, status: "pending" }, error: null },
      "rpc:auto_approve_eligible": { data: { score: 95, reasons: [], blocked_by: [] }, error: null },
      allow_list: { data: { id: "row-1" }, error: null },
    })

    const body = await (await POST(req({ email: "a@b.com", username: "collector" }))).json()
    expect(body.status).toBe("active")
    expect(body.auto_approval).toMatchObject({ eligible: true, action: "auto_approved", score: 95 })
    const upd = state.writes["allow_list"]?.find((w) => w.method === "update")
    expect(upd?.rows[0]).toMatchObject({ status: "active", approved_by: "auto", auto_approval_score: 95 })
  })

  it("rejects when a blocker is present: writes status=rejected with the reason", async () => {
    install({
      "rpc:submit_allow_list_request": { data: { ok: true, duplicate: false, status: "pending" }, error: null },
      "rpc:auto_approve_eligible": { data: { score: 50, reasons: [], blocked_by: ["disposable_email"] }, error: null },
      allow_list: { data: { id: "row-2" }, error: null },
    })

    const body = await (await POST(req({ email: "a@b.com", username: "collector" }))).json()
    expect(body.status).toBe("rejected")
    expect(body.auto_approval).toMatchObject({ action: "rejected", blocked_by: ["disposable_email"] })
    const upd = state.writes["allow_list"]?.find((w) => w.method === "update")
    expect(upd?.rows[0]).toMatchObject({ status: "rejected", reject_reason: "disposable_email" })
  })

  it("400s (no auto-approval) when the submit RPC itself reports ok:false", async () => {
    install({
      "rpc:submit_allow_list_request": { data: { ok: false, status: "blocked" }, error: null },
    })
    const res = await POST(req({ email: "a@b.com", username: "collector" }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toMatchObject({ ok: false, error: "Request rejected.", status: "blocked" })
  })
})

// ---------------------------------------------------------------------------
// The after() body: the SLOW on-chain re-score (wallet-search -> moment count ->
// auto_approve_eligible -> decision) and the Telegram signup ping. Both were
// dark because after() was stubbed to a no-op. All outbound HTTP is a global
// fetch, so a stub drives the whole thing.
// ---------------------------------------------------------------------------

const VALID = { email: "a@b.com", username: "collector", wallet: "0xbd94cade097e50ac" }

function stubFetch(handler: (url: string, init?: any) => any) {
  const calls: string[] = []
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
    calls.push(String(url))
    return handler(String(url), init)
  }))
  return calls
}

describe("POST /api/early-access/submit — deferred on-chain re-score + Telegram", () => {
  beforeEach(() => { cap.fn = null })
  afterEach(() => vi.unstubAllGlobals())

  const okFetch = (moments: number | null) => (url: string) => {
    if (url.includes("/api/wallet-search")) {
      return moments === null
        ? { ok: false, status: 503, json: async () => ({}) }
        : { ok: true, json: async () => ({ summary: { totalMoments: moments } }) }
    }
    return { ok: true, json: async () => ({}), text: async () => "" }
  }

  it("re-scores on-chain and applies the decision for a still-pending row", async () => {
    install({
      allow_list: { data: { id: "row-1", status: "pending", collections: ["nba-top-shot"] }, error: null },
      "rpc:submit_allow_list_request": { data: { ok: true, status: "pending" }, error: null },
      "rpc:auto_approve_eligible": { data: { score: 90, reasons: ["whale"], blocked_by: [] }, error: null },
    })
    const calls = stubFetch(okFetch(500))
    await POST(req(VALID))
    expect(cap.fn).toBeTypeOf("function")
    // auto_approve_eligible also runs on the SYNCHRONOUS path, so only look at
    // the calls the deferred body adds.
    const before = state.rpcCalls.length
    await cap.fn!()
    const deferred = state.rpcCalls.slice(before)
    expect(calls.some((u) => u.includes("/api/wallet-search"))).toBe(true)
    const scored = deferred.find((c) => c.name === "auto_approve_eligible")
    expect(scored?.args).toMatchObject({ p_onchain_moments: 500, p_wallet_addr: VALID.wallet })
  })

  it("skips the re-score entirely when the row is already active", async () => {
    install({
      allow_list: { data: { id: "row-1", status: "active", collections: [] }, error: null },
      "rpc:submit_allow_list_request": { data: { ok: true, status: "pending" }, error: null },
    })
    const calls = stubFetch(okFetch(500))
    await POST(req(VALID))
    const before = state.rpcCalls.length
    await cap.fn!()
    expect(calls.some((u) => u.includes("/api/wallet-search"))).toBe(false)
    expect(state.rpcCalls.slice(before).find((c) => c.name === "auto_approve_eligible")).toBeUndefined()
  })

  it("does not score when wallet-search fails (no moment count = no decision)", async () => {
    install({
      allow_list: { data: { id: "row-1", status: "pending", collections: [] }, error: null },
      "rpc:submit_allow_list_request": { data: { ok: true, status: "pending" }, error: null },
    })
    stubFetch(okFetch(null)) // non-ok wallet-search
    await POST(req(VALID))
    const before = state.rpcCalls.length
    await cap.fn!()
    expect(state.rpcCalls.slice(before).find((c) => c.name === "auto_approve_eligible")).toBeUndefined()
  })

  it("never lets a thrown re-score escape after()", async () => {
    install({
      allow_list: { data: { id: "row-1", status: "pending", collections: [] }, error: null },
      "rpc:submit_allow_list_request": { data: { ok: true, status: "pending" }, error: null },
    })
    stubFetch(() => { throw new Error("network down") })
    await POST(req(VALID))
    await expect(cap.fn!()).resolves.toBeUndefined()
  })

  it("still pings Telegram after the re-score path completes", async () => {
    install({
      allow_list: { data: { id: "row-1", status: "pending", collections: ["nba-top-shot"] }, error: null },
      "rpc:submit_allow_list_request": { data: { ok: true, status: "pending" }, error: null },
      "rpc:auto_approve_eligible": { data: { score: 10, reasons: [], blocked_by: ["low_score"] }, error: null },
    })
    stubFetch(okFetch(3))
    await POST(req(VALID))
    await expect(cap.fn!()).resolves.toBeUndefined()
  })

  it("returns early when the post-submit row lookup finds nothing", async () => {
    install({
      allow_list: { data: null, error: null },
      "rpc:submit_allow_list_request": { data: { ok: true, status: "pending" }, error: null },
    })
    stubFetch(okFetch(1))
    await POST(req(VALID))
    await expect(cap.fn!()).resolves.toBeUndefined()
  })

  it("returns early when the post-submit row lookup errors", async () => {
    install({
      allow_list: { data: null, error: { message: "lookup down" } },
      "rpc:submit_allow_list_request": { data: { ok: true, status: "pending" }, error: null },
    })
    stubFetch(okFetch(1))
    await POST(req(VALID))
    await expect(cap.fn!()).resolves.toBeUndefined()
  })
})
