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
//
// ⚠ `mockJson` now sets `ok: true`. It did not before, and that was load-bearing
// in the wrong direction: the hook discriminated on NOTHING, so a mock with no
// `ok` was indistinguishable from a success and the suite could not have caught
// a failed read being mapped to `isPro: false`.

let fetchMock: ReturnType<typeof vi.fn>

function mockJson(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return Promise.resolve({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: () => Promise.resolve(body),
  } as Response)
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
    // failed:false — "no wallet supplied" is a real answer, not a failed read.
    expect(result.current).toEqual({ isPro: false, plan: null, daysRemaining: 0, loading: false, failed: false })
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
    expect(result.current.failed).toBe(false)

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
    // ⭐ THE PAIR THAT MAKES `failed` MEAN ANYTHING: a genuine non-member and a
    // failed read produce the same `isPro:false`, and must differ here.
    expect(result.current.failed).toBe(false)
  })

  // ── Inverted 2026-08-25 ─────────────────────────────────────────────────────
  //
  // This case used to read "falls back to empty state (no throw) when fetch
  // rejects" and asserted
  //     toEqual({ isPro: false, plan: null, daysRemaining: 0, loading: false })
  // — i.e. it PINNED the false claim as the contract. `pro_users` holds 21 active
  // members on `founding` / `pro_grandfather`; `ProBadge` renders null when
  // `!isPro`, so what this test was protecting was a paying member's badge
  // disappearing site-wide on a network blip.
  //
  // Per CLAUDE.md a test that pins the defect it was named to prevent gets
  // INVERTED, never deleted: the state it asserted is still what renders, but it
  // must now be DISTINGUISHABLE.
  describe("a failed membership read must stay distinguishable from a non-member", () => {
    it("sets failed when fetch rejects", async () => {
      fetchMock.mockRejectedValue(new Error("network down"))
      const { result } = renderHook(() => useProStatus("0xErr1"))

      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.failed).toBe(true)
      expect(result.current.isPro).toBe(false)
    })

    it("sets failed on a non-ok status rather than reading the error body as a verdict", async () => {
      // apiErrorResponse answers 503 with { error, code, retryable } — no
      // `is_pro` key at all, so `!!data.is_pro` was false and the old hook
      // published "not a member" from an outage.
      fetchMock.mockReturnValue(
        mockJson(
          { error: "Could not check membership status right now.", code: "timeout", retryable: true },
          { ok: false, status: 503 }
        )
      )
      const { result } = renderHook(() => useProStatus("0xErr503"))

      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.failed).toBe(true)
      expect(result.current.isPro).toBe(false)
    })

    it("sets failed on a 200 whose body carries no is_pro key", async () => {
      // Belt and braces for the shape that produced today's other finding: a
      // producer answering 200 on a failed read defeats every `res.ok` check.
      fetchMock.mockReturnValue(mockJson({ error: "something" }))
      const { result } = renderHook(() => useProStatus("0xErr200"))

      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.failed).toBe(true)
    })

    it("does NOT cache a failure — the next mount retries instead of staying downgraded for 5 minutes", async () => {
      // The module cache is shared by every mount and keyed on the wallet, so
      // caching a failure turned a momentary blip into a five-minute downgrade
      // that a page reload could not clear.
      const wallet = "0xRetryMe1"
      fetchMock.mockReturnValueOnce(mockJson({}, { ok: false, status: 503 }))
      const first = renderHook(() => useProStatus(wallet))
      await waitFor(() => expect(first.result.current.loading).toBe(false))
      expect(first.result.current.failed).toBe(true)
      first.unmount()

      fetchMock.mockReturnValue(mockJson({ is_pro: true, plan: "founding", days_remaining: 9999 }))
      const second = renderHook(() => useProStatus(wallet))
      await waitFor(() => expect(second.result.current.loading).toBe(false))
      expect(fetchMock).toHaveBeenCalledTimes(2) // it re-fetched
      expect(second.result.current.isPro).toBe(true)
      expect(second.result.current.plan).toBe("founding")
      expect(second.result.current.failed).toBe(false)
    })
  })

  it("NO-CHANGE CONTROL: serves a cached SUCCESS on remount without re-fetching", async () => {
    // Without this, "never cache" would satisfy the case above and delete the
    // caching this hook exists to provide.
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
