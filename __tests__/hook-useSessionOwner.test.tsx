// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useSessionOwner } from "@/lib/hooks/useSessionOwner"

// Successor to the deleted useFlowUser. This is what the Pro badge keys on now,
// so a regression here makes the badge go dark site-wide while tsc stays green —
// which is exactly the failure mode the 2026-08-08 wallet-connect removal had to
// avoid. /api/profile/me never 401s (it returns { user: null } signed out), so
// every non-happy path must resolve to the empty identity, never throw.

let fetchMock: ReturnType<typeof vi.fn>
const okJson = (b: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(b) } as Response)

beforeEach(() => {
  fetchMock = vi.fn(() => okJson({ user: null }))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe("useSessionOwner", () => {
  it("starts loading, then maps the session identity", async () => {
    fetchMock.mockReturnValueOnce(
      okJson({
        user: {
          id: "u1",
          email: "me@x.com",
          username: "whale",
          wallet_addr: "0xbd94cade097e50ac",
          display_name: "Whale",
        },
      }),
    )
    const { result } = renderHook(() => useSessionOwner())
    expect(result.current.loading).toBe(true)

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current).toEqual({
      userId: "u1",
      email: "me@x.com",
      username: "whale",
      walletAddr: "0xbd94cade097e50ac",
      displayName: "Whale",
      loading: false,
      // Added 2026-08-22. Kept in this EXHAUSTIVE deep-equal on purpose: it is
      // what caught the field being added, and a new identity field silently
      // appearing (or vanishing) is exactly what this hook must not do quietly.
      degraded: false,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/profile/me",
      expect.objectContaining({ cache: "no-store", credentials: "include" }),
    )
  })

  it("resolves to the empty identity when signed out", async () => {
    const { result } = renderHook(() => useSessionOwner())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.walletAddr).toBeNull()
    expect(result.current.userId).toBeNull()
  })

  it("nulls absent fields rather than leaving them undefined", async () => {
    fetchMock.mockReturnValueOnce(okJson({ user: { id: "u1" } }))
    const { result } = renderHook(() => useSessionOwner())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.walletAddr).toBeNull()
    expect(result.current.username).toBeNull()
    expect(result.current.displayName).toBeNull()
    expect(result.current.email).toBeNull()
  })

  it("stops loading on a non-ok response", async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: false, status: 500 } as Response))
    const { result } = renderHook(() => useSessionOwner())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.walletAddr).toBeNull()
  })

  it("stops loading on a network failure (never throws)", async () => {
    fetchMock.mockReturnValueOnce(Promise.reject(new Error("offline")))
    const { result } = renderHook(() => useSessionOwner())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.walletAddr).toBeNull()
  })

  // ⚠ THREE STATES, NOT TWO: request failed / signed out / signed in. The hook
  // collapsed the first into the second, so a signed-in reader whose request died
  // rendered as anon — a false claim about their own account, one layer up from
  // the route defect these tests were added alongside.
  //
  // ⚠ Assertions pin `degraded` as a DISCRIMINATOR, with both controls present:
  // an always-true flag would satisfy the failure cases and mean nothing.
  it("marks degraded when the request is not ok — not silently signed out", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response),
    )
    const { result } = renderHook(() => useSessionOwner())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.degraded).toBe(true)
    expect(result.current.walletAddr).toBeNull()
  })

  it("marks degraded when the fetch itself rejects", async () => {
    fetchMock.mockReturnValueOnce(Promise.reject(new Error("network down")))
    const { result } = renderHook(() => useSessionOwner())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.degraded).toBe(true)
  })

  it("propagates identity_degraded from the route for a signed-in reader", async () => {
    fetchMock.mockReturnValueOnce(
      okJson({ user: { id: "u1", email: "me@x.com", wallet_addr: null, identity_degraded: true } }),
    )
    const { result } = renderHook(() => useSessionOwner())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.userId).toBe("u1")
    expect(result.current.degraded).toBe(true)
  })

  it("CONTROL: a genuine signed-out reader is NOT degraded", async () => {
    fetchMock.mockReturnValueOnce(okJson({ user: null }))
    const { result } = renderHook(() => useSessionOwner())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.degraded).toBe(false)
    expect(result.current.userId).toBeNull()
  })

  it("CONTROL: a healthy signed-in reader is NOT degraded", async () => {
    fetchMock.mockReturnValueOnce(
      okJson({ user: { id: "u1", wallet_addr: "0xabc", identity_degraded: false } }),
    )
    const { result } = renderHook(() => useSessionOwner())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.degraded).toBe(false)
    expect(result.current.walletAddr).toBe("0xabc")
  })

  it("does not set state after unmount", async () => {
    let resolve!: (v: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { resolve = r }))
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { unmount } = renderHook(() => useSessionOwner())
    unmount()
    resolve({ ok: true, json: () => Promise.resolve({ user: { id: "u1" } }) } as Response)
    await Promise.resolve()
    expect(errSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })
})
