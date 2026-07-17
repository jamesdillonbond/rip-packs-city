import { describe, it, expect, beforeEach, vi } from "vitest"
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
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
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
