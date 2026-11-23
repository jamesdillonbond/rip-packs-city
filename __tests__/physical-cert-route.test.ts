import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// /api/physical/cert (unwired prototype): 404 while off, validates before auth,
// spends no paid lookup when a cap refuses, and never answers a slab it could
// not resolve. Each test installs its own mocks (see physical-holdings-route).

describe("/api/physical/cert", () => {
  const saved = { ...process.env }
  beforeEach(() => {
    vi.resetModules()
    process.env.PHYSICAL_CARDS = "1"
    process.env.HCI_API_KEY = "k"
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  async function load(opts: {
    user?: { id: string } | Response
    verdict?: { allowed: boolean; failed?: boolean }
    cert?: unknown
  }) {
    const cert = vi.fn(async () => opts.cert)
    const bump = vi.fn(async () => ({ refusedBucket: null, ...(opts.verdict ?? { allowed: true }) }))
    const requireUser = vi.fn(async () => {
      if (opts.user instanceof Response) throw opts.user
      return opts.user ?? { id: "u1" }
    })
    vi.doMock("@/lib/auth/supabase-server", () => ({ requireUser }))
    vi.doMock("@/lib/abuse/anon-rate", () => ({ bumpAnonRates: bump }))
    vi.doMock("@/lib/physical/hci-client", () => ({ HciClient: class { cert = cert } }))
    const route = await import("@/app/api/physical/cert/route")
    const { NextRequest } = await import("next/server")
    const get = (qs: string) => route.GET(new NextRequest(`https://x.test/api/physical/cert?${qs}`))
    return { get, cert, bump, requireUser }
  }

  it("404s while off, before auth or any lookup", async () => {
    delete process.env.PHYSICAL_CARDS
    const m = await load({})
    expect((await m.get("grader=psa&cert=12345678")).status).toBe(404)
    expect(m.requireUser).not.toHaveBeenCalled()
    expect(m.cert).not.toHaveBeenCalled()
  })

  it("400s an unparseable cert before auth", async () => {
    const m = await load({})
    expect((await m.get("grader=hga&cert=abc")).status).toBe(400)
    expect(m.requireUser).not.toHaveBeenCalled()
  })

  it("passes the auth refusal through and spends nothing", async () => {
    const m = await load({ user: new Response("no", { status: 401 }) })
    expect((await m.get("grader=psa&cert=12345678")).status).toBe(401)
    expect(m.bump).not.toHaveBeenCalled()
    expect(m.cert).not.toHaveBeenCalled()
  })

  it("429s at the cap and 503s when the counter itself failed, with no paid lookup", async () => {
    const capped = await load({ verdict: { allowed: false } })
    const r1 = await capped.get("grader=psa&cert=12345678")
    expect(r1.status).toBe(429)
    expect(capped.cert).not.toHaveBeenCalled()
    vi.resetModules()
    const broken = await load({ verdict: { allowed: false, failed: true } })
    const r2 = await broken.get("grader=psa&cert=12345678")
    expect(r2.status).toBe(503)
    expect(broken.cert).not.toHaveBeenCalled()
  })

  it("maps an HCI 404 to 404 and any other failure to 502", async () => {
    const nf = await load({ cert: { ok: false, status: 404, code: null } })
    expect((await nf.get("grader=psa&cert=12345678")).status).toBe(404)
    vi.resetModules()
    const down = await load({ cert: { ok: false, status: 0, code: "NETWORK" } })
    expect((await down.get("grader=psa&cert=12345678")).status).toBe(502)
  })

  it("404s a 200 that carries no grade rather than inventing a slab", async () => {
    const m = await load({ cert: { ok: true, data: {} } })
    const res = await m.get("grader=psa&cert=12345678")
    expect(res.status).toBe(404)
    expect(await res.json()).not.toHaveProperty("slab")
  })

  it("returns the resolved slab, identity only", async () => {
    const m = await load({ cert: { ok: true, data: { cert: { grade: "10", player: "P" }, card: { id: 7 }, slab: { certVerified: true } } } })
    const res = await m.get("grader=psa&cert=12345678")
    expect(res.status).toBe(200)
    const { slab } = await res.json()
    expect(slab).toMatchObject({ grader: "psa", certNumber: "12345678", grade: "10", cardId: "7", certVerified: true })
    expect(JSON.stringify(slab)).not.toMatch(/usd|price/i)
    expect(m.bump).toHaveBeenCalledWith([
      expect.objectContaining({ bucket: "physical_cert_user", key: "u1" }),
      expect.objectContaining({ bucket: "physical_cert_global", key: "*" }),
    ])
  })
})
