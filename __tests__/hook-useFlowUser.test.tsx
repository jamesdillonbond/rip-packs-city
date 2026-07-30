// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"

// useFlowUser subscribes to fcl.currentUser and maps the raw FCL user snapshot
// into {addr, loggedIn, walletProvider}. walletProvider is derived from the
// user's `services` array (dapper / flow / unknown). logIn/logOut proxy to
// fcl.authenticate/unauthenticate. We mock FCL so we can push snapshots.

const authenticate = vi.fn()
const unauthenticate = vi.fn()
const unsubscribe = vi.fn()
let emit: (u: unknown) => void = () => {}

vi.mock("@/lib/chains/flow/flow", () => ({ initFcl: vi.fn() }))
// logIn() configures wallet discovery through the single owner (self-custody by
// default) — stub it so the hook test never touches real FCL config.
vi.mock("@/lib/chains/flow/fcl-config", () => ({
  configureFcl: vi.fn(),
  configureFclAuth: vi.fn(),
}))
vi.mock("@onflow/fcl", () => ({
  currentUser: {
    subscribe: (cb: (u: unknown) => void) => {
      emit = cb
      return unsubscribe
    },
  },
  authenticate: (...a: unknown[]) => authenticate(...a),
  unauthenticate: (...a: unknown[]) => unauthenticate(...a),
}))

import { useFlowUser } from "@/lib/hooks/useFlowUser"

beforeEach(() => {
  authenticate.mockClear()
  unauthenticate.mockClear()
  unsubscribe.mockClear()
})

describe("useFlowUser", () => {
  it("starts loading, then reports logged-out on the first empty snapshot", () => {
    const { result } = renderHook(() => useFlowUser())
    // subscribe fires synchronously during mount effect; push logged-out.
    act(() => emit({ loggedIn: false, addr: null }))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.user).toEqual({ addr: null, loggedIn: false, walletProvider: "unknown" })
  })

  it("detects a Dapper wallet from the services uid", () => {
    const { result } = renderHook(() => useFlowUser())
    act(() =>
      emit({
        loggedIn: true,
        addr: "0xabc",
        services: [{ uid: "dapper-wallet#authn", f_type: "Service" }],
      })
    )
    expect(result.current.user).toEqual({ addr: "0xabc", loggedIn: true, walletProvider: "dapper" })
  })

  it("detects a Flow wallet (blocto/lilico/flow-wallet) from the services", () => {
    const { result } = renderHook(() => useFlowUser())
    act(() => emit({ loggedIn: true, addr: "0xdef", services: [{ uid: "blocto#authn" }] }))
    expect(result.current.user.walletProvider).toBe("flow")
  })

  it("returns walletProvider 'unknown' when logged in but no recognizable service", () => {
    const { result } = renderHook(() => useFlowUser())
    act(() => emit({ loggedIn: true, addr: "0x999", services: [{ uid: "mystery#authn" }] }))
    expect(result.current.user.walletProvider).toBe("unknown")
  })

  it("does not attempt provider detection while logged out (provider stays unknown even with services)", () => {
    const { result } = renderHook(() => useFlowUser())
    act(() => emit({ loggedIn: false, addr: null, services: [{ uid: "dapper#authn" }] }))
    expect(result.current.user.walletProvider).toBe("unknown")
  })

  it("logIn/logOut proxy to fcl.authenticate/unauthenticate", () => {
    const { result } = renderHook(() => useFlowUser())
    act(() => result.current.logIn())
    act(() => result.current.logOut())
    expect(authenticate).toHaveBeenCalledTimes(1)
    expect(unauthenticate).toHaveBeenCalledTimes(1)
  })

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useFlowUser())
    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
