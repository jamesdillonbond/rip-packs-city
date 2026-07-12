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
    expect((await res.json()).error).toBe("board down")
  })
})
