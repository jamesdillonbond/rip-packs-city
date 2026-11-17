import { describe, it, expect, vi, afterEach } from "vitest"
import { fetchJson } from "@/lib/analytics/fetch-json"

// The discriminator every /analytics client dashboard now branches on. Its whole
// job is to keep four outcomes apart that the old
// `fetch(u).then(r => r.ok ? r.json() : null).catch(() => {})` idiom collapsed
// into one indistinguishable null.

afterEach(() => vi.unstubAllGlobals())

function stubFetch(impl: (url: string) => unknown) {
  vi.stubGlobal("fetch", vi.fn(async (u: string) => impl(u) as never))
}

describe("ok is true only for a 2xx carrying parseable JSON", () => {
  it("returns the parsed body on a 200", async () => {
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ rows: [1, 2] }) }))
    expect(await fetchJson<{ rows: number[] }>("/x")).toEqual({ ok: true, json: { rows: [1, 2] } })
  })

  it("reports a 500 as NOT ok and never surfaces its body", async () => {
    // A 5xx here usually carries an error envelope. Parsing it would put an
    // { error } object where the caller expects rows — and, before the
    // lib/insights/board-error.ts sweep, Postgres's own driver text with it.
    const json = vi.fn(async () => ({ error: "canceling statement due to statement timeout" }))
    stubFetch(() => ({ ok: false, status: 500, json }))
    expect(await fetchJson("/x")).toEqual({ ok: false, json: null })
    expect(json, "the body of a failed response must not be parsed").not.toHaveBeenCalled()
  })

  it("reports a 401/404 as NOT ok", async () => {
    for (const status of [401, 403, 404, 429]) {
      stubFetch(() => ({ ok: false, status, json: async () => ({}) }))
      expect((await fetchJson("/x")).ok, `status ${status}`).toBe(false)
    }
  })

  it("reports a thrown fetch as NOT ok rather than rejecting", async () => {
    // Callers live inside useEffect chains; a rejection would be swallowed and
    // the dashboard would silently keep its fabricated empty state.
    stubFetch(() => {
      throw new TypeError("Failed to fetch")
    })
    await expect(fetchJson("/x")).resolves.toEqual({ ok: false, json: null })
  })

  it("reports a 200 whose body is NOT JSON as NOT ok", async () => {
    // Real on this site: proxy.ts answers an unauthenticated request with login
    // HTML at status 200, so `r.ok` alone is not enough to trust the body.
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token '<'")
      },
    }))
    expect(await fetchJson("/x")).toEqual({ ok: false, json: null })
  })
})

describe("ok, not the payload, is the discriminator", () => {
  it("a successful literal null body is ok:true with json:null", async () => {
    // The trap this module exists to remove: a caller that branches on
    // `json == null` treats this successful response exactly like a network
    // failure, which is the original conflation wearing a new shape.
    stubFetch(() => ({ ok: true, status: 200, json: async () => null }))
    expect(await fetchJson("/x")).toEqual({ ok: true, json: null })
  })

  it("a successful EMPTY row set is ok:true — that is a real answer", async () => {
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ rows: [] }) }))
    const res = await fetchJson<{ rows: unknown[] }>("/x")
    expect(res.ok).toBe(true)
    expect(res.json?.rows).toEqual([])
  })
})

describe("plumbing", () => {
  it("passes the url and init through untouched", async () => {
    const spy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as never)
    vi.stubGlobal("fetch", spy)
    const init = { headers: { "x-t": "1" } }
    await fetchJson("/api/analytics/packs/summary?collections=topshot", init)
    expect(spy).toHaveBeenCalledWith("/api/analytics/packs/summary?collections=topshot", init)
  })
})
