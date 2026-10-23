import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/packs — #207 for pack titles (2026-10-22). "clasico" found none of
// Golazos' 23 "ElClásico" packs (89 of its 224 titles carry an accent). An EMPTY
// title search is re-run ONCE with the exact accent-blind regex (`imatch`), so
// count and paging stay exact; a search that matched is never re-run.

const st = vi.hoisted(() => ({ titles: [] as string[], reads: [] as Array<{ ilike?: string; imatch?: string }> }))

vi.mock("@supabase/supabase-js", () => {
  const builder = () => {
    const f: { ilike?: string; imatch?: string } = {}
    const b: any = {
      select: () => b, eq: () => b, in: () => b, not: () => b, order: () => b, limit: () => b,
      ilike: (_c: string, p: string) => { f.ilike = p; return b },
      filter: (_c: string, op: string, v: string) => { if (op === "imatch") f.imatch = v; return b },
      then: (resolve: any) => {
        st.reads.push({ ...f })
        const rows = st.titles
          .filter((t) => (f.ilike ? t.toLowerCase().includes(f.ilike.replace(/%/g, "").toLowerCase()) : true))
          .filter((t) => (f.imatch ? new RegExp(f.imatch, "iu").test(t) : true))
          .map((title, i) => ({ dist_id: i + 1, title }))
        return resolve({ data: rows, count: rows.length, error: null })
      },
    }
    return b
  }
  return { createClient: () => ({ from: () => builder() }) }
})

import { GET } from "@/app/api/packs/route"
const req = (url: string) => ({ nextUrl: new URL(url), url }) as any

beforeEach(() => {
  st.titles = ["ElClásico Challenge 3/3 - Real Reward", "ElClásico", "Jornadas 10-18"]
  st.reads = []
})

describe("GET /api/packs — accent-blind title search", () => {
  it("'clasico' finds the ElClásico packs, with an exact total", async () => {
    const body = await (await GET(req("https://t/api/packs?collection=laliga-golazos&search=clasico"))).json()
    expect(body.rows.map((r: any) => r.title)).toEqual(["ElClásico Challenge 3/3 - Real Reward", "ElClásico"])
    expect(body.total).toBe(2)
    expect(st.reads.filter((r) => r.imatch)).toHaveLength(1)
  })

  it("a search that matched is not re-run", async () => {
    const body = await (await GET(req("https://t/api/packs?collection=laliga-golazos&search=jornadas"))).json()
    expect(body.rows).toHaveLength(1)
    expect(st.reads.some((r) => r.imatch)).toBe(false)
  })

  it("a search that truly matches nothing stays empty", async () => {
    const body = await (await GET(req("https://t/api/packs?collection=laliga-golazos&search=zzzz"))).json()
    expect(body.rows).toEqual([])
  })
})
