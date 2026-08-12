import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/set-completers. No params/guards
// — delegates the whole read to fetchSetCompletersBoard from
// lib/set-completers-board. Keep the real METHOD_NOTE (importOriginal) and stub
// only the fetch fn, pinning the happy path and the fetch-error → 500.

const fetchState: { board: any; err: any } = { board: { rows: [] }, err: null }

vi.mock("@/lib/set-completers-board", async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    fetchSetCompletersBoard: async () => {
      if (fetchState.err) throw fetchState.err
      return fetchState.board
    },
  }
})

import { GET } from "@/app/api/public/insights/set-completers/route"

const req = () => ({ url: "https://t/api/public/insights/set-completers" }) as any

beforeEach(() => {
  fetchState.board = { rows: [] }
  fetchState.err = null
})

describe("GET /api/public/insights/set-completers", () => {
  it("is a function handler", () => {
    expect(typeof GET).toBe("function")
  })

  it("returns the board rows + method note on the happy path", async () => {
    fetchState.board = { rows: [{ set_id: "s1", completers: 12 }] }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.source).toBe("topshot_set_completers_mv")
    expect(typeof body.meta.method_note).toBe("string")
    expect(body.rows).toHaveLength(1)
  })

  it("returns the empty-board shape when there are no sets", async () => {
    fetchState.board = { rows: [] }
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).rows).toEqual([])
  })

  it("500s when the fetch throws", async () => {
    fetchState.err = new Error("mv missing")
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    // The driver's own text must never reach an anon caller (deep-audit D3):
    // these are PUBLIC routes, so a Postgres message here is a leak.
    expect(body.error).not.toContain("mv missing")
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
  })

  it("500s and String()-coerces a non-Error throw", async () => {
    fetchState.err = "raw completers failure"
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    // The driver's own text must never reach an anon caller (deep-audit D3):
    // these are PUBLIC routes, so a Postgres message here is a leak.
    expect(body.error).not.toContain("raw completers failure")
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
  })
})
