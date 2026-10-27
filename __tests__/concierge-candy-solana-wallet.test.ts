// 2026-09-25 — asked "What is wallet 2srdg8i1…tiZ3 worth?" on Candy MLB, the
// concierge said Solana wallet lookups are not supported and sent the collector
// to Magic Eden — while RPC's indexed snapshot already held that wallet (1,078
// Candy moments, $2,891.68). check_wallet treated any non-hex input as a Top
// Shot USERNAME and prefixed every key with 0x: the two reflexes CLAUDE.md says
// destroy a case-sensitive base58 key.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

const A = vi.hoisted(() => ({
  state: { script: [] as ScriptTurn[], cursor: 0 },
  createCalls: [] as Array<{ messages: Array<{ role: string; content: unknown }> }>,
  sb: null as unknown,
}))
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/auth/supabase-server", () => ({
  getSupabaseServer: async () => ({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } }),
}))
vi.mock("@/lib/pro-tier", () => ({
  checkFeatureQuota: async () => ({ allowed: true, plan: "pro", daily_limit: 200 }),
  recordFeatureUsage: async () => {},
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => new Proxy({}, { get: (_t, prop) => (A.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@anthropic-ai/sdk", async () => {
  const { buildAnthropicClass } = await import("./helpers/anthropic-fixture")
  const Base = buildAnthropicClass(A.state) as new () => { messages: { create: (args: unknown) => Promise<unknown>; stream: (args: unknown) => unknown } }
  return {
    default: class {
      messages = (() => {
        const inner = new Base().messages
        return {
          create: async (args: unknown) => {
            A.createCalls.push(args as never)
            return inner.create(args)
          },
          stream: inner.stream,
        }
      })()
    },
  }
})
process.env.ANTHROPIC_API_KEY = "test-key"
const { POST } = await import("@/app/api/support-chat/route")

const SOL = "2srdg8i14ZCnmMVUZ4wVUJGkuiwSLnNTGaL1REFGtiZ3"
const SNAP = {
  wallet: SOL, totalMoments: 1078, totalFmv: 2891.68, badgeCount: 0,
  perCollection: [{ slug: "candy_mlb", name: "Candy MLB", moments: 1078, fmv: 2891.68 }],
  topMoments: [], rarest: null,
}

function post(collectionId: string): NextRequest {
  return new NextRequest("https://t/api/support-chat", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ message: "what is this wallet worth", sessionId: `s-${Math.random()}`, collectionId }),
  })
}
function toolResult(): Record<string, any> {
  const blocks = A.createCalls.at(-1)?.messages.at(-1)?.content as Array<{ type: string; content: string }>
  const tr = blocks?.find((b) => b.type === "tool_result")
  if (!tr) throw new Error("no tool_result")
  return JSON.parse(tr.content)
}
function script(tool: string, input: Record<string, unknown>) {
  A.state.script = [{ tools: [{ name: tool, input }] }, { text: "done" }]
  A.state.cursor = 0
}

beforeEach(() => {
  A.createCalls.length = 0
})

describe("check_wallet — a Candy MLB (Solana) wallet", () => {
  it("reads the snapshot with the base58 key VERBATIM — no username lookup, no 0x", async () => {
    const inst = makeInstrumentedSupabaseFixture({
      "rpc:get_wallet_collection_snapshot": { data: SNAP, error: null },
      wallet_moments_cache: { data: [{ player_name: "Shohei Ohtani", set_name: "2026 MLB Base Series ICONs", tier: "COMMON", serial_number: 7, mint_count: 250, fmv_usd: 22.29, edition_key: "shohei-ohtani" }], error: null },
    })
    A.sb = inst.fixture
    script("check_wallet", { walletAddress: SOL, collectionId: "candy-mlb" })
    await POST(post("candy-mlb"))
    const snapCall = inst.rpcCalls.find((c) => c.name === "get_wallet_collection_snapshot")
    expect(snapCall?.args).toEqual({ p_wallet: SOL })
    expect(inst.rpcCalls.some((c) => c.name === "resolve_topshot_username")).toBe(false)
    const r = toolResult()
    expect(r).toMatchObject({ status: "ok", wallet: SOL, total_moments_all_collections: 1078, total_fmv_all_collections: 2891.68 })
    expect(r.collection_detail).toMatchObject({ collection: "candy-mlb", total_moments: 1078, portfolio_fmv: 2891.68 })
  })

  it("nothing indexed → not_indexed (may be empty OR unindexed), never a Top Shot walk", async () => {
    A.sb = makeInstrumentedSupabaseFixture({ "rpc:get_wallet_collection_snapshot": { data: { totalMoments: 0 }, error: null } }).fixture
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    script("check_wallet", { walletAddress: SOL, collectionId: "candy-mlb" })
    await POST(post("candy-mlb"))
    const r = toolResult()
    expect(r.status).toBe("not_indexed")
    expect(r.wallet).toBe(SOL)
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes("/api/wallet-search"))).toBe(false)
    fetchSpy.mockRestore()
  })

  it("a FAILED snapshot read is an error, never 'empty'", async () => {
    A.sb = makeInstrumentedSupabaseFixture({ "rpc:get_wallet_collection_snapshot": { data: null, error: { message: "timeout" } } }).fixture
    script("check_wallet", { walletAddress: SOL, collectionId: "candy-mlb" })
    await POST(post("candy-mlb"))
    expect(toolResult().status).toBe("error")
  })

  it("a Flow hex wallet still reads with its 0x key (no-change arm)", async () => {
    const inst = makeInstrumentedSupabaseFixture({
      "rpc:get_wallet_collection_snapshot": { data: { ...SNAP, wallet: "0xbd94cade097e50ac", perCollection: [{ slug: "nba_top_shot", moments: 5, fmv: 10 }], totalMoments: 5, totalFmv: 10 }, error: null },
    })
    A.sb = inst.fixture
    script("check_wallet", { walletAddress: "0xbd94cade097e50ac" })
    await POST(post("nba-top-shot"))
    expect(inst.rpcCalls.find((c) => c.name === "get_wallet_collection_snapshot")?.args).toEqual({ p_wallet: "0xbd94cade097e50ac" })
  })
})

// 2026-10-26 (Candy ↔ Top Shot parity) — RE-PIN, premise changed: wallet_moments_cache holds a
// FULL daily census of every Candy card, so analyze_wallet_holdings and find_quirky_serials now
// READ a Solana wallet (verbatim, no 0x, no username lookup) instead of refusing it. The property
// held in place is unchanged: a base58 key is never folded, prefixed or resolved as a Top Shot
// username. check_wallet_squeeze (a Top Shot locks/burns concept) still refuses.
describe("a Solana wallet in the Candy-capable wallet tools", () => {
  it("check_wallet_squeeze → unsupported_chain, not a username miss", async () => {
    const inst = makeInstrumentedSupabaseFixture({})
    A.sb = inst.fixture
    script("check_wallet_squeeze", { walletAddress: SOL })
    await POST(post("candy-mlb"))
    const r = toolResult()
    expect(r.status).toBe("unsupported_chain")
    expect(r.message).toContain("check_wallet")
    expect(inst.rpcCalls.some((c) => c.name === "resolve_topshot_username")).toBe(false)
  })

  it("analyze_wallet_holdings reads the Candy census with the base58 key VERBATIM", async () => {
    const inst = makeInstrumentedSupabaseFixture({
      "rpc:concierge_wallet_breakdown": { data: { status: "ok", total_moments: 3, total_fmv: 12.5, groups: [] }, error: null },
    })
    A.sb = inst.fixture
    script("analyze_wallet_holdings", { walletAddress: SOL })
    await POST(post("candy-mlb"))
    const call = inst.rpcCalls.find((c) => c.name === "concierge_wallet_breakdown")
    expect(call?.args).toMatchObject({ p_wallet: SOL, p_collection_id: "209ade70-32c5-4470-bc7c-4793d660f713" })
    expect(inst.rpcCalls.some((c) => c.name === "resolve_topshot_username")).toBe(false)
    const r = toolResult()
    expect(r).toMatchObject({ status: "ok", collection: "candy-mlb", wallet: SOL })
    expect(r.status).not.toBe("unsupported_chain")
  })

  it("find_quirky_serials scans the Candy census with the base58 key VERBATIM (never 0x-prefixed)", async () => {
    const inst = makeInstrumentedSupabaseFixture({
      wallet_moments_cache: { data: [{ serial_number: 1, mint_count: 250, player_name: "Shohei Ohtani", set_name: "2026 MLB Base Series ICONs", edition_key: "shohei-ohtani" }], error: null },
      editions: { data: [], error: null },
    })
    A.sb = inst.fixture
    script("find_quirky_serials", { walletAddress: SOL })
    await POST(post("candy-mlb"))
    expect(inst.rpcCalls.some((c) => c.name === "resolve_topshot_username")).toBe(false)
    const r = toolResult()
    expect(r.status).not.toBe("unsupported_chain")
    expect(r.wallet).toBe(SOL)
    expect(r.collection).toBe("candy-mlb")
  })

  it("a Top Shot username on a Candy page is asked for a Solana wallet, never looked up as Top Shot", async () => {
    const inst = makeInstrumentedSupabaseFixture({})
    A.sb = inst.fixture
    script("analyze_wallet_holdings", { walletAddress: "somecollector" })
    await POST(post("candy-mlb"))
    expect(toolResult().status).toBe("need_solana_wallet")
    expect(inst.rpcCalls.some((c) => c.name === "resolve_topshot_username")).toBe(false)
  })
})

// 2026-10-26: Top Shot-only boards must not answer a Candy question (substitution).
describe("Top Shot boards on a Candy page", () => {
  it("get_special_serial_owners reads Candy's own board, never the Top Shot RPC", async () => {
    const inst = makeInstrumentedSupabaseFixture({
      candy_special_serials_board: { data: [{ external_id: "shohei-ohtani", player_name: "Shohei Ohtani", kind: "first_mint", serial_number: 1, owner: SOL, is_treasury: false, fmv_usd: 40 }], error: null },
    })
    A.sb = inst.fixture
    script("get_special_serial_owners", { playerName: "Ohtani" })
    await POST(post("candy-mlb"))
    expect(inst.rpcCalls.some((c) => c.name === "get_special_serial_owners_board")).toBe(false)
    const r = toolResult()
    expect(r).toMatchObject({ status: "ok", collection: "candy-mlb" })
    expect(r.rows[0].edition_url).toContain("/candy-mlb/edition/")
  })

  it("a Candy player name is never resolved against TOP SHOT's player table first (2026-10-27)", async () => {
    const inst = makeInstrumentedSupabaseFixture({
      candy_special_serials_board: { data: [], error: null },
    })
    A.sb = inst.fixture
    script("get_special_serial_owners", { playerName: "Ohtani" })
    await POST(post("candy-mlb"))
    const tsUuid = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
    expect(inst.rpcCalls.some((c) => c.name === "resolve_player_name" && c.args?.p_collection_id === tsUuid)).toBe(false)
    expect(toolResult()).toMatchObject({ collection: "candy-mlb" })
  })

  for (const tool of ["search_serial_deals", "get_hot_floors", "get_edition_sweep"]) {
    it(`${tool} → not_applicable on Candy, no Top Shot read`, async () => {
      const inst = makeInstrumentedSupabaseFixture({})
      A.sb = inst.fixture
      script(tool, { editionKey: "1:2" })
      await POST(post("candy-mlb"))
      expect(toolResult().status).toBe("not_applicable")
      expect(inst.rpcCalls.length).toBe(0)
    })
  }
})

describe("Flow-only report tools on a Candy wallet", () => {
  for (const tool of ["get_collector_report", "get_challenges"]) {
    it(`${tool} → not_applicable, never a Top Shot username lookup`, async () => {
      const inst = makeInstrumentedSupabaseFixture({})
      A.sb = inst.fixture
      script(tool, { walletAddress: SOL })
      await POST(post("candy-mlb"))
      expect(toolResult().status).toBe("not_applicable")
      expect(inst.rpcCalls.some((c) => c.name === "resolve_topshot_username")).toBe(false)
    })
  }

  it("search_live_deals on Candy reads Candy's board, never the Flow sniper feed", async () => {
    const inst = makeInstrumentedSupabaseFixture({
      candy_market_board: { data: [{ external_id: "a", player_name: "P", ask_usd: 8, fmv_usd: 10, discount_pct: 20, serial_number: 3 }], error: null },
    })
    A.sb = inst.fixture
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    script("search_live_deals", {})
    await POST(post("candy-mlb"))
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes("/api/sniper-feed"))).toBe(false)
    fetchSpy.mockRestore()
    expect(toolResult()).toMatchObject({ status: "ok", collection: "candy-mlb", kind: "below_fmv" })
  })
})
