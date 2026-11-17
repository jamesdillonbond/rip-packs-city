import { describe, it, expect, beforeEach, vi } from "vitest"

// lib/entity-detail-gate.ts is the existence gate the five SEO entity segment
// layouts (edition / set / player / team / series) call to turn an unknown slug
// into a REAL 404 instead of a soft-404 (HTTP 200 + not-found body), which the
// segments' loading.tsx made unavoidable from the page itself.
//
// The two properties that make it safe to 404 from a layout are what this pins:
//   1. STRICT SUBSET — it calls the same get_<entity>_detail RPC, with the same
//      args, that the page itself 404s on. It cannot invent a 404.
//   2. FAILS OPEN — any RPC error or thrown exception resolves to "exists", so a
//      transient pool blip can never deindex a real page.

const calls = vi.hoisted(() => ({ log: [] as Array<{ fn: string; args: Record<string, unknown> }> }))
const st = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as { message: string; code?: string } | null },
  throwOnCall: false,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.log.push({ fn, args })
      if (st.throwOnCall) throw new Error("socket hang up")
      return st.result
    },
  },
}))

const { entityResolves, fetchEntityDetailRaw, firstEntityRow, decodeSlugOrNull } = await import(
  "@/lib/entity-detail-gate"
)

beforeEach(() => {
  calls.log = []
  st.result = { data: null, error: null }
  st.throwOnCall = false
})

describe("entity-detail-gate: strict-subset resolver wiring", () => {
  it.each([
    ["edition", "get_edition_detail", "p_route_slug"],
    ["set", "get_set_detail", "p_set_slug"],
    ["player", "get_player_detail", "p_player_slug"],
    ["team", "get_team_detail", "p_team_slug"],
    ["series", "get_series_detail", "p_series_slug"],
  ] as const)("%s gates on %s(%s) — the same RPC the page 404s on", async (kind, fn, slugArg) => {
    st.result = { data: [{ id: "x" }], error: null }
    await fetchEntityDetailRaw(kind, "coll-uuid", "some-slug")
    const last = calls.log.at(-1)!
    expect(last.fn).toBe(fn)
    expect(last.args.p_collection_id).toBe("coll-uuid")
    expect(last.args[slugArg]).toBe("some-slug")
  })
})

describe("entityResolves", () => {
  it("resolves TRUE for a one-row array (the page would render)", async () => {
    st.result = { data: [{ set_slug: "base-set" }], error: null }
    expect(await entityResolves("set", "c1", "base-set")).toBe(true)
  })

  it("resolves TRUE for a bare jsonb object", async () => {
    st.result = { data: { team_slug: "lakers" }, error: null }
    expect(await entityResolves("team", "c1", "lakers")).toBe(true)
  })

  it("resolves FALSE for a clean empty result (the page would notFound)", async () => {
    st.result = { data: [], error: null }
    expect(await entityResolves("player", "c1", "nobody-at-all")).toBe(false)
  })

  it("resolves FALSE for a clean null result", async () => {
    st.result = { data: null, error: null }
    expect(await entityResolves("series", "c1", "series-999")).toBe(false)
  })

  it("resolves FALSE for a one-element array holding null", async () => {
    st.result = { data: [null], error: null }
    expect(await entityResolves("edition", "c1", "99:99")).toBe(false)
  })

  // ── FAIL OPEN ─────────────────────────────────────────────────────────────
  // These are the cases that must NEVER 404. A 404 emitted because a query
  // failed invites Google to drop a real, indexed page.
  it("FAILS OPEN on an RPC error — never 404s because a query failed", async () => {
    // 42883 = undefined_function: a non-transient class, so rpcWithRetry does
    // not burn its backoff budget before surfacing.
    st.result = { data: null, error: { message: "boom", code: "42883" } }
    expect(await entityResolves("edition", "c1", "1:2")).toBe(true)
  })

  it("FAILS OPEN when the client throws", async () => {
    st.throwOnCall = true
    expect(await entityResolves("set", "c1", "base-set")).toBe(true)
  })
})

describe("firstEntityRow", () => {
  it("unwraps arrays, passes objects, and nulls empties", () => {
    expect(firstEntityRow<{ a: number }>([{ a: 1 }])).toEqual({ a: 1 })
    expect(firstEntityRow<{ a: number }>({ a: 2 })).toEqual({ a: 2 })
    expect(firstEntityRow([])).toBeNull()
    expect(firstEntityRow(null)).toBeNull()
    expect(firstEntityRow(undefined)).toBeNull()
  })
})

describe("decodeSlugOrNull", () => {
  it("decodes a percent-escaped slug the way the pages do", () => {
    expect(decodeSlugOrNull("Walt%20Disney")).toBe("Walt Disney")
    expect(decodeSlugOrNull("26:504")).toBe("26:504")
  })

  it("returns null on a malformed escape so the layout can fail open", () => {
    // decodeURIComponent throws URIError here; the layout must not 404 on a key
    // it cannot reproduce.
    expect(decodeSlugOrNull("%")).toBeNull()
    expect(decodeSlugOrNull("%E0%A4%A")).toBeNull()
  })
})
