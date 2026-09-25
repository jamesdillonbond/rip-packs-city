import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/sets (DB-driven Top Shot set tracker).
// Pre-DB guard: 400 "wallet param required" when ?wallet is absent. Past that it
// resolves the wallet and calls the get_topshot_set_progress /
// get_topshot_set_detail RPCs on supabaseAdmin — both mocked here. RPC errors are
// `throw error`n and surface as 500 with the error message.

const state: { data: any; error: any; rpcCalls: number; resolveCalls: string[] } =
  { data: null, error: null, rpcCalls: 0, resolveCalls: [] }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => { state.rpcCalls++; return { data: state.data, error: state.error } } },
}))
vi.mock("@/lib/chains/flow/flow-resolve", () => ({
  // ⚠ Identity, so this file cannot prove the "dead Top Shot host is not
  // called" half. What it CAN prove is that the non-Flow branch returns BEFORE
  // anything downstream runs — hence the call counters above.
  resolveToFlowAddress: async (w: string) => { state.resolveCalls.push(w); return w },
}))

import { GET } from "@/app/api/sets/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.data = null
  state.error = null
  state.rpcCalls = 0
  state.resolveCalls = []
})

describe("GET /api/sets", () => {
  it("400s without a wallet param", async () => {
    const res = await GET(req("https://t/api/sets"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet param required")
  })

  // ⛔ 2026-09-19 — A NON-FLOW ADDRESS WAS AN HTTP 500 "Failed to load sets."
  // This tracker is Top Shot only by construction (hardcoded collection id,
  // get_topshot_set_progress), so a Solana or EVM address is a question it
  // cannot be asked — not a failure. Worse, `resolveToFlowAddress` treated the
  // address as a USERNAME and spent two round trips on the decommissioned Top
  // Shot GraphQL host before throwing. Shape copied from the house pattern
  // (`cost_basis_unavailable`), not invented.
  it("refuses ?collection=<not Top Shot> instead of answering with Top Shot's sets (substitution, 2026-09-25)", async () => {
    const res = await GET(req("https://t/api/sets?wallet=0xbd94cade097e50ac&collection=candy-mlb"))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("collection_not_supported")
    expect(body.sets).toBeUndefined()
    expect(body.totalSets).toBeUndefined()
  })

  it("a base58 (Solana/Candy) wallet gets a typed not-applicable, not a 500", async () => {
    const CANDY = "12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK"
    const res = await GET(req(`https://t/api/sets?wallet=${CANDY}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.reason).toBe("set_tracking_unavailable")
    expect(body.sets).toEqual([])
    expect(body.wallet).toBe(CANDY)
    // ⛔ NO FABRICATED ZEROS: a count here would be a claim about this wallet's
    // set progress. Absence is the truth, so the keys must be absent.
    expect(body).not.toHaveProperty("totalSets")
    expect(body).not.toHaveProperty("completeSets")
    // Returns before anything downstream runs — no resolver, no RPC.
    expect(state.resolveCalls).toEqual([])
    expect(state.rpcCalls).toBe(0)
  })

  it("an EVM address is equally not-applicable — the rule is 'not Flow', not 'not 0x'", async () => {
    const EVM = "0x1234567890abcdef1234567890abcdef12345678"
    const res = await GET(req(`https://t/api/sets?wallet=${EVM}`))
    expect((await res.json()).reason).toBe("set_tracking_unavailable")
    expect(state.rpcCalls).toBe(0)
  })

  it("no-change control: a real Flow address still reaches the RPC", async () => {
    state.data = null
    const res = await GET(req("https://t/api/sets?wallet=0xbd94cade097e50ac"))
    expect(res.status).toBe(200)
    expect((await res.json()).reason).toBeUndefined()
    expect(state.rpcCalls).toBeGreaterThan(0)
  })

  it("no-change control: a USERNAME still goes to the resolver, never short-circuited", async () => {
    // The narrowing that matters. If this branch caught usernames it would turn
    // "we could not resolve you" into a confident empty answer — the
    // fabricated-absence defect, on the flagship Set Tracker.
    state.data = null
    await GET(req("https://t/api/sets?wallet=jamesdillonbond"))
    expect(state.resolveCalls).toEqual(["jamesdillonbond"])
    expect(state.rpcCalls).toBeGreaterThan(0)
  })

  it("returns an empty progress payload when the RPC has no sets", async () => {
    state.data = null // null payload → sets = []
    const res = await GET(req("https://t/api/sets?wallet=0xabc"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallet).toBe("0xabc")
    expect(body.totalSets).toBe(0)
    expect(body.sets).toEqual([])
  })

  it("500s WITHOUT leaking the driver message when the progress RPC errors", async () => {
    // This test used to assert the leak ("expect(body.error).toBe('db exploded')").
    // The sets page renders body.error verbatim under an "ERROR" heading, so
    // whatever the DB said went straight onto the flagship Set Tracker — which
    // under saturation meant "canceling statement due to statement timeout" in
    // front of anonymous visitors (deep-audit D3).
    state.error = { message: "db exploded" }
    const res = await GET(req("https://t/api/sets?wallet=0xabc"))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe("Failed to load sets.")
    expect(body.error).not.toContain("db exploded")
    expect(body.code).toBe("internal")
  })

  it("503s with retryable copy on a statement timeout, not a raw Postgres string", async () => {
    // 57014 is the code the saturated pooler actually returns.
    state.error = { code: "57014", message: "canceling statement due to statement timeout" }
    const res = await GET(req("https://t/api/sets?wallet=0xabc"))
    // 503 + Retry-After, not 500: transient capacity, and it keeps the route out
    // of the hard-5xx budget that pages on genuine breakage.
    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBe("60")
    const body = await res.json()
    expect(body.code).toBe("timeout")
    expect(body.retryable).toBe(true)
    expect(body.error).not.toMatch(/canceling statement|statement timeout/i)
    expect(body.error).toMatch(/try again/i)
  })
})

// 2026-09-24 — an UNKNOWN cost-to-complete is not a zero. The progress RPC
// returns estimatedCostToComplete = COALESCE(SUM(COALESCE(low_ask, fmv)), 0),
// so a set whose missing plays carry neither an ask nor an FMV came back as 0
// and the Close-to-Completing callout printed "Base Set — 1 away · $0.00" on a
// real wallet. The route now derives it: all-unpriced → null; partially priced
// → the sum (a lower bound) plus how many plays are unpriced.
describe("GET /api/sets — cost-to-complete honesty (2026-09-24)", () => {
  const setRow = (over: Record<string, unknown>) => ({
    setId: "s", setName: "Base Set", series: 5, setTier: "COMMON",
    totalPlays: 10, ownedPlays: 9, missingPlays: 1, completionPct: 90,
    estimatedCostToComplete: 0,
    missingPreview: [{ playId: 1, playerName: "X", tier: "COMMON", lowAsk: null, fmvUsd: null, thumbnailUrl: null, topshotUrl: "" }],
    ...over,
  })
  const progress = (row: Record<string, unknown>) => ({
    wallet: "0xabc", totalSets: 1, completeSets: 0, inProgressSets: 1, notStartedSets: 0, generatedAt: "2026-09-25T05:00:00Z", sets: [row],
  })

  it("publishes null, never $0, when no missing play has an ask or an FMV", async () => {
    state.data = progress(setRow({}))
    const body = await (await GET(req("https://t/api/sets?wallet=0xabc"))).json()
    expect(body.sets[0].totalMissingCost).toBeNull()
    expect(body.sets[0].unpricedMissingCount).toBe(1)
    expect(body.sets[0].tier).not.toBe("almost_there") // no price signal → not "actionable"
  })

  it("keeps a priced set's cost (no-change arm)", async () => {
    state.data = progress(setRow({
      estimatedCostToComplete: 12.5,
      missingPreview: [{ playId: 1, playerName: "X", tier: "COMMON", lowAsk: 12.5, fmvUsd: 11, thumbnailUrl: null, topshotUrl: "" }],
    }))
    const body = await (await GET(req("https://t/api/sets?wallet=0xabc"))).json()
    expect(body.sets[0].totalMissingCost).toBe(12.5)
    expect(body.sets[0].unpricedMissingCount).toBe(0)
  })

  it("reports a partially priced set as a lower bound with the unpriced count", async () => {
    state.data = progress(setRow({
      missingPlays: 2, ownedPlays: 8, completionPct: 80, estimatedCostToComplete: 12.5,
      missingPreview: [
        { playId: 1, playerName: "X", tier: "COMMON", lowAsk: 12.5, fmvUsd: null, thumbnailUrl: null, topshotUrl: "" },
        { playId: 2, playerName: "Y", tier: "COMMON", lowAsk: null, fmvUsd: null, thumbnailUrl: null, topshotUrl: "" },
      ],
    }))
    const body = await (await GET(req("https://t/api/sets?wallet=0xabc"))).json()
    expect(body.sets[0].totalMissingCost).toBe(12.5)
    expect(body.sets[0].unpricedMissingCount).toBe(1)
  })

  it("leaves the count null when the preview cannot cover every missing play", async () => {
    state.data = progress(setRow({ missingPlays: 9, ownedPlays: 1, completionPct: 10, estimatedCostToComplete: 3 }))
    const body = await (await GET(req("https://t/api/sets?wallet=0xabc"))).json()
    expect(body.sets[0].unpricedMissingCount).toBeNull()
    expect(body.sets[0].totalMissingCost).toBe(3)
  })
})
