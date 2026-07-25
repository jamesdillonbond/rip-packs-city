import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Deep drive of GET /api/backfill-onchain-ids (the sibling test only pins the 401).
// This synchronous route pulls editions missing set_id_onchain and resolves each
// external_id to (setID, playID) integers — directly when it's already "37:1199",
// or via the Top Shot GQL when it's a UUID pair — then updates editions (+ denorms
// sets). Legs pinned: auth, the editions-query error → 500, the empty short-circuit,
// the direct-integer vs UUID-resolve branches, a malformed external_id → failed,
// a GQL miss → failed, an update error → failed, and the resolveFromUuids parse.

const st = vi.hoisted(() => ({
  editions: { data: [] as any[], error: null as any },
  editionUpdate: { error: null as any },
  setUpdate: { error: null as any },
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      let op: "select" | "update" = "select"
      const b: any = {
        select: () => { op = "select"; return b },
        update: () => { op = "update"; return b },
        is: () => b, order: () => b, range: () => b, eq: () => b,
        then: (resolve: any) => {
          if (table === "editions" && op === "select") return resolve(st.editions)
          if (table === "editions" && op === "update") return resolve(st.editionUpdate)
          if (table === "sets") return resolve(st.setUpdate)
          return resolve({ data: null, error: null })
        },
      }
      return b
    },
  }),
}))

import { GET } from "@/app/api/backfill-onchain-ids/route"

// GQL fetch fixture. mode: "ok" returns a moment with setPlay; "empty" returns no
// moments; "notok" returns HTTP error.
let gqlMode: "ok" | "empty" | "notok" = "ok"
let gqlSetPlay: any = { setID: "37", playID: "1199" }
function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (gqlMode === "notok") return { ok: false, json: async () => ({}) }
    const data = gqlMode === "empty" ? [] : [{ moment: { setPlay: gqlSetPlay } }]
    return { ok: true, json: async () => ({ data: { searchMomentListings: { data } } }) }
  }))
}

const get = (qs: string) => new Request(`https://t/api/backfill-onchain-ids${qs}`)

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "sek"
  st.editions = { data: [], error: null }
  st.editionUpdate = { error: null }
  st.setUpdate = { error: null }
  gqlMode = "ok"
  gqlSetPlay = { setID: "37", playID: "1199" }
  installFetch()
})
afterEach(() => vi.unstubAllGlobals())

describe("GET /api/backfill-onchain-ids", () => {
  it("401 with a wrong secret", async () => {
    expect((await GET(get("?secret=nope"))).status).toBe(401)
  })

  it("editions-query error → 500", async () => {
    st.editions = { data: null, error: { message: "editions down" } }
    const res = await GET(get("?secret=sek"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("editions down")
  })

  it("no editions left → 'All editions backfilled', total 0", async () => {
    const body = await (await GET(get("?secret=sek"))).json()
    expect(body.total).toBe(0)
    expect(body.message).toContain("All editions backfilled")
  })

  it("direct integer external_id → used without a GQL call, denorms sets", async () => {
    st.editions = { data: [{ id: "e1", external_id: "37:1199", set_id: "s1" }], error: null }
    const body = await (await GET(get("?secret=sek"))).json()
    expect(body.direct).toBe(1)
    expect(body.updated).toBe(1)
    expect(body.failed).toBe(0)
    expect((globalThis.fetch as any).mock.calls.length).toBe(0) // integer path skips GQL
  })

  it("UUID external_id → resolved via GQL, updated", async () => {
    st.editions = { data: [{ id: "e2", external_id: "aaaa:bbbb", set_id: null }], error: null }
    const body = await (await GET(get("?secret=sek"))).json()
    expect(body.updated).toBe(1)
    expect(body.direct).toBe(0)
    expect((globalThis.fetch as any).mock.calls.length).toBe(1)
  })

  it("a malformed external_id (not a pair) → failed", async () => {
    st.editions = { data: [{ id: "e3", external_id: "nocolon", set_id: null }], error: null }
    const body = await (await GET(get("?secret=sek"))).json()
    expect(body.failed).toBe(1)
    expect(body.updated).toBe(0)
  })

  it("a GQL miss (no moments) → failed with an error note", async () => {
    gqlMode = "empty"
    st.editions = { data: [{ id: "e4", external_id: "aaaa:bbbb", set_id: null }], error: null }
    const body = await (await GET(get("?secret=sek"))).json()
    expect(body.failed).toBe(1)
    expect(body.errors[0]).toContain("Failed: aaaa:bbbb")
  })

  it("a GQL HTTP error → resolveFromUuids null → failed", async () => {
    gqlMode = "notok"
    st.editions = { data: [{ id: "e5", external_id: "aaaa:bbbb", set_id: null }], error: null }
    const body = await (await GET(get("?secret=sek"))).json()
    expect(body.failed).toBe(1)
  })

  it("an editions update error → failed", async () => {
    st.editions = { data: [{ id: "e6", external_id: "37:1199", set_id: "s1" }], error: null }
    st.editionUpdate = { error: { message: "update conflict" } }
    const body = await (await GET(get("?secret=sek"))).json()
    expect(body.failed).toBe(1)
    expect(body.updated).toBe(0)
    expect(body.errors[0]).toContain("Update failed e6")
  })

  it("a non-numeric GQL setID/playID → null → failed (NaN guard)", async () => {
    gqlSetPlay = { setID: "notnum", playID: "x" }
    st.editions = { data: [{ id: "e7", external_id: "aaaa:bbbb", set_id: null }], error: null }
    const body = await (await GET(get("?secret=sek"))).json()
    expect(body.failed).toBe(1)
  })
})
