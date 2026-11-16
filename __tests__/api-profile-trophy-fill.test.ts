import { describe, it, expect, beforeEach, vi } from "vitest"
import { chooseMainFillPicks, freeMainSlots, mainFillConfirmCopy } from "@/lib/trophy/fill-main"

// "Fill with my top 6" for the MAIN trophy case (2026-11-16).
// Route: signed-in only; proposes without writing; confirms by pinning ONLY empty
// slots; candidates are the picker's list minus Panini; a failed read is an error,
// never an empty proposal; `pinned` counts rows the upsert returned.

const st: {
  user: any
  caseRows: any[]
  caseErr: any
  cands: any[]
  candErr: any
  upsertArgs: any[]
  upsertOpts: any
  upsertReturn: any[]
  upsertErr: any
} = { user: null, caseRows: [], caseErr: null, cands: [], candErr: null, upsertArgs: [], upsertOpts: null, upsertReturn: [], upsertErr: null }

function thenable(v: any) {
  const p: any = Promise.resolve(v)
  const chain: any = new Proxy(p, {
    get(t, k) {
      if (k === "then" || k === "catch" || k === "finally") return (t as any)[k].bind(t)
      return () => chain
    },
  })
  return chain
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => thenable({ data: st.caseRows, error: st.caseErr }),
      upsert: (rows: any[], opts: any) => {
        st.upsertArgs = rows
        st.upsertOpts = opts
        return { select: () => Promise.resolve({ data: st.upsertErr ? null : st.upsertReturn, error: st.upsertErr }) }
      },
      _t: table,
    }),
    rpc: (_fn: string, _args: any) => thenable({ data: st.cands, error: st.candErr }),
  },
}))
vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!st.user) throw new Response(JSON.stringify({ error: "Authentication required" }), { status: 401 })
    return st.user
  },
}))
const funnel = vi.fn(async (..._a: any[]) => {})
vi.mock("@/lib/trophy/funnel-event", () => ({ logTrophyFunnelEvent: (...a: any[]) => funnel(...a) }))
vi.mock("@/lib/og/card-warm", () => ({ warmCardsLater: () => {} }))

import { POST } from "@/app/api/profile/trophy/fill/route"
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"

const TS = COLLECTION_UUID_BY_SLUG["nba-top-shot"]
const PANINI = COLLECTION_UUID_BY_SLUG["panini-blockchain"]
const c = (id: string, ed: string, fmv: number, col = TS) => ({
  moment_id: id, collection_id: col, edition_key: ed, player_name: `P${id}`, set_name: "S1 Base", tier: "COMMON",
  serial_number: Number(id), mint_count: 1000, fmv_usd: fmv, image_url: `https://assets.nbatopshot.com/media/${id}/image?width=512`,
})
const req = (body: any) => ({ json: async () => body, headers: { get: () => "ua" } }) as any

beforeEach(() => {
  st.user = { id: "u1" }
  st.caseRows = []
  st.caseErr = null
  st.cands = [c("1", "e1", 50), c("2", "e1", 40), c("3", "e3", 30), c("4", "e4", 20, PANINI), c("5", "e5", 10), c("6", "e6", 9), c("7", "e7", 8), c("8", "e8", 7)]
  st.candErr = null
  st.upsertArgs = []
  st.upsertOpts = null
  st.upsertReturn = []
  st.upsertErr = null
  funnel.mockClear()
})

describe("POST /api/profile/trophy/fill", () => {
  it("401 signed out", async () => {
    st.user = null
    expect((await POST(req({}))).status).toBe(401)
  })

  it("proposes without writing: highest FMV, one per edition, no Panini", async () => {
    const res = await POST(req({}))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.picks.map((p: any) => p.moment_id)).toEqual(["1", "3", "5", "6", "7", "8"])
    expect(body.picks.map((p: any) => p.slot)).toEqual([1, 2, 3, 4, 5, 6])
    expect(body.short).toBe(0)
    expect(st.upsertArgs).toEqual([])
  })

  it("only EMPTY slots are proposed and written, never displacing a pin", async () => {
    st.caseRows = [{ slot: 1, moment_id: "1", edition_id: "e1" }, { slot: 4, moment_id: "x", edition_id: "e9" }]
    st.upsertReturn = [{ slot: 2 }, { slot: 3 }, { slot: 5 }, { slot: 6 }]
    const res = await POST(req({ confirm: true }))
    const body = await res.json()
    expect(st.upsertArgs.map((r) => r.slot)).toEqual([2, 3, 5, 6])
    expect(st.upsertArgs.every((r) => r.case_id === null && r.user_id === "u1")).toBe(true)
    expect(st.upsertArgs.map((r) => r.moment_id)).not.toContain("1")
    expect(st.upsertOpts).toEqual({ onConflict: "user_id,case_id,slot", ignoreDuplicates: true })
    expect(body.pinned).toBe(4)
    expect(funnel).toHaveBeenCalledTimes(4)
  })

  it("pinned counts rows the upsert RETURNED, not rows attempted", async () => {
    st.upsertReturn = [{ slot: 1 }]
    const body = await (await POST(req({ confirm: true }))).json()
    expect(st.upsertArgs.length).toBe(6)
    expect(body.pinned).toBe(1)
    expect(body.short).toBe(5)
  })

  it("a full case proposes nothing", async () => {
    st.caseRows = [1, 2, 3, 4, 5, 6].map((s) => ({ slot: s, moment_id: `m${s}`, edition_id: null }))
    expect(await (await POST(req({ confirm: true }))).json()).toEqual({ need: 0, picks: [], short: 0, pinned: 0 })
  })

  it("a failed read is an error status, never an empty proposal", async () => {
    st.candErr = { message: "canceling statement due to statement timeout" }
    let res = await POST(req({}))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(await res.json()).not.toHaveProperty("picks")
    st.candErr = null
    st.caseErr = { message: "boom" }
    res = await POST(req({}))
    expect(res.status).toBeGreaterThanOrEqual(500)
  })

  it("a failed write is an error, not a success", async () => {
    st.upsertErr = { message: "duplicate key" }
    const res = await POST(req({ confirm: true }))
    expect(res.status).toBeGreaterThanOrEqual(500)
  })
})

describe("chooseMainFillPicks", () => {
  it("tops up with a repeat edition only when there are too few distinct ones", () => {
    const picks = chooseMainFillPicks([c("1", "e1", 50), c("2", "e1", 40), c("3", "e3", 30)], {
      freeSlots: [1, 2, 3], pinnedMomentIds: new Set(), pinnedEditions: new Set(),
    })
    expect(picks.map((p) => p.moment_id)).toEqual(["1", "3", "2"])
  })
  it("freeMainSlots lists the empty slots in order", () => {
    expect(freeMainSlots([2, 5])).toEqual([1, 3, 4, 6])
  })
  it("the confirm text lists each pick and any slots left", () => {
    const t = mainFillConfirmCopy([{ slot: 1, player_name: "LeBron James", set_name: "S1 Base", serial_number: 12, fmv: 4.5 }], 5)
    expect(t).toContain("Slot 1: LeBron James · S1 Base #12 · ~$4.50")
    expect(t).toContain("That leaves 5 slots empty")
  })
})
