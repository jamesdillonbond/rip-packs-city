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
