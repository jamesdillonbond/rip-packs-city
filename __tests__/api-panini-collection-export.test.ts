import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * GET /api/panini-collection/export — the full-collection CSV (2026-10-26).
 * ALL OR NOTHING: a failed page is a 503, never a partial file that reads as the
 * whole collection; an unseen username is "not seen", never an empty file.
 */

type Page = { data: unknown; error: unknown }
const state: { pages: Page[] } = { pages: [] }
const calls: Record<string, unknown>[] = []
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, ...args })
      const next = state.pages.shift() ?? { data: null, error: { message: "no more pages scripted" } }
      return { then: (resolve: any) => resolve(next) }
    },
  },
}))

import { GET } from "@/app/api/panini-collection/export/route"
import { EXPORT_DEADLINE_MS, EXPORT_PAGE_TIMEOUT_MS } from "@/lib/panini/collection-export"

const req = (qs: string) => ({ nextUrl: new URL("https://t/api/panini-collection/export" + qs) }) as any
function row(i: number, over: Record<string, unknown> = {}) {
  return {
    sku: `sku-${String(i).padStart(6, "0")}`, edition_key: "packcard-1_2_3_4", player: "Caitlin Clark", set: "Base", sport: "WOMENS BASKETBALL",
    serial: i, mint_cap: 99, is_listed: false, ask_usd: null, last_sale_usd: null, last_sale_at: null,
    is_number_one: false, is_jersey_mint: false, is_perfect_mint: false, catalogued: true, fmv_usd: 12.5, ...over,
  }
}
const pageOf = (from: number, n: number, source = "profile") => ({ data: { username: "spinotron", source, rows: Array.from({ length: n }, (_, k) => row(from + k)) }, error: null })

beforeEach(() => { state.pages = []; calls.length = 0 })

describe("GET /api/panini-collection/export", () => {
  it("pages every card on the sku keyset and returns ONE CSV with all of them", async () => {
    state.pages = [pageOf(0, 1000), pageOf(1000, 1000), pageOf(2000, 7)]
    const res = await GET(req("?username=Spinotron"))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toMatch(/text\/csv/)
    expect(res.headers.get("content-disposition")).toContain("panini-spinotron-profile-all.csv")
    const lines = (await res.text()).split("\n")
    expect(lines).toHaveLength(1 + 2007)
    expect(calls.map((c) => c.p_after_sku)).toEqual([null, "sku-000999", "sku-001999"])
    expect(lines[1]).toContain('"WNBA"')
    expect(lines[0]).not.toMatch(/confidence/i)
  })

  it("a page that fails mid-export is a 503 — never a partial file", async () => {
    state.pages = [pageOf(0, 1000), { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } }]
    const res = await GET(req("?username=spinotron"))
    expect(res.status).toBe(503)
    expect(res.headers.get("content-type")).not.toMatch(/text\/csv/)
  })

  it("all pages share ONE deadline under maxDuration: past it the export is a retryable 503, never partial (2026-10-27)", async () => {
    const t0 = Date.now()
    const now = vi.spyOn(Date, "now").mockReturnValue(t0)
    state.pages = [pageOf(0, 1000), pageOf(1000, 1000), pageOf(2000, 5)]
    // The first page "takes" the whole deadline.
    const orig = state.pages[0]
    state.pages[0] = { ...orig, get data() { now.mockReturnValue(t0 + EXPORT_DEADLINE_MS + 1); return (orig as Page).data } } as Page
    const res = await GET(req("?username=spinotron"))
    now.mockRestore()
    expect(res.status).toBe(503)
    expect(res.headers.get("content-type")).not.toMatch(/text\/csv/)
    expect(calls).toHaveLength(1) // no further page was asked for
  })

  it("the per-page bound is wider than a page render's (a download the collector asked for)", () => {
    expect(EXPORT_PAGE_TIMEOUT_MS).toBeGreaterThan(8_000)
    expect(EXPORT_DEADLINE_MS).toBeLessThan(60_000) // inside maxDuration
  })

  it("a source that changes between pages (a walk landed) is refused, never a mixed file", async () => {
    state.pages = [pageOf(0, 1000, "seen"), pageOf(1000, 3, "profile")]
    const res = await GET(req("?username=spinotron"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(res.headers.get("content-type")).not.toMatch(/text\/csv/)
  })

  it("an unseen username is a 404 that says 'not seen', never an empty CSV", async () => {
    state.pages = [{ data: { username: "nobody1", source: "seen", rows: [] }, error: null }]
    const res = await GET(req("?username=nobody1"))
    expect(res.status).toBe(404)
    const j = await res.json()
    expect(j.error).toMatch(/does not mean the collector holds nothing/)
  })

  it("an unpriced card exports an EMPTY FMV cell, never 0, and a seen export says so in its filename", async () => {
    state.pages = [{ data: { username: "adlcards", source: "seen", rows: [row(1, { fmv_usd: null, catalogued: false })] }, error: null }]
    const res = await GET(req("?username=adlcards"))
    expect(res.headers.get("content-disposition")).toContain("seen-by-rpc")
    const line = (await res.text()).split("\n")[1]
    expect(line).not.toMatch(/"0(\.00)?"/)
    expect(line).not.toContain("/edition/")
  })

  it("a malformed username is a 400, and no read is made", async () => {
    const res = await GET(req("?username=" + encodeURIComponent("a b<script>")))
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it("a collection past the cap is refused with 413 — never truncated", async () => {
    state.pages = Array.from({ length: 41 }, (_, k) => pageOf(k * 1000, 1000))
    const res = await GET(req("?username=spinotron"))
    expect(res.status).toBe(413)
    expect((await res.json()).code).toBe("too_large")
  })
})
