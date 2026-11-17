// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

// WalletHydrator (0% before this) is a headless (renders null) background hydrator:
// when rpc_owner_key is set but rpc_wallet_address isn't (a pre-rewrite user), it
// hits /api/wallet/profile once to backfill the wallet address into localStorage
// and stamps rpc_last_hydrated. Drives: no-key short-circuit, the backfill path,
// and the fresh-TTL skip.

import WalletHydrator from "@/components/WalletHydrator"

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ wallet_address: "0xdeadbeef00000001" }) } as Response)),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe("WalletHydrator", () => {
  it("does nothing (no fetch) when there is no owner key", async () => {
    const { container } = render(<WalletHydrator />)
    expect(container.textContent).toBe("")
    // Give the effect a tick; it must NOT fetch.
    await new Promise((r) => setTimeout(r, 0))
    expect((fetch as any).mock.calls.length).toBe(0)
  })

  it("backfills rpc_wallet_address from /api/wallet/profile for a keyed user with no cached wallet", async () => {
    localStorage.setItem("rpc_owner_key", "trevor")
    render(<WalletHydrator />)
    await waitFor(() => expect((fetch as any).mock.calls.length).toBeGreaterThan(0))
    await waitFor(() => expect(localStorage.getItem("rpc_wallet_address")).toBe("0xdeadbeef00000001"))
    // It also stamps the hydration time.
    expect(localStorage.getItem("rpc_last_hydrated")).toBeTruthy()
  })

  it("skips the fetch when a wallet is cached and the TTL is still fresh", async () => {
    localStorage.setItem("rpc_owner_key", "trevor")
    localStorage.setItem("rpc_wallet_address", "0xcached")
    localStorage.setItem("rpc_last_hydrated", String(Date.now()))
    render(<WalletHydrator />)
    await new Promise((r) => setTimeout(r, 0))
    expect((fetch as any).mock.calls.length).toBe(0)
  })
})
