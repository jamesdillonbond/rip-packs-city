// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, screen, waitFor, act, cleanup } from "@testing-library/react"
import React from "react"

// lib/warmup/WarmupContext.tsx — the client-side prefetch/dedupe cache behind
// every warm page transition (packs, sniper, fast-break, RTR).
//
// ⚠ THIS MODULE READ 0% COVERAGE WITH 44 UNCOVERED FUNCTIONS despite FOUR test
// files "referencing" it — every one of them calls `vi.mock("@/lib/warmup/
// WarmupContext")`, so the real module never executed. A grep for the path
// says "tested"; nothing ran. It only became visible when `lib/**/*.tsx` was
// added to the primary coverage gate on 2026-08-11 (the gate's glob was
// `lib/**/*.ts`, which does not match `.tsx`, so this file was measured by
// NEITHER gate).
//
// That matters because this cache has already shipped a real bug of exactly the
// kind tests here would catch: known-issue #6, a WarmupContext KEY MISMATCH —
// the warmer prefetched into one key while the consumer read another, so the
// cache silently never hit and every "warm" navigation was a cold fetch. The
// failure mode is invisible: the page still works, just slower, so nothing
// alerts. The key-identity and dedupe assertions below are the guard for it.
//
// Scope: the cache primitives (read/write/subscribe/fetchOrJoin/prefetch) and
// the public hooks. The mount-time warming SEQUENCE (owner-key driven, idle-
// callback scheduled) is deliberately left to the consumer suites — it depends
// on document.hidden, requestIdleCallback and network hints that jsdom models
// only partially, and forcing it here would assert the mock, not the behaviour.

import WarmupProvider, { useWarmCache, usePrefetch, useWarmup } from "@/lib/warmup/WarmupContext"

function wrap(ui: React.ReactNode) {
  return <WarmupProvider>{ui}</WarmupProvider>
}

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
  // The provider's mount effect fires real requests; keep them inert and
  // offline so no test depends on the network.
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })
  ) as unknown as typeof globalThis.fetch
  window.history.replaceState({}, "", "/nba-top-shot/packs")
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("useWarmCache — fetch, cache, and key identity", () => {
  it("fetches on first mount and exposes the data", async () => {
    const fetcher = vi.fn(async () => ({ v: 1 }))
    function Probe() {
      const { data, loading } = useWarmCache<{ v: number }>("k1", fetcher)
      return <div>{loading ? "loading" : `v=${data?.v ?? "none"}`}</div>
    }
    render(wrap(<Probe />))
    await waitFor(() => expect(screen.getByText("v=1")).toBeTruthy())
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("DEDUPES concurrent consumers of the SAME key into one in-flight request", async () => {
    let resolve!: (v: unknown) => void
    const fetcher = vi.fn(() => new Promise((r) => { resolve = r }))
    function Probe({ id }: { id: string }) {
      const { data } = useWarmCache<{ v: number }>("shared", fetcher as () => Promise<{ v: number }>)
      return <div>{`${id}:${data?.v ?? "-"}`}</div>
    }
    render(wrap(<><Probe id="a" /><Probe id="b" /><Probe id="c" /></>))
    // Three consumers, ONE network call — that join is the whole point of the
    // cache. Losing it turns a warm page into N duplicate requests.
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    await act(async () => { resolve({ v: 7 }) })
    await waitFor(() => expect(screen.getByText("a:7")).toBeTruthy())
    // Every subscriber is notified, not just the one that triggered the fetch.
    expect(screen.getByText("b:7")).toBeTruthy()
    expect(screen.getByText("c:7")).toBeTruthy()
  })

  it("does NOT share across DIFFERENT keys — the key-mismatch guard", async () => {
    const f1 = vi.fn(async () => ({ v: 1 }))
    const f2 = vi.fn(async () => ({ v: 2 }))
    function Probe() {
      const a = useWarmCache<{ v: number }>("key-a", f1)
      const b = useWarmCache<{ v: number }>("key-b", f2)
      return <div>{`${a.data?.v ?? "-"}/${b.data?.v ?? "-"}`}</div>
    }
    render(wrap(<Probe />))
    await waitFor(() => expect(screen.getByText("1/2")).toBeTruthy())
    // Known-issue #6 was a warmer/consumer key mismatch that made every "warm"
    // navigation silently cold. Keys are identity: they must never cross-talk.
    expect(f1).toHaveBeenCalledTimes(1)
    expect(f2).toHaveBeenCalledTimes(1)
  })

  it("serves a FRESH cached entry to a later consumer without refetching", async () => {
    const fetcher = vi.fn(async () => ({ v: 42 }))
    function Probe() {
      const { data } = useWarmCache<{ v: number }>("warm", fetcher)
      return <div>{`v=${data?.v ?? "-"}`}</div>
    }
    function Host({ two }: { two: boolean }) {
      return <>{<Probe />}{two ? <Probe /> : null}</>
    }
    const { rerender } = render(wrap(<Host two={false} />))
    await waitFor(() => expect(screen.getAllByText("v=42").length).toBe(1))
    rerender(wrap(<Host two />))
    await waitFor(() => expect(screen.getAllByText("v=42").length).toBe(2))
    // The second consumer mounted against a fresh entry — a cache that refetched
    // here would be a cache in name only.
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("revalidates in the BACKGROUND when the cached entry is stale, without a loading flash", async () => {
    let n = 0
    const fetcher = vi.fn(async () => ({ v: ++n }))
    function Probe({ k }: { k: string }) {
      const { data, loading } = useWarmCache<{ v: number }>(k, fetcher, { ttlMs: 1 })
      return <div>{`${loading ? "L" : "R"}:${data?.v ?? "-"}`}</div>
    }
    const { rerender } = render(wrap(<Probe k="stale" />))
    await waitFor(() => expect(screen.getByText("R:1")).toBeTruthy())
    // Let the 1ms TTL lapse, then remount a consumer on the same key.
    await new Promise((r) => setTimeout(r, 10))
    rerender(wrap(<><Probe k="stale" /><Probe k="stale" /></>))
    // Stale-while-revalidate: the cached value shows immediately (never a
    // loading state), and a refresh happens behind it.
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(1))
    expect(document.body.textContent).not.toContain("L:")
  })

  it("captures a rejected fetch as `error` rather than throwing through the tree", async () => {
    const fetcher = vi.fn(async () => { throw new Error("nope") })
    function Probe() {
      const { error, loading } = useWarmCache("bad", fetcher)
      return <div>{loading ? "loading" : error ? `err:${(error as Error).message}` : "ok"}</div>
    }
    render(wrap(<Probe />))
    // A failed prefetch must degrade to an error value the consumer can render,
    // not an unhandled rejection that blanks the page.
    await waitFor(() => expect(screen.getByText("err:nope")).toBeTruthy())
  })

  it("does not fetch at all when disabled, and reports not-loading", async () => {
    const fetcher = vi.fn(async () => ({ v: 1 }))
    function Probe() {
      const { data, loading } = useWarmCache("off", fetcher, { enabled: false })
      return <div>{`${loading ? "L" : "R"}:${data ? "d" : "-"}`}</div>
    }
    render(wrap(<Probe />))
    await waitFor(() => expect(screen.getByText("R:-")).toBeTruthy())
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("refresh() revalidates in the background and updates subscribers", async () => {
    let n = 0
    const fetcher = vi.fn(async () => ({ v: ++n }))
    let doRefresh: (() => void) | null = null
    function Probe() {
      const { data, refresh } = useWarmCache<{ v: number }>("ref", fetcher)
      doRefresh = refresh
      return <div>{`v=${data?.v ?? "-"}`}</div>
    }
    render(wrap(<Probe />))
    await waitFor(() => expect(screen.getByText("v=1")).toBeTruthy())
    await act(async () => { doRefresh?.() })
    await waitFor(() => expect(screen.getByText("v=2")).toBeTruthy())
  })
})

describe("usePrefetch / useWarmup", () => {
  it("prefetch() populates the cache so a later consumer renders without its own fetch", async () => {
    const fetcher = vi.fn(async () => ({ v: 99 }))
    function Warmer() {
      const prefetch = usePrefetch()
      React.useEffect(() => { prefetch("pf", fetcher) }, [prefetch])
      return null
    }
    function Consumer() {
      const { data } = useWarmCache<{ v: number }>("pf", fetcher)
      return <div>{`v=${data?.v ?? "-"}`}</div>
    }
    render(wrap(<><Warmer /><Consumer /></>))
    await waitFor(() => expect(screen.getByText("v=99")).toBeTruthy())
    // One call total: the consumer JOINED the prefetch rather than racing it.
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("prefetch() SWALLOWS a rejection — it is fire-and-forget", async () => {
    const fetcher = vi.fn(async () => { throw new Error("prefetch boom") })
    function Warmer() {
      const prefetch = usePrefetch()
      React.useEffect(() => { prefetch("pf-bad", fetcher) }, [prefetch])
      return <div>mounted</div>
    }
    render(wrap(<Warmer />))
    await waitFor(() => expect(fetcher).toHaveBeenCalled())
    // A failed speculative warm must never surface as an unhandled rejection;
    // the user did not ask for this request.
    expect(screen.getByText("mounted")).toBeTruthy()
  })

  it("prefetch() skips a key that is already fresh", async () => {
    const fetcher = vi.fn(async () => ({ v: 1 }))
    function Probe() {
      const prefetch = usePrefetch()
      const { data } = useWarmCache<{ v: number }>("dupe", fetcher)
      React.useEffect(() => {
        if (data) prefetch("dupe", fetcher)
      }, [data, prefetch])
      return <div>{`v=${data?.v ?? "-"}`}</div>
    }
    render(wrap(<Probe />))
    await waitFor(() => expect(screen.getByText("v=1")).toBeTruthy())
    await new Promise((r) => setTimeout(r, 5))
    // Re-warming a fresh key would be pure waste on every navigation.
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("useWarmup() exposes read/fetchOrJoin for imperative paginated loaders", async () => {
    let ctx: ReturnType<typeof useWarmup> | null = null
    function Probe() {
      ctx = useWarmup()
      return null
    }
    render(wrap(<Probe />))
    await waitFor(() => expect(ctx).toBeTruthy())
    expect(ctx!.read("missing")).toBeUndefined()
    const v = await act(async () => ctx!.fetchOrJoin("imp", async () => ({ page: 1 }), 60_000))
    expect((v as { page: number }).page).toBe(1)
    // Written through to the shared cache, which is how the collection page
    // shares its prewarmed first page by url key.
    expect(ctx!.read("imp")?.data).toEqual({ page: 1 })
  })
})

describe("hooks outside the provider", () => {
  // Each throws a NAMED error rather than returning undefined and failing later
  // with an opaque "cannot read property of null" deep inside a consumer.
  const cases: Array<[string, () => unknown]> = [
    ["useWarmCache", () => useWarmCache("k", async () => ({}))],
    ["usePrefetch", () => usePrefetch()],
    ["useWarmup", () => useWarmup()],
  ]
  for (const [name, use] of cases) {
    it(`${name} throws a named error when used outside <WarmupProvider>`, () => {
      function Probe() {
        use()
        return null
      }
      const spy = vi.spyOn(console, "error").mockImplementation(() => {})
      expect(() => render(<Probe />)).toThrow(new RegExp(`${name} must be used inside`))
      spy.mockRestore()
    })
  }
})
