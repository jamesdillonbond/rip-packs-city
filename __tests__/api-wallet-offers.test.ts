import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// GET /api/wallet-offers — the offers a wallet has made (Top Shot only).
// Contracts pinned:
//   - a collection without offer tracking answers supported:false and reads
//     NOTHING (never an empty list a card would render as "no offers");
//   - a failed status count is an ERROR response, never a measured 0;
//   - the happy path scopes every read by collection + offerer and returns
//     joined edition names with status totals.

const state = vi.hoisted(() => ({
  reads: [] as Array<{ table: string; filters: Array<[string, unknown[]]>; head: boolean }>,
  failCount: null as string | null,
}))

function builder(table: string) {
  const rec = { table, filters: [] as Array<[string, unknown[]]>, head: false }
  state.reads.push(rec)
  const resolve = () => {
    if (rec.head) {
      const status = rec.filters.find(([m, a]) => m === "eq" && a[0] === "status")?.[1][1] as string
      if (state.failCount === status) return { data: null, error: { message: "boom" }, count: null }
      return { data: null, error: null, count: { open: 2, filled: 5, cancelled: 9 }[status] ?? 0 }
    }
    return {
      data: [
        {
          offer_type: "edition",
          offer_amount_usd: "4.00",
          status: "filled",
          created_at: "2026-09-20T02:00:00Z",
          resolved_at: "2026-09-20T02:05:00Z",
          serial_number: null,
          editions: { player_name: "Damian Lillard", set_name: "Base Set", tier: "COMMON", external_id: "8:133" },
        },
      ],
      error: null,
    }
  }
  const b: Record<string, unknown> = {}
  b.select = (_c: string, opts?: { head?: boolean }) => { if (opts?.head) rec.head = true; return b }
  for (const m of ["eq", "order", "limit", "in"]) b[m] = (...a: unknown[]) => { rec.filters.push([m, a]); return b }
  b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(resolve()).then(ok, bad)
  return b
}

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (t: string) => builder(t) } }))

const { GET } = await import("@/app/api/wallet-offers/route")

const W = "0xbd94cade097e50ac"
const req = (qs: string) => new NextRequest(`https://t/api/wallet-offers?${qs}`)

beforeEach(() => {
  state.reads = []
  state.failCount = null
})

describe("GET /api/wallet-offers", () => {
  it("a collection without offer tracking answers supported:false and reads nothing", async () => {
    const res = await GET(req(`wallet=${W}&collection=nfl-all-day`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ supported: false, rows: [], summary: null })
    expect(state.reads).toHaveLength(0)
  })

  it("a failed status count is an error, never a measured zero", async () => {
    state.failCount = "open"
    const res = await GET(req(`wallet=${W}&collection=nba-top-shot`))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.summary).toBeUndefined()
  })

  it("returns the wallet's offers scoped by collection + offerer, with totals", async () => {
    const res = await GET(req(`wallet=${W.toUpperCase().replace("0X", "0x")}&collection=nba-top-shot`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      supported: true,
      wallet: W,
      summary: { total: 16, open: 2, filled: 5, cancelled: 9 },
    })
    expect(body.rows[0]).toMatchObject({ player_name: "Damian Lillard", amount_usd: 4, status: "filled", offer_type: "edition" })
    expect(state.reads).toHaveLength(4)
    for (const r of state.reads) {
      expect(r.table).toBe("offers")
      expect(r.filters).toContainEqual(["eq", ["collection_id", "95f28a17-224a-4025-96ad-adf8a4c63bfd"]])
      expect(r.filters).toContainEqual(["eq", ["buyer_address", W]])
    }
  })

  it("requires a wallet and a known collection", async () => {
    expect((await GET(req(`collection=nba-top-shot`))).status).toBe(400)
    expect((await GET(req(`wallet=${W}&collection=nope`))).status).toBe(400)
  })
})
