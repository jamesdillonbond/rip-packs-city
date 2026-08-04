import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for GET /api/badges (badge_editions browser).
// Mock @supabase/supabase-js with a chainable, thenable builder. The count +
// data queries and the trailing last-sync query all resolve through it. Pin the
// empty happy path (200 with editions=[] + meta) and the data-query error → 500.

const state: { error: any } = { error: null }

vi.mock("@supabase/supabase-js", () => {
  const b: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: any) =>
            resolve({ data: state.error ? null : [], count: 0, error: state.error })
        }
        return () => b
      },
    }
  )
  return { createClient: () => ({ from: () => b }) }
})

import { GET } from "@/app/api/badges/route"

const req = (qs = "") => new NextRequest("https://t/api/badges" + qs)

beforeEach(() => {
  state.error = null
})

describe("GET /api/badges", () => {
  it("returns an empty editions list + meta", async () => {
    const res = await GET(req("?mode=all"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.editions).toEqual([])
    expect(body.meta.total).toBe(0)
    expect(body.meta.mode).toBe("all")
  })

  it("500s when the data query errors", async () => {
    // The route throws dataResult.error; an Error instance surfaces its message.
    state.error = new Error("db down")
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })

  it("guards NaN limit/offset (defaults instead of a NaN range → 500)", async () => {
    // ?limit=abc → parseInt NaN; without the guard meta.limit serialized as null
    // and .range(0, NaN) 400s the query → route 500s. Guarded: fall back to 48/0.
    const res = await GET(req("?limit=abc&offset=xyz"))
    expect(res.status).toBe(200)
    const meta = (await res.json()).meta
    expect(meta.limit).toBe(48)
    expect(meta.offset).toBe(0)
  })

  it("caps limit at 500 and passes a valid limit through", async () => {
    expect((await (await GET(req("?limit=99999"))).json()).meta.limit).toBe(500)
    expect((await (await GET(req("?limit=50"))).json()).meta.limit).toBe(50)
  })
})
