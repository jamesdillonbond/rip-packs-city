import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"

// Route integration test for GET /api/wallet-packs. Requires ?wallet= → 400
// before any upstream work. A raw 0x address skips username resolution; a
// username is resolved to a flowAddress via topshotGraphql first.
//
// 2026-11-18 (#218): Studio GraphQL is HTTP 530, so sealed counts come from Atlas
// PackService/GetPackCountsByOwnerGroupedByDistribution through pg_net
// (atlas_wallet_pack_counts_begin + atlas_await_response), and titles from our
// pack_distributions. Every property the Studio-era test pinned is re-pinned here:
// aggregation by dist + title, collection scoping, the refusal of an unreadable
// collection, username resolution, and that a failed read is never an empty wallet.

const gql: { flowAddress: string | null; throwErr: Error | null } = { flowAddress: null, throwErr: null }
vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async () => {
    if (gql.throwErr) throw gql.throwErr
    return { getUserProfileByUsername: { publicInfo: { flowAddress: gql.flowAddress } } }
  },
}))

type Env = { ok: boolean; body?: unknown; status?: number | null; error?: string }
const db = vi.hoisted(() => ({
  begins: [] as Array<{ p_wallet: string; p_product: string }>,
  envs: [] as Env[],
  beginError: null as { message: string } | null,
  titles: [] as Array<{ dist_id: string; title: string | null }>,
  titleFilter: { collection_id: null as string | null, dist_ids: null as string[] | null },
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: any) => {
      if (fn === "atlas_wallet_pack_counts_begin") {
        db.begins.push(args)
        return db.beginError ? { data: null, error: db.beginError } : { data: 1000 + db.begins.length, error: null }
      }
      if (fn === "atlas_await_response") {
        const env = db.envs.shift() ?? { ok: false, status: null, error: "timeout" }
        return { data: env, error: null }
      }
      // Anything else (the username resolver's cache / live-Atlas legs) is unavailable here, so the
      // resolver falls through to the mocked Top Shot profile lookup, as it did before this port.
      return { data: null, error: { message: `rpc ${fn} not mocked` } }
    },
    from: (table: string) => {
      if (table !== "pack_distributions") throw new Error(`unexpected table ${table}`)
      const q: any = {
        select: () => q,
        eq: (_c: string, v: string) => { db.titleFilter.collection_id = v; return q },
        in: (_c: string, v: string[]) => {
          db.titleFilter.dist_ids = v
          return Promise.resolve({ data: db.titles.filter((t) => v.includes(t.dist_id)), error: null })
        },
      }
      return q
    },
  },
}))

import { GET } from "@/app/api/wallet-packs/route"

const req = (u: string) => ({ url: u }) as any
const counts = (rows: Array<[string, number]>): Env => ({
  ok: true,
  body: { distributionPackCounts: rows.map(([d, n]) => ({ distributionId: d, sealedCount: String(n), openedCount: "4" })) },
})

beforeEach(() => {
  gql.flowAddress = null
  gql.throwErr = null
  db.begins = []
  db.envs = []
  db.beginError = null
  db.titles = []
  db.titleFilter = { collection_id: null, dist_ids: null }
})
afterEach(() => vi.unstubAllGlobals())

describe("GET /api/wallet-packs", () => {
  it("400s without a wallet param", async () => {
    const res = await GET(req("https://t/api/wallet-packs"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("wallet param required")
  })

  it("aggregates SEALED counts by dist and title (opened/revealed are not holdings)", async () => {
    db.envs.push(counts([["d1", 2], ["d2", 0], ["d3", 1]]))
    db.titles = [{ dist_id: "d1", title: "Pack A" }, { dist_id: "d3", title: "Pack C" }]
    const res = await GET(req("https://t/api/wallet-packs?wallet=0xbd94cade097e50ac"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.walletAddress).toBe("0xbd94cade097e50ac")
    expect(body.totalSealedPacks).toBe(3)
    expect(body.owned).toEqual({ d1: 2, d3: 1 })
    expect(body.packsByTitle).toEqual({ "Pack A": 2, "Pack C": 1 })
    expect(db.begins).toEqual([{ p_wallet: "0xbd94cade097e50ac", p_product: "nba" }])
  })

  it("a dist we hold no title for still counts, but is not invented into packsByTitle", async () => {
    db.envs.push(counts([["d7", 3]]))
    const body = await (await GET(req("https://t/api/wallet-packs?wallet=0xbd94cade097e50ac"))).json()
    expect(body.totalSealedPacks).toBe(3)
    expect(body.owned).toEqual({ d7: 3 })
    expect(body.packsByTitle).toEqual({})
    expect(body.error).toBeUndefined()
  })

  it("retries a Cloudflare challenge once, then reads", async () => {
    db.envs.push({ ok: false, status: 403, error: "Just a moment" }, counts([["d1", 1]]))
    db.titles = [{ dist_id: "d1", title: "Pack A" }]
    const body = await (await GET(req("https://t/api/wallet-packs?wallet=0xbd94cade097e50ac"))).json()
    expect(db.begins).toHaveLength(2)
    expect(body.totalSealedPacks).toBe(1)
  })

  it("resolves a username to a flowAddress first (adds the 0x prefix)", async () => {
    gql.flowAddress = "bd94cade097e50ac" // no 0x prefix from the profile API
    db.envs.push(counts([["d1", 1]]))
    const res = await GET(req("https://t/api/wallet-packs?wallet=@trevor"))
    expect(res.status).toBe(200)
    expect((await res.json()).walletAddress).toBe("0xbd94cade097e50ac")
    expect(db.begins[0].p_wallet).toBe("0xbd94cade097e50ac")
  })

  it("400s when a username cannot be resolved", async () => {
    gql.flowAddress = null
    const res = await GET(req("https://t/api/wallet-packs?wallet=@ghost"))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe("not_found")
    expect(body.error).toMatch(/wallet or username/i)
    expect(body.error).not.toContain("Could not resolve")
  })

  it("a failed read degrades to an empty 200 WITH an error key (never a 500, never an empty wallet)", async () => {
    db.envs.push({ ok: false, status: 503, error: "upstream rate limited" }, { ok: false, status: 503 })
    const res = await GET(req("https://t/api/wallet-packs?wallet=0xbd94cade097e50ac"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.walletAddress).toBeNull()
    expect(body.totalSealedPacks).toBe(0)
    expect(body.error).not.toContain("rate limited")
    // ⚠ THE `error` KEY IS A LOAD-BEARING CONTRACT (2026-08-29): CollectionTabClient
    // discriminates on it (`if (!d || d.error) setPacksFailed(true)`). Without it this
    // response is byte-identical to a wallet that holds no packs.
    expect(typeof body.error).toBe("string")
    expect(body.error.length).toBeGreaterThan(0)
    expect(body.packsByTitle).toEqual({})
    expect(db.begins).toHaveLength(1) // a 503 is not a challenge: no retry
  })

  it("an answer without distributionPackCounts is a failed read, not an empty wallet", async () => {
    db.envs.push({ ok: true, body: {} })
    const body = await (await GET(req("https://t/api/wallet-packs?wallet=0xbd94cade097e50ac"))).json()
    expect(typeof body.error).toBe("string")
    expect(body.error.length).toBeGreaterThan(0)
  })

  it("a begin failure is a failed read, not an empty wallet", async () => {
    db.beginError = { message: "pool timeout" }
    const body = await (await GET(req("https://t/api/wallet-packs?wallet=0xbd94cade097e50ac"))).json()
    expect(typeof body.error).toBe("string")
    expect(body.error).not.toContain("pool timeout")
  })

  // ⛔ SUBSTITUTION (2026-10-19): the read is scoped to the collection asked about.
  it("reads the product AND the titles of the collection asked about, not Top Shot's", async () => {
    db.envs.push(counts([["d9", 1]]))
    db.titles = [{ dist_id: "d9", title: "AD Pack" }]
    const res = await GET(req("https://t/api/wallet-packs?wallet=0xbd94cade097e50ac&collection=nfl-all-day"))
    expect(res.status).toBe(200)
    expect(db.begins[0].p_product).toBe("nfl")
    expect(db.titleFilter.collection_id).toBe("dee28451-5d62-409e-a1ad-a83f763ac070")
    expect((await res.json()).collection).toBe("nfl-all-day")
  })

  it("keeps the Top Shot default when the collection param is absent", async () => {
    db.envs.push(counts([]))
    await GET(req("https://t/api/wallet-packs?wallet=0xbd94cade097e50ac"))
    expect(db.begins[0].p_product).toBe("nba")
  })

  it("refuses a collection it cannot read, without answering with another's packs", async () => {
    const res = await GET(req("https://t/api/wallet-packs?wallet=0xbd94cade097e50ac&collection=disney-pinnacle"))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(db.begins).toHaveLength(0)
    expect(body.packsByTitle).toBeUndefined()
    expect(body.totalSealedPacks).toBeUndefined()
  })
})
