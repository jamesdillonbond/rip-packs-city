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
    // Review finding 5: a typed date is stored or refused, never silently dropped.
    [{ ...{ cardId: CARD, grader: "raw", rawCondition: "mint" }, acquiredOn: "11/02/2026" }, /YYYY-MM-DD/],
    [{ ...{ cardId: CARD, grader: "raw", rawCondition: "mint" }, acquiredOn: "2026-02-31" }, /YYYY-MM-DD/],
    [{ ...{ cardId: CARD, grader: "raw", rawCondition: "mint" }, acquiredOn: "2999-01-01" }, /future/],
    [{ ...{ cardId: CARD, grader: "raw", rawCondition: "mint" }, acquiredOn: 20261102 }, /YYYY-MM-DD/],
  ])("refuses %j", (body, msg) => {
    const r = parseHoldingInput(body)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(msg)
  })
})

describe("parseHoldingInput dates", () => {
  it("keeps a real past date and treats empty as none", () => {
    const base = { cardId: CARD, grader: "raw", rawCondition: "mint" }
    const ok = parseHoldingInput({ ...base, acquiredOn: "2024-02-29" }, new Date("2026-11-23T12:00:00Z"))
    expect(ok).toMatchObject({ ok: true, value: { acquiredOn: "2024-02-29" } })
    expect(parseHoldingInput({ ...base, acquiredOn: "" })).toMatchObject({ ok: true, value: { acquiredOn: null } })
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
    const chain = {
      delete: () => chain,
      eq: (c: string, v: string) => (eqs.push([c, v]), chain),
      select: () => Promise.resolve({ data: [{ id: CARD }], error: null }),
    }
    vi.doMock("@/lib/supabase", () => ({ supabaseAdmin: { from: vi.fn(() => chain) } }))
    vi.doMock("@/lib/auth/supabase-server", () => ({ requireUser: vi.fn(async () => ({ id: "u1" })) }))
    const route = await import("@/app/api/physical/holdings/route")
    const { NextRequest } = await import("next/server")
    const res = await route.DELETE(new NextRequest("https://x.test/api/physical/holdings", { method: "DELETE", body: JSON.stringify({ id: CARD }) }))
    expect(res.status).toBe(200)
    expect(eqs).toEqual([["id", CARD], ["user_id", "u1"]])
  })
  function onDb(from: () => unknown, user: { id: string } | Response = { id: "u1" }) {
    process.env.PHYSICAL_CARDS = "1"
    process.env.HCI_API_KEY = "k"
    vi.doMock("@/lib/supabase", () => ({ supabaseAdmin: { from: vi.fn(from) } }))
    vi.doMock("@/lib/auth/supabase-server", () => ({
      requireUser: vi.fn(async () => {
        if (user instanceof Response) throw user
        return user
      }),
    }))
  }
  const VALID = { cardId: CARD, grader: "psa", grade: "10", certNumber: "12345678" }
  /** A from() that answers the per-user count read first, then the insert. */
  function postDb(held: { count: number | null; error?: unknown }, insert: { data?: unknown; error?: unknown }, seen: { row?: Record<string, unknown>; inserts: number } = { inserts: 0 }) {
    const chain = {
      select: (_c: string, opts?: { head?: boolean }) => (opts?.head ? { eq: () => Promise.resolve({ data: null, count: held.count, error: held.error ?? null }) } : chain),
      insert: (row: Record<string, unknown>) => ((seen.row = row), seen.inserts++, chain),
      single: () => Promise.resolve({ data: insert.data ?? null, error: insert.error ?? null }),
    }
    return { from: () => chain, seen }
  }
  const req = async (m: string, body?: unknown) => {
    const { NextRequest } = await import("next/server")
    return new NextRequest("https://x.test/api/physical/holdings", { method: m, body: body === undefined ? undefined : JSON.stringify(body) })
  }

  it("lists only the signed-in user's holdings", async () => {
    const eqs: [string, string][] = []
    const rows = [{ id: "h1" }]
    const chain = {
      select: () => chain,
      eq: (c: string, v: string) => (eqs.push([c, v]), chain),
      order: () => chain,
      limit: () => Promise.resolve({ data: rows, error: null }),
    }
    onDb(() => chain)
    const route = await import("@/app/api/physical/holdings/route")
    const res = await route.GET()
    expect(res.status).toBe(200)
    // No count came back, and a short page proves the list is whole.
    expect(await res.json()).toEqual({ holdings: rows, complete: true, total: null })
    expect(eqs).toEqual([["user_id", "u1"]])
  })

  it("says a cut-off list is incomplete (review finding 4)", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `h${i}` }))
    let count: number | null = 1500
    const chain = { select: () => chain, eq: () => chain, order: () => chain, limit: () => Promise.resolve({ data: rows, error: null, count }) }
    onDb(() => chain)
    const route = await import("@/app/api/physical/holdings/route")
    expect(await (await route.GET()).json()).toMatchObject({ complete: false, total: 1500 })
    count = null // a full page with no count cannot claim to be whole
    expect(await (await route.GET()).json()).toMatchObject({ complete: false, total: null })
  })

  it("a failed list read is an error, never an empty portfolio", async () => {
    const chain = { select: () => chain, eq: () => chain, order: () => chain, limit: () => Promise.resolve({ data: null, error: { message: "boom", code: "57014" } }) }
    onDb(() => chain)
    const route = await import("@/app/api/physical/holdings/route")
    const res = await route.GET()
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(await res.json()).not.toHaveProperty("holdings")
  })

  it("passes an auth refusal through on GET and writes nothing on POST", async () => {
    const from = vi.fn(() => { throw new Error("no db without a user") })
    onDb(from, new Response("no", { status: 401 }))
    const route = await import("@/app/api/physical/holdings/route")
    expect((await route.GET()).status).toBe(401)
    expect((await route.POST(await req("POST", VALID))).status).toBe(401)
    expect((await route.DELETE(await req("DELETE", { id: CARD }))).status).toBe(401)
    expect(from).not.toHaveBeenCalled()
  })

  it("adds a holding under the session's user_id, never the body's", async () => {
    const db = postDb({ count: 3 }, { data: { id: "new-id" } })
    onDb(db.from)
    const route = await import("@/app/api/physical/holdings/route")
    const res = await route.POST(await req("POST", { ...VALID, user_id: "someone-else" }))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: "new-id" })
    expect(db.seen.row).toMatchObject({ user_id: "u1", card_id: CARD, grader: "psa", grade: "10", cert_number: "12345678" })
  })

  it("409s a duplicate slab and 5xxs any other insert error", async () => {
    let err: { code: string; message: string } = { code: "23505", message: "dup" }
    const chain = {
      select: (_c: string, opts?: { head?: boolean }) => (opts?.head ? { eq: () => Promise.resolve({ count: 0, error: null }) } : chain),
      insert: () => chain,
      single: () => Promise.resolve({ data: null, error: err }),
    }
    onDb(() => chain)
    const route = await import("@/app/api/physical/holdings/route")
    expect((await route.POST(await req("POST", VALID))).status).toBe(409)
    err = { code: "XX000", message: "boom" }
    const res = await route.POST(await req("POST", VALID))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(await res.json()).not.toHaveProperty("id")
  })

  it("refuses an add at the row cap without inserting (review finding 4)", async () => {
    const db = postDb({ count: 1000 }, { data: { id: "x" } })
    onDb(db.from)
    const route = await import("@/app/api/physical/holdings/route")
    const res = await route.POST(await req("POST", VALID))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/up to 1000/)
    expect(db.seen.inserts).toBe(0)
  })

  it("an unreadable count refuses the add, never inserts past an unknown cap", async () => {
    const db = postDb({ count: null, error: { message: "boom", code: "57014" } }, { data: { id: "x" } })
    onDb(db.from)
    const route = await import("@/app/api/physical/holdings/route")
    const res = await route.POST(await req("POST", VALID))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(db.seen.inserts).toBe(0)
  })

  it("maps a catalogue miss to 400 and the DB row cap to 409 (review finding 5)", async () => {
    const route = await (async () => {
      onDb(postDb({ count: 0 }, { error: { code: "23503", message: "fk" } }).from)
      return import("@/app/api/physical/holdings/route")
    })()
    expect((await route.POST(await req("POST", VALID))).status).toBe(400)
    vi.resetModules()
    onDb(postDb({ count: 999 }, { error: { code: "P0001", message: "physical_holdings row cap reached" } }).from)
    const route2 = await import("@/app/api/physical/holdings/route")
    expect((await route2.POST(await req("POST", VALID))).status).toBe(409)
  })

  it("400s a non-JSON add and a delete without a uuid", async () => {
    noDb()
    vi.doMock("@/lib/auth/supabase-server", () => ({ requireUser: vi.fn() }))
    process.env.PHYSICAL_CARDS = "1"
    process.env.HCI_API_KEY = "k"
    const route = await import("@/app/api/physical/holdings/route")
    const { NextRequest } = await import("next/server")
    expect((await route.POST(new NextRequest("https://x.test/a", { method: "POST", body: "not json" }))).status).toBe(400)
    expect((await route.DELETE(new NextRequest("https://x.test/a", { method: "DELETE", body: "not json" }))).status).toBe(400)
    expect((await route.DELETE(await req("DELETE", { id: "x" }))).status).toBe(400)
  })

  it("deleting nothing is a 404, not ok (review finding 6)", async () => {
    const chain = { delete: () => chain, eq: () => chain, select: () => Promise.resolve({ data: [], error: null }) }
    onDb(() => chain)
    const route = await import("@/app/api/physical/holdings/route")
    const res = await route.DELETE(await req("DELETE", { id: CARD }))
    expect(res.status).toBe(404)
    expect(await res.json()).not.toHaveProperty("ok")
  })

  it("a failed delete is an error, not ok", async () => {
    const chain = { delete: () => chain, eq: () => chain, select: () => Promise.resolve({ data: null, error: { message: "boom", code: "XX000" } }) }
    onDb(() => chain)
    const route = await import("@/app/api/physical/holdings/route")
    const res = await route.DELETE(await req("DELETE", { id: CARD }))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(await res.json()).not.toHaveProperty("ok")
  })
})
