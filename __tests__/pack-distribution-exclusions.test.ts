import { describe, it, expect, beforeEach, vi } from "vitest"

// Dapper-internal pack distributions ("NFL Pack Hold", "Pack Test 2", "Do Not
// Use") leave the packs board and the sitemap; legitimate packs never do.
// lib/packs/distribution-exclusions.ts + app/api/packs/route.ts.

const ALLDAY = "dee28451-5d62-409e-a1ad-a83f763ac070"
const TOPSHOT = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

// A recording stub: each table answers from `tables`, and every filter call is
// logged so the test can assert what the QUERY excluded (not a post-filter).
const tables: Record<string, { data: any; count?: any; error?: any } | "throw"> = {}
const calls: Array<{ table: string; op: string; args: unknown[] }> = []
vi.mock("@supabase/supabase-js", () => {
  const builder = (table: string) => {
    const payload = () => {
      const t = tables[table]
      if (t === "throw") return Promise.reject(new Error("socket hang up"))
      return Promise.resolve(t ?? { data: [], count: 0, error: null })
    }
    const b: any = {}
    for (const op of ["select", "eq", "in", "ilike", "not", "order", "limit", "gte", "or"]) {
      b[op] = (...args: unknown[]) => { calls.push({ table, op, args }); return b }
    }
    b.then = (res: any, rej: any) => payload().then(res, rej)
    return b
  }
  return { createClient: () => ({ from: (t: string) => builder(t) }) }
})

import { createClient } from "@supabase/supabase-js"
import { isExcluded, readPackExclusions, PACK_EXCLUSIONS_VIEW } from "@/lib/packs/distribution-exclusions"
import { GET } from "@/app/api/packs/route"

const db = createClient("u", "k")
const req = (url: string) => ({ nextUrl: new URL(url), url }) as any

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  calls.length = 0
})

describe("readPackExclusions", () => {
  it("reads the RE-DERIVING view, never the raw table, and groups dist ids by collection", async () => {
    tables[PACK_EXCLUSIONS_VIEW] = { data: [
      { collection_id: ALLDAY, dist_id: "6818" },
      { collection_id: ALLDAY, dist_id: "6229" },
      { collection_id: TOPSHOT, dist_id: "1" },
    ], error: null }
    const ex = await readPackExclusions(db, [ALLDAY, TOPSHOT])
    expect(calls.every((c) => c.table === PACK_EXCLUSIONS_VIEW)).toBe(true)
    expect(calls.find((c) => c.op === "in")?.args).toEqual(["collection_id", [ALLDAY, TOPSHOT]])
    expect(ex.ok).toBe(true)
    expect([...(ex.byCollection.get(ALLDAY) ?? [])].sort()).toEqual(["6229", "6818"])
  })

  it("scopes an exclusion to its collection — All Day 6818 says nothing about Top Shot 6818", async () => {
    tables[PACK_EXCLUSIONS_VIEW] = { data: [{ collection_id: ALLDAY, dist_id: "6818" }], error: null }
    const ex = await readPackExclusions(db)
    expect(isExcluded(ex, ALLDAY, "6818")).toBe(true)
    expect(isExcluded(ex, TOPSHOT, "6818")).toBe(false)
    expect(isExcluded(ex, ALLDAY, "5975")).toBe(false)
    expect(isExcluded(ex, null, "6818")).toBe(false)
  })

  it("FAILS OPEN on an error or a throw: ok=false and nothing excluded", async () => {
    tables[PACK_EXCLUSIONS_VIEW] = { data: null, error: { message: "relation does not exist" } }
    const a = await readPackExclusions(db)
    expect(a).toMatchObject({ ok: false })
    expect(a.error).toMatch(/does not exist/)
    expect(a.byCollection.size).toBe(0)

    tables[PACK_EXCLUSIONS_VIEW] = "throw"
    const b = await readPackExclusions(db)
    expect(b.ok).toBe(false)
    expect(b.byCollection.size).toBe(0)
  })
})

describe("GET /api/packs — internal distributions", () => {
  it("excludes this collection's internal dists IN THE QUERY, so total and limit count only real packs", async () => {
    tables[PACK_EXCLUSIONS_VIEW] = { data: [{ collection_id: ALLDAY, dist_id: "6818" }, { collection_id: ALLDAY, dist_id: "6229" }], error: null }
    tables.pack_table_rows = { data: [], count: 0, error: null }
    const res = await GET(req("https://t/api/packs?collection=nfl-all-day"))
    expect(res.status).toBe(200)

    expect(calls.find((c) => c.table === PACK_EXCLUSIONS_VIEW && c.op === "in")?.args).toEqual(["collection_id", [ALLDAY]])
    const notIn = calls.find((c) => c.table === "pack_table_rows" && c.op === "not" && c.args[0] === "dist_id")
    expect(notIn?.args[1]).toBe("in")
    expect(String(notIn?.args[2])).toMatch(/^\(.*\)$/)
    expect(String(notIn?.args[2])).toContain('"6818"')
    expect(String(notIn?.args[2])).toContain('"6229"')

    const body = await res.json()
    expect(body).toMatchObject({ internal_excluded: 2, internal_exclusions_ok: true })
  })

  it("a failed exclusion read shows EVERY pack (no dist filter) and says so", async () => {
    tables[PACK_EXCLUSIONS_VIEW] = { data: null, error: { message: "timeout" } }
    tables.pack_table_rows = { data: [], count: 0, error: null }
    const res = await GET(req("https://t/api/packs?collection=nfl-all-day"))
    expect(res.status).toBe(200)
    expect(calls.some((c) => c.table === "pack_table_rows" && c.op === "not" && c.args[0] === "dist_id")).toBe(false)
    expect(await res.json()).toMatchObject({ internal_excluded: 0, internal_exclusions_ok: false })
  })

  it("no exclusions for a collection adds no dist filter (no-change control)", async () => {
    tables[PACK_EXCLUSIONS_VIEW] = { data: [], error: null }
    tables.pack_table_rows = { data: [], count: 0, error: null }
    await GET(req("https://t/api/packs?collection=nba-top-shot"))
    expect(calls.some((c) => c.table === "pack_table_rows" && c.op === "not" && c.args[0] === "dist_id")).toBe(false)
  })
})
