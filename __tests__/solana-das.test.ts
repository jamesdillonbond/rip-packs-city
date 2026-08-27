import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// lib/chains/solana/das.ts — Solana DAS (Digital Asset Standard) JSON-RPC reads
// through the helius-proxy worker. Mocks global fetch and re-imports the module
// per env config (module-level HELIUS_PROXY_URL/SECRET). Pins: the not-configured
// throw, JSON-RPC request encoding + X-Proxy-Secret header, the getAsset*/group/
// owner param shapes, the !ok and JSON-RPC-error throws, paginateGroup/Owner
// short-page + empty-page stop conditions, and the per-UTC-day solUsd cache.

const fetchMock = vi.fn()

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}

// Fresh import so the module-level proxy consts capture the env under test.
async function load(opts: { url?: string; secret?: string } = { url: "https://helius.example/rpc", secret: "helius-secret" }) {
  vi.resetModules()
  if (opts.url === undefined) delete process.env.HELIUS_PROXY_URL
  else process.env.HELIUS_PROXY_URL = opts.url
  if (opts.secret === undefined) delete process.env.HELIUS_PROXY_SECRET
  else process.env.HELIUS_PROXY_SECRET = opts.secret
  return await import("@/lib/chains/solana/das")
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("dasCall configuration guard", () => {
  it("throws when the proxy url is missing (no fetch)", async () => {
    const das = await load({ url: undefined, secret: "s" })
    await expect(das.dasCall("getAsset", {})).rejects.toThrow(/helius-proxy not configured/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("throws when the proxy secret is missing (no fetch)", async () => {
    const das = await load({ url: "https://helius.example/rpc", secret: undefined })
    await expect(das.dasCall("getAsset", {})).rejects.toThrow(/helius-proxy not configured/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("dasCall request/response", () => {
  it("POSTs a JSON-RPC envelope with the proxy secret header and returns result", async () => {
    const das = await load()
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: { hello: "world" } }))
    const out = await das.dasCall<{ hello: string }>("getAsset", { id: "mint1" })
    expect(out).toEqual({ hello: "world" })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://helius.example/rpc")
    expect(init.method).toBe("POST")
    const headers = init.headers as Record<string, string>
    expect(headers["Content-Type"]).toBe("application/json")
    expect(headers["X-Proxy-Secret"]).toBe("helius-secret")
    const payload = JSON.parse(init.body as string)
    expect(payload).toEqual({ jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: "mint1" } })
  })

  it("bounds the request with an abort signal — an unbounded DAS call eats the caller's whole lambda", async () => {
    // 🚨 WHY. `fetch()` has NO default timeout. Every caller of this helper is a
    // candy ingest route running inside `after()` with a `maxDuration`, and a
    // lambda killed at that ceiling runs neither the success path nor the catch
    // — so NO terminal pipeline_runs row is written and the outage is invisible,
    // reading as "the cron never fired". Measured on the sibling
    // /api/candy-listings-indexer 2026-08-27: 15 heartbeats, ONE terminal row in
    // 48h, and a PUBLIC board 44 hours stale.
    //
    // `candy-sales-indexer` budgets 400 asset fetches per tick, so unbounded a
    // single stuck call could consume all 300s by itself.
    //
    // ⚠ Asserted on the REQUEST INIT, not on the source text — a source grep
    // would be satisfied by the comment you are reading.
    const das = await load()
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: {} }))
    await das.dasCall("getAsset", { id: "mint1" })

    const [, init] = fetchMock.mock.calls[0]
    expect(init.signal, "dasCall must pass an AbortSignal").toBeDefined()
    expect(typeof (init.signal as AbortSignal).aborted).toBe("boolean")
  })

  it("throws with status + body on a non-2xx proxy response", async () => {
    const das = await load()
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, text: async () => "worker down" })
    await expect(das.dasCall("getAsset", {})).rejects.toThrow("DAS getAsset HTTP 503: worker down")
  })

  it("tolerates a text() rejection on the error path", async () => {
    const das = await load()
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => { throw new Error("no body") } })
    await expect(das.dasCall("getAsset", {})).rejects.toThrow("DAS getAsset HTTP 500:")
  })

  it("throws when the JSON-RPC response carries an error object", async () => {
    const das = await load()
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, error: { message: "invalid param" } }))
    await expect(das.dasCall("getAsset", {})).rejects.toThrow("DAS getAsset error: invalid param")
  })

  it("uses an 'unknown' message when the JSON-RPC error has none", async () => {
    const das = await load()
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, error: {} }))
    await expect(das.dasCall("getAsset", {})).rejects.toThrow("DAS getAsset error: unknown")
  })
})

describe("typed DAS reads pass the right params", () => {
  it("getAssetsByGroup keys on collection groupKey/groupValue", async () => {
    const das = await load()
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: { total: 0, limit: 1000, page: 2, items: [] } }))
    await das.getAssetsByGroup("collAddr", 2, 500)
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(payload.method).toBe("getAssetsByGroup")
    expect(payload.params).toEqual({ groupKey: "collection", groupValue: "collAddr", page: 2, limit: 500 })
  })

  it("getAssetsByGroup defaults page=1 limit=1000", async () => {
    const das = await load()
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: { items: [] } }))
    await das.getAssetsByGroup("collAddr")
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(payload.params).toEqual({ groupKey: "collection", groupValue: "collAddr", page: 1, limit: 1000 })
  })

  it("getAssetsByOwner keys on ownerAddress", async () => {
    const das = await load()
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: { items: [] } }))
    await das.getAssetsByOwner("ownerX", 3, 250)
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(payload.method).toBe("getAssetsByOwner")
    expect(payload.params).toEqual({ ownerAddress: "ownerX", page: 3, limit: 250 })
  })

  it("getAsset keys on id and returns the asset", async () => {
    const das = await load()
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: { id: "mintZ" } }))
    const a = await das.getAsset("mintZ")
    expect(a).toEqual({ id: "mintZ" })
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(payload.method).toBe("getAsset")
    expect(payload.params).toEqual({ id: "mintZ" })
  })
})

describe("paginateGroup / paginateOwner", () => {
  const item = (id: string) => ({ id })
  const full = () => Array.from({ length: 1000 }, (_, i) => item(`a${i}`))

  it("stops after a short first page and returns the count", async () => {
    const das = await load()
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: { items: [item("x"), item("y")] } }))
    const seen: number[] = []
    const total = await das.paginateGroup("coll", (items, page) => { seen.push(page); expect(items.length).toBe(2) })
    expect(total).toBe(2)
    expect(seen).toEqual([1])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("walks a full page then stops on the next short page (seen accumulates)", async () => {
    const das = await load()
    fetchMock
      .mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: { items: full() } }))
      .mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: { items: [item("last")] } }))
    const pages: number[] = []
    const total = await das.paginateGroup("coll", (_items, page) => { pages.push(page) })
    expect(total).toBe(1001)
    expect(pages).toEqual([1, 2])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("stops immediately (and never calls onPage) when the first page is empty", async () => {
    const das = await load()
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: { items: [] } }))
    const onPage = vi.fn()
    const total = await das.paginateGroup("coll", onPage)
    expect(total).toBe(0)
    expect(onPage).not.toHaveBeenCalled()
  })

  it("paginateOwner mirrors the short-page stop", async () => {
    const das = await load()
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: { items: [item("o")] } }))
    const total = await das.paginateOwner("owner", () => {})
    expect(total).toBe(1)
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(payload.method).toBe("getAssetsByOwner")
  })

  it("paginateOwner walks a full page then stops on the next short page", async () => {
    const das = await load()
    fetchMock
      .mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: { items: full() } }))
      .mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: { items: [item("tail")] } }))
    const pages: number[] = []
    const total = await das.paginateOwner("owner", (_items, page) => { pages.push(page) })
    expect(total).toBe(1001)
    expect(pages).toEqual([1, 2])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("treats a missing items array as an empty page", async () => {
    const das = await load()
    fetchMock.mockResolvedValueOnce(okJson({ jsonrpc: "2.0", id: 1, result: {} }))
    const total = await das.paginateGroup("coll", () => { throw new Error("should not run") })
    expect(total).toBe(0)
  })
})

describe("solUsd (per-UTC-day cache)", () => {
  it("returns null on a non-ok response with no prior cache", async () => {
    const das = await load()
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })
    expect(await das.solUsd()).toBeNull()
  })

  it("returns null when the payload rate is missing / non-positive", async () => {
    const das = await load()
    fetchMock.mockResolvedValueOnce(okJson({ solana: { usd: 0 } }))
    expect(await das.solUsd()).toBeNull()
  })

  it("fetches once, caches the rate for the day, and serves the cache on the next call", async () => {
    const das = await load()
    fetchMock.mockResolvedValueOnce(okJson({ solana: { usd: 152.5 } }))
    expect(await das.solUsd()).toBe(152.5)
    // second call: cache hit, no new fetch
    expect(await das.solUsd()).toBe(152.5)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("returns null when the fetch throws and there is no cache", async () => {
    const das = await load()
    fetchMock.mockRejectedValueOnce(new Error("network"))
    expect(await das.solUsd()).toBeNull()
  })
})

describe("solUsdOn (per-sale-day historical rate)", () => {
  const SPOT = { solana: { usd: 152.5 } }
  const HIST = { market_data: { current_price: { usd: 40 } } }
  // Route fetch by URL: the history endpoint vs the spot simple-price endpoint.
  function routeByUrl(histOk = true) {
    return (url: string) => {
      if (String(url).includes("/coins/solana/history")) {
        return Promise.resolve(histOk ? okJson(HIST) : { ok: false, status: 429, json: async () => ({}) })
      }
      return Promise.resolve(okJson(SPOT))
    }
  }
  // A day guaranteed to be in the past, and its dd-mm-yyyy CoinGecko form.
  const PAST_MS = Date.UTC(2020, 0, 2, 12, 0, 0) // 2020-01-02

  it("falls back to spot for a null / non-finite timestamp (no history call)", async () => {
    const das = await load()
    fetchMock.mockImplementation(routeByUrl())
    expect(await das.solUsdOn(null)).toBe(152.5)
    expect(await das.solUsdOn(Number.NaN)).toBe(152.5)
    // Only the spot endpoint was ever hit.
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain("/coins/solana/history")
    }
  })

  it("uses live spot for a same-day (today) sale, never the history endpoint", async () => {
    const das = await load()
    fetchMock.mockImplementation(routeByUrl())
    expect(await das.solUsdOn(Date.now())).toBe(152.5)
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain("/coins/solana/history")
    }
  })

  it("prices a past-day sale on that day's historical close", async () => {
    const das = await load()
    fetchMock.mockImplementation(routeByUrl())
    expect(await das.solUsdOn(PAST_MS)).toBe(40)
    const histCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/coins/solana/history"))
    expect(histCall).toBeTruthy()
    // dd-mm-yyyy (UTC) form of 2020-01-02.
    expect(String(histCall![0])).toContain("date=02-01-2020")
  })

  it("caches a day's historical rate — second call for the same day does not re-fetch", async () => {
    const das = await load()
    fetchMock.mockImplementation(routeByUrl())
    expect(await das.solUsdOn(PAST_MS)).toBe(40)
    const after = fetchMock.mock.calls.length
    expect(await das.solUsdOn(PAST_MS + 3600_000)).toBe(40) // same UTC day
    expect(fetchMock.mock.calls.length).toBe(after)
  })

  it("negative-caches a failed history day and falls back to spot (one history attempt)", async () => {
    const das = await load()
    fetchMock.mockImplementation(routeByUrl(false))
    expect(await das.solUsdOn(PAST_MS)).toBe(152.5) // spot fallback
    const histCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("/coins/solana/history")).length
    expect(histCalls()).toBe(1)
    // Second call same day: served from the negative cache → spot, no new history hit.
    expect(await das.solUsdOn(PAST_MS)).toBe(152.5)
    expect(histCalls()).toBe(1)
  })
})
