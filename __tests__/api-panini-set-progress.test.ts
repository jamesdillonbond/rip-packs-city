import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * GET /api/panini-set-progress — Panini Sets tab backend (2026-09-27).
 *
 * Stated as the ABSENCE of false claims: a failed read is not an empty tracker, a
 * malformed username is not "0 of 499 owned", a username RPC never saw is not
 * "owns nothing", and a malformed row is not silently dropped from the list.
 */

type Res = { data: unknown; error: unknown }
const state: { rpc: Res; coverage: Res } = { rpc: { data: [], error: null }, coverage: { data: [], error: null } }
const rpcArgs: unknown[] = []

vi.mock("@/lib/supabase", () => {
  const coverage: any = {
    select: () => coverage,
    limit: () => coverage,
    then: (resolve: any) => resolve(state.coverage),
  }
  return {
    supabaseAdmin: {
      from: () => coverage,
      rpc: (_fn: string, args: unknown) => {
        rpcArgs.push(args)
        return { then: (resolve: any) => resolve(state.rpc) }
      },
    },
  }
})

import { GET } from "@/app/api/panini-set-progress/route"
import { parsePaniniSetRow } from "@/lib/panini/set-progress"

const req = (qs = "") => ({ nextUrl: new URL("https://t/api/panini-set-progress" + qs) }) as any

const ROW = {
  set_name: "Base Prizms Gold", editions_seen: 312, players_seen: 312, min_mint_cap: 10, max_mint_cap: 10,
  still_in_packs: 331, owned: 0, missing: 312, missing_asked: 300, missing_unasked: 12,
  cost_usd: "412000.00", max_missing_ask_usd: "100000", owner_last_seen_at: null,
}

beforeEach(() => {
  rpcArgs.length = 0
  state.rpc = { data: [ROW], error: null }
  state.coverage = { data: [{ total_editions: 5101, pct_trustworthy: 35 }], error: null }
})

async function body(qs = "") {
  const res = await GET(req(qs))
  return { status: res.status, json: await res.json() }
}

describe("GET /api/panini-set-progress", () => {
  it("serves every set with the cost split into priced + unpriced and the largest ask", async () => {
    const { status, json } = await body()
    expect(status).toBe(200)
    expect(rpcArgs[0]).toEqual({ p_username: null })
    expect(json.username).toBeNull()
    expect(json.userSeen).toBeNull()
    expect(json.sets[0]).toMatchObject({ setName: "Base Prizms Gold", missingAsked: 300, missingUnasked: 12, costUsd: 412000, maxMissingAskUsd: 100000 })
  })

  it("folds the username before the read (owner is matched on lower())", async () => {
    state.rpc = { data: [{ ...ROW, owned: 5, missing: 307, owner_last_seen_at: "2026-09-27 14:24:49+00" }], error: null }
    const { json } = await body("?username=@AdlCards")
    expect(rpcArgs[0]).toEqual({ p_username: "adlcards" })
    expect(json.userSeen).toBe(true)
    expect(json.userLastSeenAt).toBe("2026-09-27 14:24:49+00")
  })

  it("a username RPC has never seen is userSeen:false — not 'owns nothing'", async () => {
    const { json } = await body("?username=nobody_here")
    expect(json.userSeen).toBe(false)
    expect(json.userLastSeenAt).toBeNull()
  })

  it("a malformed username is a 400 for the username — no read, no all-zero tracker", async () => {
    const { status, json } = await body("?username=" + encodeURIComponent("0x1234567890abcdef1234"))
    expect(status).toBe(400)
    expect(json.sets).toBeUndefined()
    expect(rpcArgs).toHaveLength(0)
  })

  it("a failed read is a 503, never an empty set list", async () => {
    state.rpc = { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } }
    const { status, json } = await body()
    expect(status).toBe(503)
    expect(json.sets).toBeUndefined()
    expect(JSON.stringify(json)).not.toContain("canceling statement")
  })

  it("a malformed row fails the read rather than vanishing from the list", async () => {
    state.rpc = { data: [ROW, { ...ROW, set_name: "Base Prizms Blue", missing: null }], error: null }
    const { status, json } = await body()
    expect(status).toBeGreaterThanOrEqual(500)
    expect(json.sets).toBeUndefined()
  })

  it("a failed coverage read drops the figures and says so; the sets still serve", async () => {
    state.coverage = { data: null, error: { message: "boom" } }
    const { status, json } = await body()
    expect(status).toBe(200)
    expect(json.coverage).toBeNull()
    expect(json.coverage_error).toBe(true)
    expect(json.sets).toHaveLength(1)
  })
})

describe("parsePaniniSetRow", () => {
  it("a null count is a malformed row, never a zero", () => {
    for (const k of ["owned", "missing", "missing_asked", "missing_unasked"]) {
      expect(parsePaniniSetRow({ ...ROW, [k]: null }), k).toBeNull()
    }
  })
  it("no priced edition leaves the cost null, not $0", () => {
    const r = parsePaniniSetRow({ ...ROW, missing_asked: 0, cost_usd: null, max_missing_ask_usd: null })
    expect(r?.costUsd).toBeNull()
    expect(r?.maxMissingAskUsd).toBeNull()
  })
  it("drops a row with no set name or no seen editions", () => {
    expect(parsePaniniSetRow({ ...ROW, set_name: "" })).toBeNull()
    expect(parsePaniniSetRow({ ...ROW, editions_seen: 0 })).toBeNull()
    expect(parsePaniniSetRow(null)).toBeNull()
  })
})
