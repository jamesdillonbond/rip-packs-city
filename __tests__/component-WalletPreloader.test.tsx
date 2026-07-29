// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import WalletPreloader from "@/components/WalletPreloader"

// Drives the render-null wallet preloader's cache-gating: no owner key → no
// fetch, a non-0x key → no fetch, a fresh cache → no fetch, and a missing/stale
// cache → fetch /api/owned-flow-ids and write the cache payload.

let ownerKey = ""
vi.mock("@/lib/owner-key", () => ({ getOwnerKey: () => ownerKey }))

let fetchMock: ReturnType<typeof vi.fn>
const okJson = (b: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(b) } as Response)

beforeEach(() => {
  ownerKey = ""
  window.localStorage.clear()
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
  // The component passes AbortSignal.timeout(15000) to fetch, which schedules a
  // real 15s timer. Left to leak it fires mid-run in a later file. Return a plain
  // (never-firing) signal so no real timer is scheduled.
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("WalletPreloader", () => {
  it("renders nothing and does not fetch with no owner key", () => {
    const { container } = render(<WalletPreloader />)
    expect(container.firstChild).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("does not fetch for a non-0x (username) key", async () => {
    ownerKey = "somebody"
    render(<WalletPreloader />)
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("skips the fetch when the cache is fresh with an editions field", async () => {
    ownerKey = "0xabc"
    window.localStorage.setItem(
      "rpc_owned_0xabc",
      JSON.stringify({ ids: ["1"], editions: ["e1"], cachedAt: Date.now() }),
    )
    render(<WalletPreloader />)
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fetches owned ids and writes the cache when the cache is stale/missing", async () => {
    ownerKey = "0xabc"
    fetchMock.mockReturnValueOnce(okJson({ ids: [1, 2, 3], editions: ["e1"] }))
    render(<WalletPreloader />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toContain("/api/owned-flow-ids?wallet=0xabc")
    await waitFor(() => expect(window.localStorage.getItem("rpc_owned_0xabc")).toBeTruthy())
    const cached = JSON.parse(window.localStorage.getItem("rpc_owned_0xabc")!)
    expect(cached.ids).toEqual(["1", "2", "3"]) // coerced to strings
    expect(cached.editions).toEqual(["e1"])
    expect(typeof cached.cachedAt).toBe("number")
  })
})
