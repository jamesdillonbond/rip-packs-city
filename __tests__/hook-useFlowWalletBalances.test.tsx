// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"

// useFlowWalletBalances reads FLOW + USDCFlow balances via fcl.query, but ONLY
// when a non-Dapper, non-unknown Flow wallet is connected. It parses the raw
// UFix64 strings to 2-decimal numbers and exposes a refetch(). We mock the
// upstream useFlowUser and fcl.query to drive each branch.

const queryMock = vi.fn()
let mockUser: { addr: string | null; loggedIn: boolean; walletProvider: string }

vi.mock("@/lib/hooks/useFlowUser", () => ({
  useFlowUser: () => ({ user: mockUser, logIn: vi.fn(), logOut: vi.fn(), isLoading: false }),
}))
vi.mock("@onflow/fcl", () => ({
  query: (...a: unknown[]) => queryMock(...a),
  arg: (v: unknown) => v,
  t: { Address: "Address" },
}))

import { useFlowWalletBalances } from "@/lib/hooks/useFlowWalletBalances"

beforeEach(() => {
  queryMock.mockReset()
  mockUser = { addr: null, loggedIn: false, walletProvider: "unknown" }
})

describe("useFlowWalletBalances", () => {
  it("stays at zero and never queries when disconnected", async () => {
    const { result } = renderHook(() => useFlowWalletBalances())
    // Give effects a tick.
    await act(async () => {})
    expect(result.current.flowBalance).toBe(0)
    expect(result.current.usdcBalance).toBe(0)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it("does not query for a Dapper wallet (only self-custody Flow wallets are supported)", async () => {
    mockUser = { addr: "0xabc", loggedIn: true, walletProvider: "dapper" }
    const { result } = renderHook(() => useFlowWalletBalances())
    await act(async () => {})
    expect(queryMock).not.toHaveBeenCalled()
    expect(result.current.flowBalance).toBe(0)
  })

  it("queries both balances for a Flow wallet and parses them to 2 decimals", async () => {
    mockUser = { addr: "0xdef", loggedIn: true, walletProvider: "flow" }
    // First call = FLOW, second = USDC (Promise.all order matches the source).
    queryMock
      .mockResolvedValueOnce("123.456789")
      .mockResolvedValueOnce("10.019")
    const { result } = renderHook(() => useFlowWalletBalances())

    await waitFor(() => expect(result.current.flowBalance).toBe(123.46))
    expect(result.current.usdcBalance).toBe(10.02)
    expect(queryMock).toHaveBeenCalledTimes(2)
    expect(result.current.isLoading).toBe(false)
  })

  it("refetch re-queries balances on demand", async () => {
    mockUser = { addr: "0xdef", loggedIn: true, walletProvider: "flow" }
    queryMock.mockResolvedValue("5.0")
    const { result } = renderHook(() => useFlowWalletBalances())
    await waitFor(() => expect(result.current.flowBalance).toBe(5))

    const callsBefore = queryMock.mock.calls.length
    await act(async () => {
      result.current.refetch()
    })
    expect(queryMock.mock.calls.length).toBeGreaterThan(callsBefore)
  })
})
