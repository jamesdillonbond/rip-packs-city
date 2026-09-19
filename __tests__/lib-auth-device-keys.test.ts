// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest"
import { reconcileDeviceKeysForUser } from "@/lib/auth/device-keys"

// Per-device wallet keys are per-ORIGIN; a second account on the same browser
// inherited the first one's wallet (2026-09-02 QA). The helper is what both
// sign-in paths call — the dashboard for the token-hash link, /auth/confirm
// for the implicit-flow one.
describe("reconcileDeviceKeysForUser", () => {
  beforeEach(() => localStorage.clear())

  function seed() {
    localStorage.setItem("rpc_owner_key", "0xaaa")
    localStorage.setItem("rpc_last_wallet", "0xaaa")
    localStorage.setItem("rpc_owned_0xaaa", "[]")
    localStorage.setItem("rpc:first-run-completed", "1")
    localStorage.setItem("rpc_theme", "light") // NOT a wallet key — must survive
    localStorage.setItem("rpc_admin_token", "keep") // operator key — must survive
  }

  it("first sign-in on a device records the user and clears nothing", () => {
    seed()
    expect(reconcileDeviceKeysForUser("u1")).toBe(0)
    expect(localStorage.getItem("rpc_session_user")).toBe("u1")
    expect(localStorage.getItem("rpc_owner_key")).toBe("0xaaa")
  })

  it("the same user again clears nothing", () => {
    seed()
    reconcileDeviceKeysForUser("u1")
    expect(reconcileDeviceKeysForUser("u1")).toBe(0)
    expect(localStorage.getItem("rpc_owner_key")).toBe("0xaaa")
  })

  it("a DIFFERENT user drops the previous account's wallet keys and nothing else", () => {
    seed()
    reconcileDeviceKeysForUser("u1")
    const removed = reconcileDeviceKeysForUser("u2")
    expect(removed).toBe(4)
    expect(localStorage.getItem("rpc_owner_key")).toBeNull()
    expect(localStorage.getItem("rpc_last_wallet")).toBeNull()
    expect(localStorage.getItem("rpc_owned_0xaaa")).toBeNull()
    expect(localStorage.getItem("rpc:first-run-completed")).toBeNull()
    expect(localStorage.getItem("rpc_theme")).toBe("light")
    expect(localStorage.getItem("rpc_admin_token")).toBe("keep")
    expect(localStorage.getItem("rpc_session_user")).toBe("u2")
  })

  it("a null user (anonymous / failed read) touches nothing", () => {
    seed()
    reconcileDeviceKeysForUser("u1")
    expect(reconcileDeviceKeysForUser(null)).toBe(0)
    expect(localStorage.getItem("rpc_owner_key")).toBe("0xaaa")
    expect(localStorage.getItem("rpc_session_user")).toBe("u1")
  })
})

// ⛔ THE CHAIN-SCOPED HOLE, pinned 2026-09-19. The owner key stopped being one
// key that day: a browser can hold `rpc_owner_key` (Flow) and
// `rpc_owner_key_solana` (Candy) at the same time. `rpc_owner_key` was listed in
// this module by EXACT NAME, so an account switch dropped the Flow key and LEFT
// the Candy one — handing the next collector to sign in on that device the
// previous collector's Candy wallet. That is the same failure, on a new chain,
// that this whole module was written for after the 2026-09-02 QA.
describe("reconcileDeviceKeysForUser — every chain's owner key, not just Flow's", () => {
  beforeEach(() => localStorage.clear())

  it("an account switch drops the Solana slot as well as the Flow one", () => {
    localStorage.setItem("rpc_owner_key", "0xaaa")
    localStorage.setItem("rpc_owner_key_solana", "12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK")
    localStorage.setItem("rpc_owner_key_evm", "0x1111111111111111111111111111111111111111")
    localStorage.setItem("rpc_theme", "light")
    reconcileDeviceKeysForUser("u1")

    expect(reconcileDeviceKeysForUser("u2")).toBe(3)
    expect(localStorage.getItem("rpc_owner_key")).toBeNull()
    expect(localStorage.getItem("rpc_owner_key_solana")).toBeNull()
    expect(localStorage.getItem("rpc_owner_key_evm")).toBeNull()
    // ⚠ The no-change control. A prefix sweep that is too greedy would take the
    // unrelated keys with it, and this module's whole contract is that it drops
    // WALLET state and leaves everything else standing.
    expect(localStorage.getItem("rpc_theme")).toBe("light")
  })

  it("⚠ the sweep is by PREFIX, so a chain that does not exist yet is covered too", () => {
    // An enumeration of chain names goes stale silently the day a fourth chain
    // ships; this is the arm that says the mechanism, not the list, is the fix.
    localStorage.setItem("rpc_owner_key_somefuturechain", "whatever")
    reconcileDeviceKeysForUser("u1")
    expect(reconcileDeviceKeysForUser("u2")).toBe(1)
    expect(localStorage.getItem("rpc_owner_key_somefuturechain")).toBeNull()
  })
})
