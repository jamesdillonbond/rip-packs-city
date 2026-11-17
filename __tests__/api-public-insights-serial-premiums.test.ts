import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/serial-premiums. The route does
// its own tier guard, then delegates the DB read to fetchSerialPremiums from
// lib/serial-premiums-board. We keep the real parsers/BOARDS (importOriginal) and
// only stub the fetch fn — pinning the 400 tier guard, the happy path, and the
// fetch-error → 500.

const fetchState: { rows: any[]; err: any } = { rows: [], err: null }

vi.mock("@/lib/serial-premiums-board", async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    fetchSerialPremiums: async () => {
      if (fetchState.err) throw fetchState.err
      return fetchState.rows
    },
  }
})

const mvState: { asOf: string | null; calls: string[] } = { asOf: null, calls: [] }
vi.mock("@/lib/insights/mv-freshness", () => ({
  readMvAsOf: async (board: string) => { mvState.calls.push(board); return mvState.asOf },
}))

import { GET } from "@/app/api/public/insights/serial-premiums/route"

const req = (url: string) => ({ url, nextUrl: new URL(url) }) as any
const BASE = "https://t/api/public/insights/serial-premiums"

beforeEach(() => {
  fetchState.rows = []
  fetchState.err = null
})

describe("GET /api/public/insights/serial-premiums", () => {
  it("400s on an invalid tier", async () => {
    const res = await GET(req(`${BASE}?tier=BOGUS`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("tier must be one of")
  })

  it("returns rows with meta on the happy path", async () => {
    fetchState.rows = [{ headline_serial: 1, premium_multiple: 1200 }]
    const res = await GET(req(`${BASE}?headline=no1&window=30d`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.headline).toBe("no1")
    expect(body.meta.total_rows).toBe(1)
    expect(body.rows).toHaveLength(1)
  })

  it("500s when the fetch throws", async () => {
    fetchState.err = new Error("board down")
    const res = await GET(req(BASE))
    expect(res.status).toBe(500)
    const body = await res.json()
    // The driver's own text must never reach an anon caller (deep-audit D3):
    // these are PUBLIC routes, so a Postgres message here is a leak.
    expect(body.error).not.toContain("board down")
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
  })
})

// 2026-11-14 (fresh-eyes review of /insights): Top Shot's perfect-mint board reads an MV refreshed
// every 2 h; its "Updated" stamp was the request time, so a dead refresh read "Updated just now".
describe("GET /api/public/insights/serial-premiums — data_as_of dates the ROWS", () => {
  beforeEach(() => { mvState.asOf = null; mvState.calls = [] })

  it("the perfect-mint board carries the MV's last refresh, never the request time", async () => {
    mvState.asOf = "2026-11-13T08:00:00.000Z"
    const body = await (await GET(req(`${BASE}?headline=perfect`))).json()
    expect(mvState.calls).toEqual(["perfect-mint-premiums"])
    expect(body.meta.data_as_of).toBe("2026-11-13T08:00:00.000Z")
    expect(body.meta.data_as_of).not.toBe(body.meta.fetched_at)
  })

  it("an undatable refresh is null (unknown), not now", async () => {
    mvState.asOf = null
    const body = await (await GET(req(`${BASE}?headline=perfect`))).json()
    expect(body.meta.data_as_of).toBeNull()
  })

  it("a live board's rows are as fresh as the read, and no MV lookup is made", async () => {
    const body = await (await GET(req(`${BASE}?headline=no1`))).json()
    expect(mvState.calls).toEqual([])
    expect(body.meta.data_as_of).toBe(body.meta.fetched_at)
  })
})
