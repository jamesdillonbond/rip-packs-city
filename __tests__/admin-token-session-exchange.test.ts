// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { toAdminSession, upgradeStoredAdminToken, RPC_ADMIN_TOKEN_STORAGE } from "@/lib/admin-token"

// R134 step 2 (security audit 2026-10-25): the admin pages store a 12 h session,
// never the master token. These pin the client half of the exchange.

const SESSION = "rpcadm1.1900000000000.c2lnbmF0dXJl"

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

function stubFetch(status: number, body: unknown) {
  const f = vi.fn(async (_url: unknown, _init?: RequestInit) => ({
    ok: status < 400,
    status,
    json: async () => body,
  }))
  vi.stubGlobal("fetch", f)
  return f
}

describe("toAdminSession", () => {
  it("POSTs the master token in the BODY (never the URL) and returns the session", async () => {
    const f = stubFetch(200, { session: SESSION })
    expect(await toAdminSession(" master ")).toBe(SESSION)
    const [url, init] = f.mock.calls[0]
    expect(url).toBe("/api/admin/session")
    expect(init?.method).toBe("POST")
    expect(String(url)).not.toContain("master")
    expect(JSON.parse(String(init?.body))).toEqual({ token: "master" })
  })

  it("falls back to the value it was given when the exchange fails, so sign-in never locks the operator out", async () => {
    stubFetch(401, { error: "Unauthorized" })
    expect(await toAdminSession("master")).toBe("master")
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline") }))
    expect(await toAdminSession("master")).toBe("master")
    stubFetch(200, { session: "not-a-session" })
    expect(await toAdminSession("master")).toBe("master")
  })

  it("does not re-exchange a value that is already a session", async () => {
    const f = stubFetch(200, { session: SESSION })
    expect(await toAdminSession(SESSION)).toBe(SESSION)
    expect(f).not.toHaveBeenCalled()
  })
})

describe("upgradeStoredAdminToken", () => {
  it("replaces a stored MASTER token with a session in place", async () => {
    localStorage.setItem(RPC_ADMIN_TOKEN_STORAGE, "master")
    stubFetch(200, { session: SESSION })
    await upgradeStoredAdminToken()
    expect(localStorage.getItem(RPC_ADMIN_TOKEN_STORAGE)).toBe(SESSION)
  })

  it("leaves storage alone when it already holds a session or nothing; REMOVES a master it cannot exchange", async () => {
    const f = stubFetch(200, { session: SESSION })
    await upgradeStoredAdminToken()
    expect(localStorage.getItem(RPC_ADMIN_TOKEN_STORAGE)).toBeNull()
    localStorage.setItem(RPC_ADMIN_TOKEN_STORAGE, SESSION)
    await upgradeStoredAdminToken()
    expect(f).not.toHaveBeenCalled()
    localStorage.setItem(RPC_ADMIN_TOKEN_STORAGE, "master")
    stubFetch(500, {})
    await upgradeStoredAdminToken()
    // Re-pinned 2026-10-27: a master token must not sit in storage — the operator signs in again.
    expect(localStorage.getItem(RPC_ADMIN_TOKEN_STORAGE)).toBeNull()
  })
})
