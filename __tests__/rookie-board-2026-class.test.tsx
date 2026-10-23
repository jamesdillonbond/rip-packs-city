// @vitest-environment jsdom
// The Rookie Board carries the 2026 class (2026-10-22): the view gained a
// `rookie_class` column, the fetcher filters on it, the API answers ?class= and
// refuses an unknown one, and the page's CLASS tab shows one class at a time.
//
// It also pins the page read size: the board fetched `limit: 500` while the view
// held 551 rows, silently dropping its 51 lowest-FMV editions.

import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { fetchRookieEditionBoard, normalizeRow } from "@/lib/rookie-edition-board"
import RookieBoardClient from "@/app/insights/rookie-board/RookieBoardClient"

function client() {
  const calls: Array<{ m: string; args: any[] }> = []
  const b: any = {}
  for (const m of ["select", "eq", "gt", "order", "limit"]) b[m] = (...args: any[]) => (calls.push({ m, args }), b)
  b.then = (res: (r: any) => any) => res({ data: [], error: null })
  return { from: () => b, calls }
}

afterEach(() => cleanup())

describe("fetchRookieEditionBoard rookieClass", () => {
  it("filters on rookie_class when a class is given, and not otherwise", async () => {
    const a = client()
    await fetchRookieEditionBoard(a, { mode: "board", sort: "fmv", limit: 10, rookieClass: "2026" })
    expect(a.calls).toContainEqual({ m: "eq", args: ["rookie_class", "2026"] })
    const b = client()
    await fetchRookieEditionBoard(b, { mode: "board", sort: "fmv", limit: 10 })
    expect(b.calls.some((c) => c.m === "eq" && c.args[0] === "rookie_class")).toBe(false)
  })

  it("normalizeRow carries rookie_class through", () => {
    expect(normalizeRow({ player_name: "Darryn Peterson", rookie_class: "2026" }).rookie_class).toBe("2026")
  })
})

describe("GET /api/public/insights/rookie-board?class=", () => {
  it("an unknown class is a 400", async () => {
    vi.resetModules()
    vi.doMock("@/lib/supabase", () => ({ supabaseAdmin: {}, supabase: {} }))
    vi.doMock("@/lib/rookie-edition-board", () => ({ fetchRookieEditionBoard: async () => [] }))
    const { GET } = await import("@/app/api/public/insights/rookie-board/route")
    const u = "https://t/api/public/insights/rookie-board?class=2024"
    const res = await GET({ url: u, nextUrl: new URL(u) } as any)
    expect(res.status).toBe(400)
    const ok = "https://t/api/public/insights/rookie-board?class=2026"
    const res2 = await GET({ url: ok, nextUrl: new URL(ok) } as any)
    expect(res2.status).toBe(200)
    expect((await res2.json()).meta.filters.class).toBe("2026")
    vi.doUnmock("@/lib/supabase")
    vi.doUnmock("@/lib/rookie-edition-board")
  })
})

describe("RookieBoardClient CLASS tab", () => {
  const row = (player_name: string, rookie_class: string | null) =>
    normalizeRow({
      player_name, rookie_class, set_name: "Rookie Debut", tier: "COMMON", parallel_id: 0,
      parallel_name: "Standard", external_id: `${player_name}:1`, circulation_count: 500,
      fmv_usd: 100, has_full_economics: true,
    })

  it("shows one class at a time, 2025 by default; a classless row counts as 2025", () => {
    const rows = [row("Cooper Flagg", "2025"), row("Dylan Harper", null), row("Darryn Peterson", "2026")]
    const { getAllByText, queryAllByText, getByText } = render(
      <RookieBoardClient initialRows={rows} initialFetchedAt="2026-10-23T05:00:00Z" />,
    )
    expect(getAllByText(/Cooper Flagg/).length).toBeGreaterThan(0)
    expect(getAllByText(/Dylan Harper/).length).toBeGreaterThan(0)
    expect(queryAllByText(/Darryn Peterson/)).toHaveLength(0)
    fireEvent.click(getByText("2026 class"))
    expect(getAllByText(/Darryn Peterson/).length).toBeGreaterThan(0)
    expect(queryAllByText(/Cooper Flagg/)).toHaveLength(0)
  })
})

describe("the page reads the whole board", () => {
  it("asks for 1000 rows, not 500 (the view held 551 on 2026-10-22)", () => {
    const src = stripComments(readFileSync("app/insights/rookie-board/page.tsx", "utf8"))
    expect(src).toMatch(/limit:\s*1000/)
    expect(src).not.toMatch(/limit:\s*500\b/)
  })
})
