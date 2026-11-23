import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { parseHoldingInput } from "@/lib/physical/holding-input"

// "Add a card I own" (unwired): the validator mirrors the draft table CHECKs,
// and the route is 404 while off and validates before auth or any write.

const CARD = "11111111-2222-3333-4444-555555555555"

describe("parseHoldingInput", () => {
  it("accepts a slab and a raw lot", () => {
    expect(parseHoldingInput({ cardId: CARD, grader: "PSA", grade: "10", certNumber: "1234-5678" })).toMatchObject({
      ok: true,
      value: { grader: "psa", grade: "10", certNumber: "12345678", quantity: 1, rawCondition: null },
    })
    expect(parseHoldingInput({ cardId: CARD, grader: "raw", rawCondition: "near_mint", quantity: 3, costBasisUsd: "4.999" })).toMatchObject({
      ok: true,
      value: { grade: "raw", certNumber: null, quantity: 3, costBasisUsd: 5 },
    })
  })

  it.each([
    [{ cardId: "x", grader: "psa", grade: "10", certNumber: "12345678" }, /Pick the card/],
    [{ cardId: CARD, grader: "hga", grade: "10", certNumber: "12345678" }, /Grader/],
    [{ cardId: CARD, grader: "psa", grade: "11", certNumber: "12345678" }, /Grade/],
    [{ cardId: CARD, grader: "psa", grade: "10" }, /cert number/],
    [{ cardId: CARD, grader: "psa", grade: "10", certNumber: "12345678", quantity: 2 }, /one card/],
    [{ cardId: CARD, grader: "raw" }, /condition/],
    [{ cardId: CARD, grader: "raw", rawCondition: "mint", certNumber: "1" }, /no cert/],
    [{ cardId: CARD, grader: "raw", rawCondition: "mint", costBasisUsd: -1 }, /Cost/],
  ])("refuses %j", (body, msg) => {
    const r = parseHoldingInput(body)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(msg)
  })
})

describe("/api/physical/holdings", () => {
  const saved = { ...process.env }
  // Each test installs its own db mock: a shared beforeEach mock could win over
  // a later per-test one when the file runs beside others (vitest related).
  const noDb = () =>
    vi.doMock("@/lib/supabase", () => ({ supabaseAdmin: { from: vi.fn(() => { throw new Error("no db while off/invalid") }) } }))
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  it("404s on every verb while off", async () => {
    delete process.env.PHYSICAL_CARDS
    noDb()
    vi.doMock("@/lib/auth/supabase-server", () => ({ requireUser: vi.fn(() => { throw new Error("no auth while off") }) }))
    const route = await import("@/app/api/physical/holdings/route")
    const { NextRequest } = await import("next/server")
    const mk = (m: string) => new NextRequest("https://x.test/api/physical/holdings", { method: m, body: m === "GET" ? undefined : "{}" })
    expect((await route.GET()).status).toBe(404)
    expect((await route.POST(mk("POST"))).status).toBe(404)
    expect((await route.DELETE(mk("DELETE"))).status).toBe(404)
  })

  it("400s an invalid add before auth or any write", async () => {
    process.env.PHYSICAL_CARDS = "1"
    process.env.HCI_API_KEY = "k"
    noDb()
    const requireUser = vi.fn()
    vi.doMock("@/lib/auth/supabase-server", () => ({ requireUser }))
    const route = await import("@/app/api/physical/holdings/route")
    const { NextRequest } = await import("next/server")
    const res = await route.POST(new NextRequest("https://x.test/api/physical/holdings", { method: "POST", body: JSON.stringify({ cardId: CARD, grader: "raw" }) }))
    expect(res.status).toBe(400)
    expect(requireUser).not.toHaveBeenCalled()
  })

  it("scopes a delete to the signed-in user", async () => {
    process.env.PHYSICAL_CARDS = "1"
    process.env.HCI_API_KEY = "k"
    const eqs: [string, string][] = []
    const chain = { delete: () => chain, eq: (c: string, v: string) => (eqs.push([c, v]), eqs.length === 2 ? Promise.resolve({ error: null }) : chain) }
    vi.doMock("@/lib/supabase", () => ({ supabaseAdmin: { from: vi.fn(() => chain) } }))
    vi.doMock("@/lib/auth/supabase-server", () => ({ requireUser: vi.fn(async () => ({ id: "u1" })) }))
    const route = await import("@/app/api/physical/holdings/route")
    const { NextRequest } = await import("next/server")
    const res = await route.DELETE(new NextRequest("https://x.test/api/physical/holdings", { method: "DELETE", body: JSON.stringify({ id: CARD }) }))
    expect(res.status).toBe(200)
    expect(eqs).toEqual([["id", CARD], ["user_id", "u1"]])
  })
})
