// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest"
import { getOwnerKey, setOwnerKey, clearOwnerKey, onOwnerKeyChange } from "@/lib/owner-key"
import { getAdminToken, setAdminToken, clearAdminToken } from "@/lib/admin-token"

// Client-side owner-key + admin-token localStorage helpers. Runs under jsdom.
// The admin token is sent as `Authorization: Bearer <token>` and paired against
// verifyAdminRequest server-side, so its round-trip must be exact.

beforeEach(() => localStorage.clear())

describe("owner-key", () => {
  it("defaults to empty, round-trips, and clears", () => {
    expect(getOwnerKey()).toBe("")
    setOwnerKey("trevor")
    expect(getOwnerKey()).toBe("trevor")
    clearOwnerKey()
    expect(getOwnerKey()).toBe("")
  })

  it("onOwnerKeyChange fires on a cross-tab storage event for the owner key", () => {
    const seen: string[] = []
    const unsub = onOwnerKeyChange((k) => seen.push(k))

    window.dispatchEvent(new StorageEvent("storage", { key: "rpc_owner_key", newValue: "newuser" }))
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", newValue: "x" }))

    unsub()
    window.dispatchEvent(new StorageEvent("storage", { key: "rpc_owner_key", newValue: "afterunsub" }))

    expect(seen).toEqual(["newuser"]) // only the matching key, and not after unsubscribe
  })
})

describe("admin-token", () => {
  it("defaults to empty, round-trips exactly, and clears", () => {
    expect(getAdminToken()).toBe("")
    setAdminToken("Bearer-worthy-token-123")
    expect(getAdminToken()).toBe("Bearer-worthy-token-123")
    clearAdminToken()
    expect(getAdminToken()).toBe("")
  })
})
