import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"

// Deep-drive of POST /api/backfill-editions — repoints UUID-format edition keys
// to on-chain int pairs by walking each moment's setID:playID via GQL. Shallow
// suite only pins the 401s. Here we drive the real body and assert:
//   - the WRITE contract: a UUID-keyed candidate resolves to "3:45" -> editions
//     UPSERT of the int-key row AND an editions UPDATE stamping set_id_onchain/
//     play_id_onchain, plus the backfill_state cursor advance;
//   - the "all rows already integer-keyed" branch just advances the offset;
//   - the "no rows at all" branch resets cursor to 0 / status complete;
//   - a GQL miss (null set/play) is processed but neither upserted nor updated;
//   - a Supabase moments-query error -> honest 500.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  gql: (_id: string) => ({}) as unknown,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))
vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async (_q: string, vars: { id: string }) => state.gql(vars.id),
}))

const { POST } = await import("@/app/api/backfill-editions/route")

const TOKEN = "ingest-secret"
function req(auth = "Bearer " + TOKEN): Request {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new Request("https://t/api/backfill-editions", { method: "POST", headers })
}

function install(fixtures: Parameters<typeof makeInstrumentedSupabaseFixture>[0]) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}
const momentRow = (nft: string, edId: string, extId: string) => ({
  nft_id: nft,
  edition_id: edId,
  editions: { external_id: extId },
})

let saved: string | undefined
beforeEach(() => {
  saved = process.env.INGEST_SECRET_TOKEN
  process.env.INGEST_SECRET_TOKEN = TOKEN
  state.gql = () => ({})
})
afterEach(() => {
  if (saved === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = saved
})

describe("backfill-editions — UUID->int key repointing", () => {
  it("resolves a UUID candidate to an int pair, upserting the int row + stamping on-chain ids", async () => {
    state.gql = () => ({ getMintedMoment: { data: { set: { id: "3" }, play: { id: "45" } } } })
    const spy = install({
      backfill_state: { data: { cursor: "0", total_ingested: 0 }, error: null },
      moments: { data: [momentRow("111", "ed-uuid-1", "set-uuid:play-uuid")], error: null },
      editions: { data: [], error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, processed: 1, upserted: 1, updated: 1, offset: 100 })

    const upsert = (spy.writes.editions ?? []).find((w) => w.method === "upsert")
    expect(upsert?.rows[0]).toMatchObject({ external_id: "3:45" })
    const update = (spy.writes.editions ?? []).find((w) => w.method === "update")
    expect(update?.rows[0]).toMatchObject({ set_id_onchain: 3, play_id_onchain: 45 })

    const stateWrite = (spy.writes.backfill_state ?? []).flatMap((w) => w.rows)
    expect(stateWrite[0]).toMatchObject({
      id: "topshot_edition_integer_keys",
      cursor: "100",
      total_ingested: 1,
    })
  })

  it("advances the offset when every row in the batch is already integer-keyed", async () => {
    const spy = install({
      backfill_state: { data: { cursor: "200", total_ingested: 0 }, error: null },
      moments: { data: [momentRow("222", "ed-int-1", "3:45")], error: null }, // already int -> not a candidate
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({ processed: 0, upserted: 0, offset: 300 })
    expect(String(body.message)).toContain("already had integer keys")
    // No edition writes; only the offset advance.
    expect(spy.writes.editions ?? []).toHaveLength(0)
    const stateWrite = (spy.writes.backfill_state ?? []).flatMap((w) => w.rows)
    expect(stateWrite[0]).toMatchObject({ cursor: "300", status: "running" })
  })

  it("resets the cursor / marks complete when the moments page is empty", async () => {
    const spy = install({
      backfill_state: { data: { cursor: "500", total_ingested: 9 }, error: null },
      moments: { data: [], error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(String(body.message)).toContain("No more UUID-format editions")
    const stateWrite = (spy.writes.backfill_state ?? []).flatMap((w) => w.rows)
    expect(stateWrite[0]).toMatchObject({ cursor: "0", status: "complete" })
  })

  it("processes a GQL miss (null set/play) without upserting or updating", async () => {
    state.gql = () => ({ getMintedMoment: { data: null } })
    const spy = install({
      backfill_state: { data: { cursor: "0", total_ingested: 0 }, error: null },
      moments: { data: [momentRow("333", "ed-uuid-2", "uuid-a:uuid-b")], error: null },
      editions: { data: [], error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({ processed: 1, upserted: 0, updated: 0 })
    expect(spy.writes.editions ?? []).toHaveLength(0)
  })

  it("500s when the moments query errors", async () => {
    install({
      backfill_state: { data: { cursor: "0", total_ingested: 0 }, error: null },
      moments: { data: null, error: { message: "moments query boom" } },
    })
    const res = await POST(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toContain("moments query boom")
  })
})
