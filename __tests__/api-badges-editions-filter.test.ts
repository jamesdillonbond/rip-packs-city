import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// GET /api/badges?editions=… — the wallet binder's edition-keyed badge lookup
// (2026-10-17). It replaced a player-name lookup that paged every edition of
// the page's players (3 serial ~1.4 s requests before a 15K wallet's first row)
// and dropped badges whenever badge_editions spelled the player differently
// (1.1 % of one wallet: Şengün vs Sengun, Diggins-Smith, Butler III).
//
// The route is PUBLIC, so the filter must (a) be an exact `.in("external_id")`
// on the unique key, (b) keep only well-formed keys, and (c) match NOTHING —
// never an unfiltered page — when every supplied key is junk.

const calls: Array<[string, unknown[]]> = []

vi.mock("@supabase/supabase-js", () => {
  const b: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: any) => resolve({ data: [], count: 0, error: null })
        }
        return (...args: unknown[]) => {
          calls.push([String(prop), args])
          return b
        }
      },
    },
  )
  return { createClient: () => ({ from: () => b }) }
})

import { GET } from "@/app/api/badges/route"

const req = (qs: string) => new NextRequest("https://t/api/badges" + qs)
const inCalls = () => calls.filter(([m]) => m === "in")

beforeEach(() => {
  calls.length = 0
})

describe("GET /api/badges ?editions=", () => {
  it("filters both the count and data queries by exact external_id", async () => {
    const res = await GET(req("?mode=all&editions=48:1652,233:8332::19,1307"))
    expect(res.status).toBe(200)
    const ins = inCalls()
    expect(ins).toHaveLength(2)
    for (const [, args] of ins) {
      expect(args[0]).toBe("external_id")
      expect(args[1]).toEqual(["48:1652", "233:8332::19", "1307"])
    }
  })

  it("drops malformed keys (filter-grammar characters, spaces) and de-duplicates", async () => {
    await GET(req("?editions=" + encodeURIComponent("48:1652,48:1652,a),b(,x y,ok-1")))
    expect(inCalls()[0][1][1]).toEqual(["48:1652", "ok-1"])
  })

  it("an all-junk list matches nothing instead of falling through unfiltered", async () => {
    await GET(req("?editions=" + encodeURIComponent("),(,%%")))
    const ins = inCalls()
    expect(ins).toHaveLength(2)
    expect(ins[0][1][1]).toEqual(["__none__"])
  })

  it("adds no external_id filter when the param is absent", async () => {
    await GET(req("?mode=all"))
    expect(inCalls()).toHaveLength(0)
  })
})
