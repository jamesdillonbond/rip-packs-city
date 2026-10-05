import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

// /api/admin/swap-test: Trevor-only. What matters: no token, no access; each action
// reaches its helper with the body's fields; a helper's SwapTestError keeps its status
// and code (a 410 expiry never becomes a 500, a 502 chain failure never a 200).

const lib = vi.hoisted(() => ({ planSwap: vi.fn(), verifySwap: vi.fn(), getRelay: vi.fn(), postSignable: vi.fn(), postSignature: vi.fn() }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { tag: "admin-db" } }))
vi.mock("@/lib/swap-test/plan", async (orig) => ({ ...(await orig<typeof import("@/lib/swap-test/plan")>()), planSwap: lib.planSwap, verifySwap: lib.verifySwap }))
vi.mock("@/lib/swap-test/relay", () => ({ getRelay: lib.getRelay, postSignable: lib.postSignable, postSignature: lib.postSignature }))

import * as route from "@/app/api/admin/swap-test/route"
import { SwapTestError } from "@/lib/swap-test/plan"

const auth = { authorization: "Bearer tok" }
const post = (body: unknown, headers: Record<string, string> = auth) =>
  new NextRequest("http://x/api/admin/swap-test", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })

beforeEach(() => vi.stubEnv("RPC_ADMIN_TOKEN", "tok"))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe("/api/admin/swap-test", () => {
  it("refuses without the admin token, before any helper runs", async () => {
    expect((await route.GET(new NextRequest("http://x/api/admin/swap-test?relay=r"))).status).toBe(401)
    expect((await route.POST(post({ action: "plan" }, {}))).status).toBe(401)
    expect(lib.planSwap).not.toHaveBeenCalled()
  })

  it("plan: passes both sides through and returns the simulated plan", async () => {
    lib.planSwap.mockResolvedValue({ a: { ctl: "87" }, b: { ctl: "0" } })
    const r = await route.POST(post({ action: "plan", a: { signer: "x" }, b: { signer: "y" } }))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ plan: { a: { ctl: "87" }, b: { ctl: "0" } } })
    expect(lib.planSwap).toHaveBeenCalledWith({ signer: "x" }, { signer: "y" })
  })

  it("keeps a helper's status and code", async () => {
    lib.planSwap.mockRejectedValue(new SwapTestError("Side A: couldn't read the chain", 502, "chain_read_failed"))
    const r = await route.POST(post({ action: "plan" }))
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ error: "Side A: couldn't read the chain", code: "chain_read_failed" })
    lib.getRelay.mockRejectedValue(new SwapTestError("expired", 410, "expired"))
    expect((await route.GET(new NextRequest("http://x/api/admin/swap-test?relay=r", { headers: auth }))).status).toBe(410)
  })

  it("an unexpected failure is a 500, never a success", async () => {
    lib.postSignable.mockRejectedValue(new Error("db down"))
    const r = await route.POST(post({ action: "relay_post", cosigner: "0xD96DC67AE64EE202", signable: {} }))
    expect(r.status).toBe(500)
  })

  it("relay_post lowercases the co-signer; relay_sign forwards signature and key", async () => {
    lib.postSignable.mockResolvedValue("rid")
    const r = await route.POST(post({ action: "relay_post", cosigner: " 0xD96DC67AE64EE202 ", signable: { a: 1 } }))
    expect(await r.json()).toEqual({ id: "rid" })
    expect(lib.postSignable).toHaveBeenCalledWith({ tag: "admin-db" }, "0xd96dc67ae64ee202", { a: 1 })
    lib.postSignature.mockResolvedValue(undefined)
    const s = await route.POST(post({ action: "relay_sign", id: "rid", signature: "ab", key_id: 2 }))
    expect(await s.json()).toEqual({ ok: true })
    expect(lib.postSignature).toHaveBeenCalledWith({ tag: "admin-db" }, "rid", "ab", 2, expect.any(Number))
  })

  it("verify: reads the chain for the sealed plan", async () => {
    lib.verifySwap.mockResolvedValue([{ id: "1", to: "0x2", held: true }])
    const r = await route.POST(post({ action: "verify", plan: { a: 1 } }))
    expect(await r.json()).toEqual({ landed: [{ id: "1", to: "0x2", held: true }] })
    expect(lib.verifySwap).toHaveBeenCalledWith({ a: 1 })
  })

  it("GET returns the relay row", async () => {
    lib.getRelay.mockResolvedValue({ id: "rid", signature: null })
    const r = await route.GET(new NextRequest("http://x/api/admin/swap-test?relay=rid", { headers: auth }))
    expect(await r.json()).toEqual({ relay: { id: "rid", signature: null } })
    expect(lib.getRelay).toHaveBeenCalledWith({ tag: "admin-db" }, "rid", expect.any(Number))
  })

  it("an unknown action or a non-JSON body is a 400", async () => {
    expect((await route.POST(post({ action: "trade" }))).status).toBe(400)
    const bad = new NextRequest("http://x/api/admin/swap-test", { method: "POST", headers: auth, body: "{" })
    expect((await route.POST(bad)).status).toBe(400)
  })
})
