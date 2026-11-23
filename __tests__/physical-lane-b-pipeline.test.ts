import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { HciClient, mapHciSales } from "@/lib/physical/hci-client"
import { planRefresh, dailyBudget } from "@/lib/physical/refresh-planner"
import { refreshValues, type CacheRow } from "@/lib/physical/refresh-values"
import { physicalEnabled, certCaps } from "@/lib/physical/flags"

// Lane B pipeline (unwired): HCI mapping, quota planner, refresh job, switches,
// and the cert route's OFF and bad-input paths.

describe("mapHciSales", () => {
  it("maps graders, keeps raw, drops what it cannot name", () => {
    const rows = mapHciSales([
      { soldAt: "2026-11-01T00:00:00Z", price: 100, grade: "10", gradingCompany: "PSA", saleType: "auction" },
      { soldAt: "2026-11-02T00:00:00Z", price: 80, grade: "9.5", gradingCompany: "Beckett", saleType: "best_offer", askingPrice: 95 },
      { soldAt: "2026-11-03T00:00:00Z", price: 5, grade: null, gradingCompany: null },
      { soldAt: "2026-11-04T00:00:00Z", price: 50, grade: "9", gradingCompany: "HGA" },
      { soldAt: "bad", price: 1, grade: "10", gradingCompany: "PSA" },
    ])
    expect(rows.map((r) => [r.grader, r.grade, r.saleType])).toEqual([
      ["psa", "10", "auction"],
      ["bgs", "9.5", "best_offer"],
      ["raw", "raw", null],
    ])
    expect(rows[1].askingPrice).toBe(95)
  })
})

describe("HciClient", () => {
  it("sends the key and reports error codes", async () => {
    const seen: { url: string; key: string | null }[] = []
    const impl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, key: new Headers(init?.headers).get("X-API-Key") })
      return new Response(JSON.stringify({ error: { code: "REQUIRES_COMMERCIAL_LICENSE" } }), { status: 403 })
    }) as unknown as typeof fetch
    const r = await new HciClient("k", impl).sales("42", 90)
    expect(seen[0].url).toBe("https://hobbycardindex.com/api/v1/prices/42/sales?days=90&sample=latest")
    expect(seen[0].key).toBe("k")
    expect(r).toEqual({ ok: false, status: 403, code: "REQUIRES_COMMERCIAL_LICENSE" })
  })
})

describe("refresh planner", () => {
  const asOf = "2026-11-22T12:00:00Z"
  it("spreads the remaining quota over the month and keeps a reserve", () => {
    expect(dailyBudget({ monthlyAllowance: 5000, usedThisMonth: 1000, daysLeftInMonth: 10 })).toBe(320)
    expect(dailyBudget({ monthlyAllowance: 500, usedThisMonth: 500, daysLeftInMonth: 3 })).toBe(0)
  })
  it("prices never-priced, most-held, oldest first and skips fresh or unheld cards", () => {
    const plan = planRefresh(
      [
        { cardId: "fresh", holders: 9, lastComputedAt: "2026-11-22T06:00:00Z" },
        { cardId: "old1", holders: 1, lastComputedAt: "2026-11-01T00:00:00Z" },
        { cardId: "old5", holders: 5, lastComputedAt: "2026-11-20T00:00:00Z" },
        { cardId: "never", holders: 1, lastComputedAt: null },
        { cardId: "unheld", holders: 0, lastComputedAt: null },
      ],
      { monthlyAllowance: 5000, usedThisMonth: 0, daysLeftInMonth: 30 },
      { asOf },
    )
    expect(plan).toEqual(["never", "old5", "old1"])
  })
})

describe("refreshValues", () => {
  const asOf = "2026-11-22T00:00:00Z"
  const s = (d: number, p: number, grade = "10") => ({ soldAt: new Date(Date.parse(asOf) - d * 86_400_000).toISOString(), price: p, grader: "psa" as const, grade })
  it("writes a row per priceable grade and none for thin grades", async () => {
    const written: CacheRow[] = []
    const rep = await refreshValues(
      ["c1"],
      {
        sourceIdFor: (id) => `hci-${id}`,
        fetchSales: async () => ({ ok: true, data: [s(1, 100), s(2, 100), s(3, 110), s(4, 40, "9")] }),
        upsert: async (rows) => {
          written.push(...rows)
          return { ok: true }
        },
      },
      asOf,
    )
    expect(rep).toMatchObject({ cards: 1, rowsWritten: 1, lookupsSpent: 1 })
    expect(written[0]).toMatchObject({ card_id: "c1", grader: "psa", grade: "10", point_usd: 100, source: "HobbyCardIndex" })
  })
  it("stops on a rate limit instead of burning refusals", async () => {
    const calls: string[] = []
    const rep = await refreshValues(
      ["a", "b", "c"],
      { sourceIdFor: (id) => id, fetchSales: async (id) => (calls.push(id), { ok: false, status: 429, code: "RATE_LIMITED" }), upsert: async () => ({ ok: true }) },
      asOf,
    )
    expect(calls).toEqual(["a"])
    expect(rep.stoppedOnRateLimit).toBe(true)
  })
})

describe("switches", () => {
  it("needs both the switch and the key", () => {
    expect(physicalEnabled({})).toBe(false)
    expect(physicalEnabled({ PHYSICAL_CARDS: "1" })).toBe(false)
    expect(physicalEnabled({ PHYSICAL_CARDS: "1", HCI_API_KEY: "k" })).toBe(true)
    expect(certCaps({})).toEqual({ perUser: 10, global: 5 })
    expect(certCaps({ PHYSICAL_CERT_GLOBAL_DAILY: "abc" }).global).toBe(5)
  })
})

describe("GET /api/physical/cert", () => {
  const saved = { ...process.env }
  beforeEach(() => vi.resetModules())
  afterEach(() => {
    process.env = { ...saved }
  })

  it("404s while the feature is off, before any auth or lookup", async () => {
    delete process.env.PHYSICAL_CARDS
    vi.doMock("@/lib/auth/supabase-server", () => ({ requireUser: vi.fn(() => { throw new Error("must not be called") }) }))
    vi.doMock("@/lib/abuse/anon-rate", () => ({ bumpAnonRates: vi.fn() }))
    const { GET } = await import("@/app/api/physical/cert/route")
    const { NextRequest } = await import("next/server")
    const res = await GET(new NextRequest("https://x.test/api/physical/cert?grader=psa&cert=12345678"))
    expect(res.status).toBe(404)
  })

  it("400s on a malformed cert before spending a lookup", async () => {
    process.env.PHYSICAL_CARDS = "1"
    process.env.HCI_API_KEY = "k"
    const bump = vi.fn()
    vi.doMock("@/lib/auth/supabase-server", () => ({ requireUser: vi.fn() }))
    vi.doMock("@/lib/abuse/anon-rate", () => ({ bumpAnonRates: bump }))
    const { GET } = await import("@/app/api/physical/cert/route")
    const { NextRequest } = await import("next/server")
    const res = await GET(new NextRequest("https://x.test/api/physical/cert?grader=psa&cert=12ab"))
    expect(res.status).toBe(400)
    expect(bump).not.toHaveBeenCalled()
  })

  it("refuses when the counter refuses, and never calls the feed", async () => {
    process.env.PHYSICAL_CARDS = "1"
    process.env.HCI_API_KEY = "k"
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    vi.doMock("@/lib/auth/supabase-server", () => ({ requireUser: vi.fn(async () => ({ id: "u1" })) }))
    vi.doMock("@/lib/abuse/anon-rate", () => ({ bumpAnonRates: vi.fn(async () => ({ allowed: false, failed: false, count: 11, refusedBucket: "physical_cert_user" })) }))
    const { GET } = await import("@/app/api/physical/cert/route")
    const { NextRequest } = await import("next/server")
    const res = await GET(new NextRequest("https://x.test/api/physical/cert?grader=psa&cert=12345678"))
    expect(res.status).toBe(429)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
