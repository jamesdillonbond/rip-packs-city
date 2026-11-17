import { describe, it, expect, beforeEach, vi } from "vitest"

// POST /api/profile/trophy-cases/fill (2026-11-08 weekend review): "Fill my case"
// for a challenge entry. Pins:
//   · without `confirm` it PROPOSES and writes nothing;
//   · every proposed piece passed the SAME gate as a hand pin — an ineligible one
//     is never proposed, and a check that could not RUN is a 503, never a quiet
//     "you're short";
//   · order: new editions first, then highest FMV (the at-close fill's order);
//   · only EMPTY slots are written; `pinned` counts rows the write RETURNED;
//   · a closed challenge / a non-challenge case / no saved wallet is refused.

const CASE = "11111111-1111-4111-8111-111111111111"
const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const FRESH = "2026-11-09T04:00:00Z"

const state: any = {}
vi.mock("@/lib/supabase", () => {
  const build = (table: string) => {
    const q: any = { table, filters: {} as Record<string, unknown> }
    for (const m of ["select", "order", "limit", "not", "neq"]) q[m] = () => q
    q.eq = (c: string, v: unknown) => ((q.filters[c] = v), q)
    q.in = (c: string, v: unknown) => ((q.filters[c] = v), q)
    q.upsert = (rows: any, opts: any) => {
      state.upserted = rows
      state.upsertOpts = opts
      return { select: async () => state.upsertResult ?? { data: rows.map((r: any) => ({ slot: r.slot })), error: null } }
    }
    q.then = (res: any) => {
      if (table === "trophy_moments") return res(state.inCase)
      if (table === "saved_wallets") return res(state.wallets)
      if (table === "collections") return res(state.collections)
      if (table === "wallet_moments_cache") {
        // the per-wallet "newest row" read filters on wallet_address with eq
        return res("wallet_address" in q.filters && typeof q.filters.wallet_address === "string" ? state.newest : state.candidates)
      }
      return res({ data: [], error: null })
    }
    return q
  }
  const client = { from: (t: string) => build(t) }
  return { supabase: client, supabaseAdmin: client }
})
vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user) throw new Response("{}", { status: 401 })
    return state.user
  },
}))
vi.mock("@/lib/trophy/cases", async (orig) => ({
  ...(await orig<typeof import("@/lib/trophy/cases")>()),
  loadOwnCase: async () => state.own,
}))
vi.mock("@/lib/trophy/challenge-rules", async (orig) => ({
  ...(await orig<typeof import("@/lib/trophy/challenge-rules")>()),
  checkChallengePin: async (_db: any, _r: any, _t: any, input: any) => state.check(input),
}))
vi.mock("@/lib/og/card-warm", () => ({ warmCardsLater: () => {} }))

import { POST } from "@/app/api/profile/trophy-cases/fill/route"

const DAME = {
  id: "ch1",
  slug: "dame-time",
  title: "Dame Time",
  rules: { player_names: ["Damian Lillard"], collection_slugs: ["nba_top_shot", "panini_blockchain"] },
  is_active: true,
  starts_at: null,
  ends_at: null,
}
const cand = (id: string, fmv: number | null, edition: string, over: any = {}) => ({
  wallet_address: "0xw",
  moment_id: id,
  collection_id: TS,
  edition_key: edition,
  fmv_usd: fmv,
  serial_number: 10,
  last_seen_at: FRESH,
  is_locked: false,
  lock_checked_at: null,
  player_name: "Damian Lillard",
  set_name: "Base Set",
  tier: "COMMON",
  mint_count: 1000,
  ...over,
})
const req = (body: any) => ({ json: async () => body }) as any

beforeEach(() => {
  state.user = { id: "u1" }
  state.own = { ok: true, case: { id: CASE, name: "Dame Time", challenge: DAME } }
  state.inCase = { data: [1, 2, 3, 4, 5].map((s) => ({ slot: s, moment_id: "p" + s, edition_id: "pe" + s })), error: null }
  state.wallets = { data: [{ wallet_addr: "0xw" }], error: null }
  state.collections = { data: [{ id: TS, slug: "nba_top_shot" }, { id: "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b", slug: "panini_blockchain" }], error: null }
  state.newest = { data: [{ last_seen_at: FRESH }], error: null }
  state.candidates = { data: [cand("cheap", 1, "e1"), cand("rich", 21, "e2")], error: null }
  state.check = () => ({ kind: "eligible" })
  state.upserted = null
  state.upsertOpts = null
  state.upsertResult = null
})

describe("POST /api/profile/trophy-cases/fill", () => {
  it("without confirm it PROPOSES the empty slots — highest FMV first — and writes nothing", async () => {
    const res = await POST(req({ caseId: CASE }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.need).toBe(1)
    expect(body.short).toBe(0)
    expect(body.picks.map((p: any) => [p.slot, p.moment_id, p.fmv])).toEqual([[6, "rich", 21]])
    expect(state.upserted).toBeNull()
  })

  it("with confirm it pins into the EMPTY slots only, without displacing a pin, and counts what landed", async () => {
    const body = await (await POST(req({ caseId: CASE, confirm: true }))).json()
    expect(body.pinned).toBe(1)
    expect(body.short).toBe(0)
    expect(state.upserted.map((r: any) => [r.slot, r.moment_id, r.case_id])).toEqual([[6, "rich", CASE]])
    expect(state.upsertOpts).toEqual({ onConflict: "user_id,case_id,slot", ignoreDuplicates: true })
    expect(state.upserted[0].thumbnail_url).toBe("https://assets.nbatopshot.com/media/rich/image?width=512")
  })

  it("⚠ an INELIGIBLE piece is never proposed; not enough eligible pieces says how many short", async () => {
    state.check = (i: any) => (i.momentId === "rich" ? { kind: "ineligible", status: 422, error: "no" } : { kind: "eligible" })
    state.inCase = { data: [1, 2, 3, 4].map((s) => ({ slot: s, moment_id: "p" + s, edition_id: "pe" + s })), error: null }
    const body = await (await POST(req({ caseId: CASE }))).json()
    expect(body.picks.map((p: any) => p.moment_id)).toEqual(["cheap"])
    expect(body.short).toBe(1)
  })

  it("⚠ a check that could not RUN is a 503 and writes nothing — never a quiet 'you're short'", async () => {
    state.check = () => ({ kind: "unchecked", error: { message: "timeout", code: "57014" } })
    const res = await POST(req({ caseId: CASE, confirm: true }))
    expect(res.status).toBe(503)
    expect(state.upserted).toBeNull()
  })

  it("a piece the wallet's latest walk did not re-see is not offered (may be sold) — unless locked", async () => {
    state.candidates = {
      data: [cand("stale", 99, "e3", { last_seen_at: "2026-08-01T00:00:00Z" }), cand("locked", 50, "e4", { last_seen_at: "2026-08-01T00:00:00Z", is_locked: true, lock_checked_at: new Date().toISOString() })],
      error: null,
    }
    const body = await (await POST(req({ caseId: CASE }))).json()
    expect(body.picks.map((p: any) => p.moment_id)).toEqual(["locked"])
  })

  it("`pinned` counts rows the write RETURNED; a failed write is an error", async () => {
    state.upsertResult = { data: null, error: { message: "boom", code: "XX000" } }
    const res = await POST(req({ caseId: CASE, confirm: true }))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).pinned).toBeUndefined()
  })

  it("refuses a non-challenge case, a closed challenge, no saved wallet, a bad id, and signed-out", async () => {
    state.own = { ok: true, case: { id: CASE, name: "Blazers", challenge: null } }
    expect((await POST(req({ caseId: CASE }))).status).toBe(400)
    state.own = { ok: true, case: { id: CASE, name: "Dame Time", challenge: { ...DAME, is_active: false } } }
    expect((await POST(req({ caseId: CASE }))).status).toBe(409)
    state.own = { ok: true, case: { id: CASE, name: "Dame Time", challenge: DAME } }
    state.wallets = { data: [], error: null }
    expect((await POST(req({ caseId: CASE }))).status).toBe(403)
    expect((await POST(req({ caseId: "nope" }))).status).toBe(400)
    state.user = null
    expect((await POST(req({ caseId: CASE }))).status).toBe(401)
  })

  it("a full entry proposes nothing", async () => {
    state.inCase = { data: [1, 2, 3, 4, 5, 6].map((s) => ({ slot: s, moment_id: "p" + s, edition_id: "pe" + s })), error: null }
    expect(await (await POST(req({ caseId: CASE }))).json()).toEqual({ need: 0, picks: [], short: 0, pinned: 0 })
  })
})
