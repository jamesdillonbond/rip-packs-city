// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { readFileSync } from "node:fs"
import { render, cleanup, waitFor } from "@testing-library/react"
import { signedInOnce, _resetSignedInForTests, SIGNED_IN_TTL_MS } from "@/lib/auth/signed-in-client"
import WalletHydrator from "@/components/WalletHydrator"

// 2026-10-18 (Cowork QA, 320 px sweep): an anonymous visitor who had pasted a wallet
// fired two session-gated requests that could only 401 on every page view
// (WarmupContext saved-wallets?ownerKey=, WalletHydrator wallet/profile?ownerKey=).
// lib/auth/signed-in-client.ts answers "is anyone signed in" from /api/profile/me,
// which never 401s, and callers skip ONLY on a definite signed-out.

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

beforeEach(() => {
  _resetSignedInForTests()
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe("signedInOnce — three states, never two", () => {
  it("user: null is a definite signed-out (false)", async () => {
    expect(await signedInOnce(vi.fn(async () => jsonRes({ user: null })) as unknown as typeof fetch)).toBe(false)
  })
  it("a user object is signed in (true)", async () => {
    expect(await signedInOnce(vi.fn(async () => jsonRes({ user: { id: "u1" } })) as unknown as typeof fetch)).toBe(true)
  })
  it("a failed read is UNKNOWN (null), never signed-out", async () => {
    expect(await signedInOnce(vi.fn(async () => jsonRes({}, 500)) as unknown as typeof fetch)).toBeNull()
    _resetSignedInForTests()
    expect(await signedInOnce(vi.fn(async () => { throw new Error("offline") }) as unknown as typeof fetch)).toBeNull()
    _resetSignedInForTests()
    // a body with no `user` key says nothing about the session
    expect(await signedInOnce(vi.fn(async () => jsonRes({ ok: true })) as unknown as typeof fetch)).toBeNull()
  })
  it("memoises one read per TTL, then re-reads", async () => {
    const f = vi.fn(async () => jsonRes({ user: null })) as unknown as typeof fetch
    await signedInOnce(f, 1_000)
    await signedInOnce(f, 1_000 + SIGNED_IN_TTL_MS - 1)
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1)
    await signedInOnce(f, 1_000 + SIGNED_IN_TTL_MS + 1)
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2)
  })
})

describe("WalletHydrator skips the session-gated call for a signed-OUT visitor", () => {
  function stub(me: unknown) {
    const f = vi.fn(async (url: string) => (String(url).includes("/api/profile/me") ? jsonRes(me) : jsonRes({ wallet_address: "0xdeadbeef00000001" })))
    vi.stubGlobal("fetch", f)
    return f
  }
  it("signed out: reads /api/profile/me and never calls /api/wallet/profile", async () => {
    const f = stub({ user: null })
    localStorage.setItem("rpc_owner_key", "0xbd94cade097e50ac")
    render(<WalletHydrator />)
    await waitFor(() => expect(f.mock.calls.some((c) => String(c[0]).includes("/api/profile/me"))).toBe(true))
    await new Promise((r) => setTimeout(r, 0))
    expect(f.mock.calls.some((c) => String(c[0]).includes("/api/wallet/profile"))).toBe(false)
  })
  it("signed in: still hydrates", async () => {
    const f = stub({ user: { id: "u1" } })
    localStorage.setItem("rpc_owner_key", "0xbd94cade097e50ac")
    render(<WalletHydrator />)
    await waitFor(() => expect(f.mock.calls.some((c) => String(c[0]).includes("/api/wallet/profile"))).toBe(true))
  })
})

describe("WarmupContext gates the saved-wallets warm-up on the same answer", () => {
  it("checks signedInOnce() before its session-gated saved-wallets fetch", () => {
    const src = readFileSync("lib/warmup/WarmupContext.tsx", "utf8")
    const gate = src.indexOf("if ((await signedInOnce()) === false) return")
    const call = src.indexOf("await fetch(savedUrl)")
    expect(gate).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(gate)
  })
})
