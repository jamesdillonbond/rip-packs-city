import { describe, it, expect, beforeEach, vi } from "vitest"

// POST /api/profile/trophy-cases/copy-main (2026-11-07). The first outside Dame
// Time entrant filled his MAIN case with Dame and never entered; the dashboard
// now offers "Enter with my N Dame pieces", which calls this. Pins:
//   · every copied pin passes the SAME gate as a hand pin (rule check, Panini
//     ownership) — an ineligible one is SKIPPED with its reason, never copied;
//   · a check that could not RUN is a 503, never a silent skip;
//   · only EMPTY slots are filled, nothing already in the entry is duplicated;
//   · `copied` counts rows the write RETURNED;
//   · a closed challenge / a non-challenge case / someone else's case is refused.

const CASE = "11111111-1111-4111-8111-111111111111"
const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const PANINI = "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b"

const state: any = {}
vi.mock("@/lib/supabase", () => {
  const build = () => {
    const q: any = { isMain: false }
    for (const m of ["select", "eq", "order", "limit", "in", "not"]) q[m] = () => q
    q.is = () => ((q.isMain = true), q)
    q.upsert = (rows: any) => {
      state.upserted = rows
      return { select: async () => state.upsertResult ?? { data: rows.map((r: any) => ({ slot: r.slot })), error: null } }
    }
    q.then = (res: any) => res(q.isMain ? state.main : state.inCase)
    return q
  }
  const client = { from: () => build() }
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
vi.mock("@/lib/trophy/panini-card", () => ({ resolvePaniniTrophyCard: async () => state.panini }))

import { POST } from "@/app/api/profile/trophy-cases/copy-main/route"

const DAME = { id: "ch1", slug: "dame-time", title: "Dame Time", rules: { player_names: ["Damian Lillard"] }, is_active: true, starts_at: null, ends_at: null }
const pin = (slot: number, over: any = {}) => ({ slot, moment_id: "m" + slot, collection_id: TS, player_name: "Damian Lillard", note: slot === 1 ? "my fave" : null, ...over })
const req = (body: any) => ({ json: async () => body }) as any

beforeEach(() => {
  state.user = { id: "u1" }
  state.own = { ok: true, case: { id: CASE, name: "Dame Time", challenge: DAME } }
  state.main = { data: [1, 2, 3, 4, 5, 6].map((s) => pin(s)), error: null }
  state.inCase = { data: [], error: null }
  state.check = () => ({ kind: "eligible" })
  state.panini = { ok: true, card: { playerName: "Damian Lillard" } }
  state.upserted = null
  state.upsertResult = null
})

describe("copy-main", () => {
  it("copies every eligible main pin into the entry's slots, caption and all", async () => {
    const res = await POST(req({ caseId: CASE }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ copied: 6, skipped: [] })
    expect(state.upserted.map((r: any) => [r.slot, r.moment_id, r.case_id])).toEqual(
      [1, 2, 3, 4, 5, 6].map((s) => [s, "m" + s, CASE]),
    )
    expect(state.upserted[0].note).toBe("my fave")
  })

  it("⚠ an INELIGIBLE pin is skipped with its reason — never copied because it was in the main case", async () => {
    state.main = { data: [pin(1), pin(2, { moment_id: "lebron", player_name: "LeBron James" }), pin(3)], error: null }
    state.check = (i: any) =>
      i.momentId === "lebron" ? { kind: "ineligible", status: 422, error: "Dame Time is Damian Lillard only — that Moment is LeBron James." } : { kind: "eligible" }
    const body = await (await POST(req({ caseId: CASE }))).json()
    expect(body.copied).toBe(2)
    expect(body.skipped).toEqual([{ slot: 2, player_name: "LeBron James", reason: "Dame Time is Damian Lillard only — that Moment is LeBron James." }])
    expect(state.upserted.map((r: any) => r.moment_id)).toEqual(["m1", "m3"])
    expect(state.upserted.map((r: any) => r.slot)).toEqual([1, 2])
  })

  it("⚠ a check that could not RUN is a 503 and writes nothing — never a silent skip", async () => {
    state.check = () => ({ kind: "unchecked", error: { message: "timeout", code: "57014" } })
    const res = await POST(req({ caseId: CASE }))
    expect(res.status).toBe(503)
    expect(state.upserted).toBeNull()
  })

  it("a Panini card no longer held under a linked username is skipped", async () => {
    state.main = { data: [pin(1, { collection_id: PANINI })], error: null }
    state.panini = { ok: true, card: null }
    const body = await (await POST(req({ caseId: CASE }))).json()
    expect(body.copied).toBe(0)
    expect(body.skipped[0].reason).toMatch(/Panini username/)
  })

  it("fills only EMPTY slots and never duplicates a piece already in the entry", async () => {
    state.inCase = { data: [{ slot: 1, moment_id: "m1", collection_id: TS }, { slot: 3, moment_id: "x", collection_id: TS }], error: null }
    const body = await (await POST(req({ caseId: CASE }))).json()
    expect(body.copied).toBe(4)
    expect(state.upserted.map((r: any) => [r.slot, r.moment_id])).toEqual([[2, "m2"], [4, "m3"], [5, "m4"], [6, "m5"]])
  })

  it("`copied` counts rows the write RETURNED; a failed write is an error, not a count", async () => {
    state.upsertResult = { data: null, error: { message: "boom", code: "XX000" } }
    const res = await POST(req({ caseId: CASE }))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).copied).toBeUndefined()
  })

  it("refuses a non-challenge case, a closed challenge, someone else's case, a bad id, and signed-out", async () => {
    state.own = { ok: true, case: { id: CASE, name: "Blazers", challenge: null } }
    expect((await POST(req({ caseId: CASE }))).status).toBe(400)
    state.own = { ok: true, case: { id: CASE, name: "Dame Time", challenge: { ...DAME, is_active: false } } }
    expect((await POST(req({ caseId: CASE }))).status).toBe(409)
    state.own = { ok: true, case: null }
    expect((await POST(req({ caseId: CASE }))).status).toBe(404)
    expect((await POST(req({ caseId: "nope" }))).status).toBe(400)
    state.user = null
    expect((await POST(req({ caseId: CASE }))).status).toBe(401)
    expect(state.upserted).toBeNull()
  })
})
