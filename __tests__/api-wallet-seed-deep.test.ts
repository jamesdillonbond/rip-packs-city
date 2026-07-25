import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Deep drive of POST /api/wallet/seed (the sibling test only pins auth). This
// route walks the 5 Flow collections, fetches on-chain moment IDs via the Flow
// REST script API, enriches them (standard editions vs the Pinnacle path), builds
// the upsert payload, and calls upsert_wallet_moments — with PER-COLLECTION error
// isolation. The legs pinned here: auth + body validation (bad JSON / missing
// walletAddress), the empty-collection short-circuit, the standard vs Pinnacle
// enrich branch, upsert {error} → per-collection rpc_error status, a Flow-fetch
// throw isolated to one collection's `error:` status while the others still
// process, and the fmv/edition join shaping.

const st = vi.hoisted(() => ({
  editions: { data: [] as any[] } as any,
  fmv: { data: [] as any[] } as any,
  pinnacleEditions: { data: [] as any[] } as any,
  upsertErrorForCollection: null as string | null,
}))

const rpc = vi.hoisted(() => vi.fn(async (name: string, params?: any) => {
  if (name === "upsert_wallet_moments") {
    if (st.upsertErrorForCollection && params.p_collection_id === st.upsertErrorForCollection) {
      return { error: { message: "upsert boom" } }
    }
    return { error: null }
  }
  return { data: null, error: null }
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(table: string) {
      const b: any = {
        select: () => b, eq: () => b, in: () => b, order: () => b,
        then: (resolve: any) => {
          if (table === "editions") return resolve(st.editions)
          if (table === "fmv_snapshots") return resolve(st.fmv)
          if (table === "pinnacle_editions") return resolve(st.pinnacleEditions)
          return resolve({ data: [] })
        },
      }
      return b
    },
    rpc: (...a: any[]) => rpc(...(a as [string, any?])),
  },
}))

import { POST } from "@/app/api/wallet/seed/route"

const UFC_COLLECTION_ID = "9b4824a8-736d-4a96-b450-8dcc0c46b023"

// Flow REST fetch fixture: route by the collection's public-path substring in the
// (base64-encoded) cadence script. `idsBySlug[slug] === null` → HTTP error (throw).
const idsBySlug: Record<string, string[] | null> = {}
function pathSlug(cadence: string): string {
  if (cadence.includes("MomentCollection")) return "topshot"
  if (cadence.includes("AllDayNFTCollection")) return "allday"
  if (cadence.includes("PinnacleCollection")) return "pinnacle"
  if (cadence.includes("GolazoNFTCollection")) return "golazos"
  if (cadence.includes("UFC_NFTCollection")) return "ufc"
  return "?"
}
function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
    const cadence = atob(JSON.parse(init.body).script)
    const slug = pathSlug(cadence)
    const ids = slug in idsBySlug ? idsBySlug[slug] : [] // preserve an explicit null sentinel
    if (ids === null) return { ok: false, status: 500, text: async () => "flow err" }
    const inner = JSON.stringify({ type: "Array", value: ids.map((id) => ({ type: "UInt64", value: id })) })
    return { ok: true, text: async () => `"${btoa(inner)}"` }
  }))
}

const req = (opts: { token?: string; body?: any; badJson?: boolean }) =>
  ({
    headers: new Headers(opts.token ? { "x-ingest-token": opts.token } : {}),
    json: async () => { if (opts.badJson) throw new Error("bad"); return opts.body ?? {} },
  }) as any

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "tok"
  rpc.mockClear()
  st.editions = { data: [] }
  st.fmv = { data: [] }
  st.pinnacleEditions = { data: [] }
  st.upsertErrorForCollection = null
  for (const k of Object.keys(idsBySlug)) delete idsBySlug[k]
  installFetch()
})
afterEach(() => vi.unstubAllGlobals())

async function seed() {
  const res = await POST(req({ token: "tok", body: { walletAddress: "0xAbC", ownerKey: "ok1" } }))
  expect(res.status).toBe(200)
  return (await res.json()).results as Array<{ collection: string; count: number; status: string }>
}
const statusOf = (results: any[], slug: string) => results.find((r) => r.collection === slug)?.status

describe("POST /api/wallet/seed", () => {
  it("401 without the x-ingest-token", async () => {
    expect((await POST(req({ token: "nope", body: {} }))).status).toBe(401)
  })

  it("400 on invalid JSON body", async () => {
    const res = await POST(req({ token: "tok", badJson: true }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("Invalid JSON")
  })

  it("400 when walletAddress is missing/blank", async () => {
    expect((await POST(req({ token: "tok", body: {} }))).status).toBe(400)
    expect((await POST(req({ token: "tok", body: { walletAddress: "" } }))).status).toBe(400)
  })

  it("empty collections short-circuit to status 'empty'", async () => {
    // all slugs default to [] → every collection empty
    const results = await seed()
    expect(results).toHaveLength(5)
    expect(results.every((r) => r.status === "empty")).toBe(true)
  })

  it("standard enrich + upsert ok; wallet is lowercased; ownerKey echoed", async () => {
    idsBySlug.topshot = ["m1"]
    st.editions = { data: [{ id: "E1", external_id: "m1", player_name: "LeBron", set_name: "S", tier: "RARE", thumbnail_url: "t" }] }
    st.fmv = { data: [{ edition_id: "E1", fmv_usd: 5, computed_at: "2026-01-01" }] }

    const res = await POST(req({ token: "tok", body: { walletAddress: "0xAbC", ownerKey: "ok1" } }))
    const json = await res.json()
    expect(json.walletAddress).toBe("0xabc") // trimmed + lowercased
    expect(json.ownerKey).toBe("ok1")
    expect(statusOf(json.results, "nba-top-shot")).toBe("ok")

    // The upsert got the enriched moment with fmv + tier from the join.
    const upsert = rpc.mock.calls.find((c) => c[0] === "upsert_wallet_moments")
    expect(upsert?.[1].p_moments[0]).toMatchObject({ moment_id: "m1", edition_key: "m1", tier: "RARE", fmv_usd: 5, player_name: "LeBron" })
  })

  it("Pinnacle uses the pinnacle enrich branch (character_name, null fmv)", async () => {
    idsBySlug.pinnacle = ["p1"]
    st.pinnacleEditions = { data: [{ id: "P1", external_id: "p1", character_name: "Mickey", set_name: "D23", variant_type: "Standard", thumbnail_url: "t" }] }

    const results = await seed()
    expect(statusOf(results, "disney-pinnacle")).toBe("ok")
    const upsert = rpc.mock.calls.find((c) => c[0] === "upsert_wallet_moments")
    expect(upsert?.[1].p_moments[0]).toMatchObject({ character_name: "Mickey", tier: "Standard", fmv_usd: null })
  })

  it("upsert { error } → per-collection rpc_error status", async () => {
    idsBySlug.ufc = ["u1"]
    st.upsertErrorForCollection = UFC_COLLECTION_ID
    const results = await seed()
    expect(statusOf(results, "ufc-strike")).toContain("rpc_error: upsert boom")
  })

  it("a Flow-fetch throw is isolated to that collection's 'error:' status; others still process", async () => {
    idsBySlug.golazos = null // → HTTP 500 → fetchIds throws
    idsBySlug.topshot = ["m1"]
    st.editions = { data: [{ id: "E1", external_id: "m1", player_name: "P", set_name: "S", tier: "COMMON", thumbnail_url: null }] }

    const results = await seed()
    expect(statusOf(results, "laliga-golazos")).toContain("error:")
    expect(statusOf(results, "nba-top-shot")).toBe("ok") // isolation held
  })
})
