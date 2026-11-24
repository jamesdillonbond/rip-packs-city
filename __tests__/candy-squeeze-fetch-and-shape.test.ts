import { describe, it, expect, vi } from "vitest"

// The server-only supabase client is never touched here: every case passes its own db.
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {}, supabase: {} }))

import { fetchCandySqueeze, shapeCandySqueeze, EMPTY_CANDY_SQUEEZE, CANDY_SET_ID_RE } from "@/lib/insights/candy-parity-boards"

// Pins lib/insights/candy-parity-boards.ts's Candy Squeeze read (Candy parity passes 1–3, 2026-11-23):
//   * the per-set picker (`sets`) is shaped field by field; `registry` is true ONLY for a literal true;
//   * an unknown number stays NULL — an unknown ask is never $0, an unknown listed share never 0 %;
//   * a malformed set id never reaches the database, and a failed RPC THROWS (never an empty board).
// Added 2026-11-23 ~8:50 PM PT: the set picker and fetch guards shipped untested, and with the evening's
// other new boards the unit coverage merge sat at 91.79 vs its 91.8 floor (CI run 45328379635).

const SET = "4f7e9c2a-1b3d-4e5f-8a9b-0c1d2e3f4a5b"

function fakeDb(answer: { data: unknown; error: unknown }) {
  const calls: Array<{ fn: string; args: unknown }> = []
  return {
    calls,
    db: { rpc: vi.fn(async (fn: string, args: unknown) => { calls.push({ fn, args }); return answer }) },
  }
}

describe("shapeCandySqueeze — the set picker and null-preservation", () => {
  it("shapes every set field; registry is true only for a literal true", () => {
    const out = shapeCandySqueeze({
      set_id: SET,
      rows: [],
      sets: [
        { set_id: SET, set_name: "2026 MLB ICONs", registry: true, ranked: "12", zero_listed: 3, asks: "41" },
        { set_id: "x", set_name: "Legacy", registry: "true", ranked: null },
        {},
      ],
    })
    expect(out.set_id).toBe(SET)
    expect(out.sets[0]).toEqual({ set_id: SET, set_name: "2026 MLB ICONs", registry: true, ranked: 12, zero_listed: 3, asks: 41 })
    // A string "true" is not a registry claim.
    expect(out.sets[1].registry).toBe(false)
    expect(out.sets[2]).toEqual({ set_id: "", set_name: "", registry: false, ranked: 0, zero_listed: 0, asks: 0 })
  })

  it("an absent `sets` is an empty picker, not a throw", () => {
    expect(shapeCandySqueeze({ rows: [] }).sets).toEqual([])
  })

  it("keeps an unknown ask / share / FMV / burn NULL — never $0 or 0 %", () => {
    const [row] = shapeCandySqueeze({
      rows: [{ external_id: "e1", minted: "250", burned: null, pct_listed: null, floor_ask_usd: null, fmv_usd: null }],
    }).rows
    expect(row.minted).toBe(250)
    expect(row.burned).toBeNull()
    expect(row.pct_listed).toBeNull()
    expect(row.floor_ask_usd).toBeNull()
    expect(row.fmv_usd).toBeNull()
    // Counts the census does produce default to 0 only when absent.
    expect(row.listed).toBe(0)
    expect(row.sales_30d).toBe(0)
    expect(row.player_name).toBeNull()
  })

  it("the degraded payload carries no measurement", () => {
    expect(EMPTY_CANDY_SQUEEZE.rows).toEqual([])
    expect(EMPTY_CANDY_SQUEEZE.listings_seen_at).toBeNull()
    expect(EMPTY_CANDY_SQUEEZE.editions_ranked).toBe(0)
  })
})

describe("fetchCandySqueeze — guards before and after the read", () => {
  it("refuses a malformed set id WITHOUT calling the database", async () => {
    const { db, calls } = fakeDb({ data: { rows: [] }, error: null })
    await expect(fetchCandySqueeze(db, { setId: "1; drop table sales" })).rejects.toThrow(/malformed set id/)
    await expect(fetchCandySqueeze(db, { setId: SET.toUpperCase() })).rejects.toThrow(/malformed set id/)
    expect(calls).toEqual([])
    expect(CANDY_SET_ID_RE.test(SET)).toBe(true)
  })

  it("passes the set and the defaults to the RPC", async () => {
    const { db, calls } = fakeDb({ data: { rows: [] }, error: null })
    await fetchCandySqueeze(db, { setId: SET })
    await fetchCandySqueeze(db)
    expect(calls).toEqual([
      { fn: "get_candy_listed_squeeze", args: { p_min_held: 25, p_limit: 300, p_set: SET } },
      { fn: "get_candy_listed_squeeze", args: { p_min_held: 25, p_limit: 300, p_set: null } },
    ])
  })

  it("a failed RPC THROWS — it never shapes into an empty board", async () => {
    const { db } = fakeDb({ data: null, error: { message: "canceling statement due to statement timeout" } })
    await expect(fetchCandySqueeze(db)).rejects.toThrow(/statement timeout/)
    const { db: db2 } = fakeDb({ data: null, error: {} })
    await expect(fetchCandySqueeze(db2)).rejects.toThrow(/get_candy_listed_squeeze failed/)
  })

  it("a body that is not the function's shape is a failure too", async () => {
    const { db } = fakeDb({ data: { nope: 1 }, error: null })
    await expect(fetchCandySqueeze(db)).rejects.toThrow(/unexpected payload/)
  })
})
