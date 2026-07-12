// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useProStatus } from "@/lib/hooks/useProStatus"

// useProStatus(wallet) fetches /api/pro-status?wallet=<lc>, maps the response
// (is_pro/plan/days_remaining) into {isPro, plan, daysRemaining}, caches the
// result for 5 min keyed by lowercased wallet, and starts loading:true only
// when a wallet is present. We drive fetch to assert every state transition.
// NOTE: the module holds a process-lifetime cache Map, so each test uses a
// DISTINCT wallet address to avoid cross-test cache bleed.

let fetchMock: ReturnType<typeof vi.fn>

function mockJson(body: unknown) {
  return Promise.resolve({ json: () => Promise.resolve(body) } as Response)
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("useProStatus", () => {
  it("null wallet resolves immediately to empty non-loading state and never fetches", async () => {
    const { result } = renderHook(() => useProStatus(null))
    expect(result.current).toEqual({ isPro: false, plan: null, daysRemaining: 0, loading: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("starts loading, then maps a Pro response into the hook state", async () => {
    fetchMock.mockReturnValue(mockJson({ is_pro: true, plan: "annual", days_remaining: 42 }))
    const { result } = renderHook(() => useProStatus("0xAaBb"))

    // Loading kicks off true because a wallet was supplied.
    expect(result.current.loading).toBe(true)
    expect(result.current.isPro).toBe(false)

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.isPro).toBe(true)
    expect(result.current.plan).toBe("annual")
    expect(result.current.daysRemaining).toBe(42)

    // Wallet is lowercased in the request URL.
    expect(fetchMock).toHaveBeenCalledWith("/api/pro-status?wallet=0xaabb")
  })

  it("maps a non-Pro response to the empty value with loading cleared", async () => {
    fetchMock.mockReturnValue(mockJson({ is_pro: false }))
    const { result } = renderHook(() => useProStatus("0xNonPro1"))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.isPro).toBe(false)
    expect(result.current.plan).toBe(null)
    expect(result.current.daysRemaining).toBe(0)
  })

  it("falls back to empty state (no throw) when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new Error("network down"))
    const { result } = renderHook(() => useProStatus("0xErr1"))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current).toEqual({ isPro: false, plan: null, daysRemaining: 0, loading: false })
  })

  it("serves a cached result on remount without re-fetching", async () => {
    fetchMock.mockReturnValue(mockJson({ is_pro: true, plan: "monthly", days_remaining: 10 }))
    const wallet = "0xCacheMe1"

    const first = renderHook(() => useProStatus(wallet))
    await waitFor(() => expect(first.result.current.loading).toBe(false))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    first.unmount()

    // Second mount within the 5-min TTL should hit the cache, not fetch again,
    // and resolve synchronously to loading:false.
    const second = renderHook(() => useProStatus(wallet))
    expect(second.result.current.loading).toBe(false)
    expect(second.result.current.isPro).toBe(true)
    expect(second.result.current.plan).toBe("monthly")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
