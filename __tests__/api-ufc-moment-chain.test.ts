// GET /api/ufc/moment-chain — where ONE UFC Strike Moment lives (2026-11-26).
// Aptos when the indexer holds that edition+serial; Flow only when the edition IS mapped to Aptos and the
// serial is absent there; null when unmapped (never a guess); a failed read is a 5xx; no owner address.
import { beforeEach, describe, expect, it, vi } from "vitest"

const db = { colls: [] as Array<{ aptos_collection_id: string }>, error: null as unknown }
function thenable(v: () => unknown) {
  const b: Record<string, unknown> = {}
  for (const m of ["select", "eq", "order"]) b[m] = () => b
  b.then = (ok: (x: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(v()).then(ok, bad)
  return b
}
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => thenable(() => (db.error ? { data: null, error: db.error } : { data: db.colls, error: null })) },
}))
const { GET } = await import("@/app/api/ufc/moment-chain/route")
const req = (q: string) => ({ nextUrl: new URL("https://t/api/ufc/moment-chain" + q) }) as never
const ED = "e0000000-0000-0000-0000-000000000001"
const ok = (rows: unknown[]) => ({ ok: true, json: async () => ({ data: { current_token_ownerships_v2: rows } }) })
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  db.colls = [{ aptos_collection_id: "0xabc" }]
  db.error = null
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

describe("GET /api/ufc/moment-chain", () => {
  it("400s without a uuid edition and a positive serial", async () => {
    expect((await GET(req("?edition=x&serial=1"))).status).toBe(400)
    expect((await GET(req(`?edition=${ED}&serial=0`))).status).toBe(400)
  })

  it("a serial minted on Aptos is Aptos — with links, and never the owner's address", async () => {
    fetchMock.mockResolvedValueOnce(ok([{ owner_address: "0x" + "c".repeat(64), token_data_id: "0xtok", current_token_data: { collection_id: "0xabc" } }]))
    const body = await (await GET(req(`?edition=${ED}&serial=733`))).json()
    expect(body.chain).toBe("aptos")
    expect(body.rarible_url).toBe("https://rarible.com/collection/aptos/0xabc/items")
    expect(body.explorer_url).toContain("/token/0xtok")
    expect(body.held_by_ufc).toBeNull()
    expect(JSON.stringify(body)).not.toContain("c".repeat(64))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).variables.p).toEqual({ "Serial Number": "733" })
  })

  it("names UFC's own store wallet as the holder (it is buyable from UFC)", async () => {
    fetchMock.mockResolvedValueOnce(ok([{ owner_address: "0x8a94446716e60160571b930bd1097b31c7788decbe4d375802bebfc79d928e7f", token_data_id: "0xtok" }]))
    expect((await (await GET(req(`?edition=${ED}&serial=1`))).json()).held_by_ufc).toBe("UFC Strike store")
  })

  it("a mapped edition whose serial is not on Aptos is Flow", async () => {
    fetchMock.mockResolvedValueOnce(ok([]))
    expect((await (await GET(req(`?edition=${ED}&serial=2`))).json()).chain).toBe("flow")
  })

  it("an edition with no Aptos collection is unknown (null), never Flow — and the indexer is not asked", async () => {
    db.colls = []
    expect((await (await GET(req(`?edition=${ED}&serial=2`))).json()).chain).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("a failed indexer read is a 5xx, never a chain", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
    const res = await GET(req(`?edition=${ED}&serial=2`))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(await res.json()).not.toHaveProperty("chain")
  })
})
