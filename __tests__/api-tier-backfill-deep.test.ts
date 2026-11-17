import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Deep drive of GET /api/tier-backfill. Unlike the cron routes, this one is
// SYNCHRONOUS — it returns the full result envelope directly — so we assert on the
// response body. The sibling test only pins the 401. Here we drive the real body:
// the candidate select, the concurrent per-moment GQL tier fetch (ok vs fail), the
// formatTier normalization (Ultimate/Legendary/Rare/Fandom/else→COMMON, null→COMMON),
// the per-edition HIGHEST-tier dedup (tierPriority), the edition update ok/error
// tally, the remaining-count "complete" hint, and the fetch-error early exits.

let supaState: any
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      let op: "select" | "update" = "select"
      let countReq = false
      const b: any = {
        select: (_cols: string, opts?: any) => { op = "select"; if (opts?.count) countReq = true; return b },
        update: () => { op = "update"; return b },
        eq: () => b,
        is: () => b,
        order: () => b,
        range: () => b,
        then: (resolve: any) => {
          if (table === "wallet_moments_cache" && op === "select" && countReq) return resolve(supaState.remaining)
          if (table === "wallet_moments_cache" && op === "select") return resolve(supaState.candidate)
          if (table === "wallet_moments_cache" && op === "update") return resolve(supaState.wmcUpdate)
          if (table === "editions" && op === "update") return resolve(supaState.editionUpdate)
          return resolve({ data: null, error: null })
        },
      }
      return b
    },
  }),
}))

import { GET } from "@/app/api/tier-backfill/route"

const url = "https://t/api/tier-backfill"
const req = (qs = "") => {
  const u = new URL(url + qs)
  return { nextUrl: u, url: u.toString(), headers: new Headers() } as any
}

// GQL fixture: momentId -> tier string (or null); an id absent from the map or
// listed in `fetchFail` throws (HTTP not-ok) so the row lands in `failed`.
const gqlTier: Record<string, string | null> = {}
const fetchFail = new Set<string>()

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
    const id = JSON.parse(init.body).variables.id
    if (fetchFail.has(id)) return { ok: false, status: 503, json: async () => ({}) }
    return {
      ok: true,
      json: async () => ({ data: { getMintedMoment: { data: { tier: gqlTier[id] ?? null, createdAt: "2026-01-01" } } } }),
    }
  }))
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "tok"
  supaState = {
    candidate: { data: [], error: null },
    wmcUpdate: { data: null, error: null },
    editionUpdate: { error: null },
    remaining: { count: 0 },
  }
  for (const k of Object.keys(gqlTier)) delete gqlTier[k]
  fetchFail.clear()
  installFetch()
})
afterEach(() => vi.unstubAllGlobals())

describe("GET /api/tier-backfill", () => {
  it("401 without the right token", async () => {
    expect((await GET(req("?token=nope"))).status).toBe(401)
  })

  it("candidate-select error → 500 with the message", async () => {
    supaState.candidate = { data: null, error: { message: "pool timeout" } }
    const res = await GET(req("?token=tok"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("pool timeout")
  })

  it("no unresolved rows → 'backfill complete', total 0", async () => {
    supaState.candidate = { data: [], error: null }
    const body = await (await GET(req("?token=tok"))).json()
    expect(body.total).toBe(0)
    expect(body.message).toContain("backfill complete")
  })

  it("happy path: normalizes tiers, dedups to highest per edition, updates, reports complete", async () => {
    supaState.candidate = {
      data: [
        { moment_id: "m1", edition_key: "e1" }, // Ultimate
        { moment_id: "m2", edition_key: "e1" }, // common — ULTIMATE must win for e1
        { moment_id: "m3", edition_key: "e2" }, // Legendary
        { moment_id: "m4", edition_key: "e3" }, // Rare
        { moment_id: "m5", edition_key: "e4" }, // Fandom
        { moment_id: "m6", edition_key: "e5" }, // "weird" → COMMON fallback
        { moment_id: "m7", edition_key: null }, // null tier + null edition → skipped in map
        { moment_id: "m8", edition_key: "e6" }, // GQL fails → failed, not updated
      ],
      error: null,
    }
    Object.assign(gqlTier, {
      m1: "Ultimate Series", m2: "common", m3: "Legendary", m4: "Rare",
      m5: "Fandom", m6: "weird-unknown", m7: null,
    })
    fetchFail.add("m8")
    supaState.remaining = { count: 0 }

    const body = await (await GET(req("?token=tok&offset=0&limit=50"))).json()

    expect(body.processed).toBe(8)
    expect(body.successful).toBe(7) // m1..m7 (m7's null tier still resolves ok)
    expect(body.failed).toBe(1) // m8
    // e1..e5 = 5 distinct editions (null edition_key on m7 skipped)
    expect(body.editionKeysProcessed).toBe(5)
    expect(body.editionUpdated).toBe(5)
    expect(body.editionErrors).toBe(0)
    expect(body.remainingInCache).toBe(0)
    expect(body.hint).toContain("All moments processed")
    expect(body.nextOffset).toBe(50)
  })

  it("edition update errors are tallied into editionErrors", async () => {
    supaState.candidate = { data: [{ moment_id: "m1", edition_key: "e1" }], error: null }
    gqlTier.m1 = "Legendary"
    supaState.editionUpdate = { error: { message: "conflict" } }
    supaState.remaining = { count: 4 }

    const body = await (await GET(req("?token=tok"))).json()
    expect(body.editionErrors).toBe(1)
    expect(body.editionUpdated).toBe(0)
    // remaining>0 → the hint tells the operator to run again
    expect(body.hint).toContain("Run again")
    expect(body.remainingInCache).toBe(4)
  })

  it("all GQL fetches failing → 0 successful, every row in failed, no edition updates", async () => {
    supaState.candidate = { data: [{ moment_id: "m1", edition_key: "e1" }, { moment_id: "m2", edition_key: "e2" }], error: null }
    fetchFail.add("m1"); fetchFail.add("m2")

    const body = await (await GET(req("?token=tok"))).json()
    expect(body.successful).toBe(0)
    expect(body.failed).toBe(2)
    expect(body.editionKeysProcessed).toBe(0)
  })
})
