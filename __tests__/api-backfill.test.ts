import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/backfill (TopShot sales backfill).
// The guard is `if (expectedToken && authHeader !== "Bearer TOKEN") 401`, read
// at call time — so with the token SET a wrong/missing header is 401 before the
// TopShot GQL walk. (When the env is unset the guard is intentionally skipped.)
//
// Beyond the guards we drive the real POST body: the module builds one Supabase
// client at import via createClient (mocked to a configurable chainable stub) and
// pages TopShot GQL via global fetch (stubbed per test). cfg is mutable so each
// case shapes the backfill_state row, the editions existence/insert results, and
// the sales insert outcome; the fetch stub shapes each GQL page + its cursor.

const cfg: any = vi.hoisted(() => ({
  state: null as any, // backfill_state row (single())
  stateErr: null as any, // ⚠ the ERROR half — a failed read is not "no state"
  edSelect: [{ data: [] as any[], error: null }] as any[], // editions existence/retry selects, sequenced
  edSelectI: 0,
  edInsert: { data: { id: "ed-new" }, error: null } as any, // editions insert().select().single()
  salesInsert: { error: null } as any, // sales insert()
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      let isInsert = false
      const b: any = {
        select: () => b,
        eq: () => b,
        limit: () => b,
        insert: () => {
          isInsert = true
          return b
        },
        update: () => b,
        single: async () => {
          if (table === "backfill_state") return { data: cfg.state, error: cfg.stateErr }
          if (table === "editions" && isInsert) return cfg.edInsert
          return { data: null, error: null }
        },
        then: (resolve: any) => {
          if (table === "editions") {
            if (isInsert) return resolve(cfg.edInsert)
            const r = cfg.edSelect[Math.min(cfg.edSelectI++, cfg.edSelect.length - 1)]
            return resolve(r)
          }
          if (table === "sales") return resolve(cfg.salesInsert)
          return resolve({ data: null, error: null })
        },
      }
      return b
    },
  }),
}))

import { POST } from "@/app/api/backfill/route"

const TOKEN = "test-ingest-token"

function req(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/backfill", { method: "POST", headers })
}

// A TopShot GQL search-transactions moment.
function moment(over: any = {}) {
  return {
    id: "m1",
    flowId: "f1",
    flowSerialNumber: "5",
    parallelSetPlay: { setID: 1, playID: 2, parallelID: 0 },
    play: { id: "p1", stats: { playerName: "Player" } },
    ...over,
  }
}
function tx(over: any = {}) {
  return {
    id: "t1",
    price: 10,
    updatedAt: "2026-01-01T00:00:00.000Z",
    txHash: "0xhash1",
    moment: moment(),
    ...over,
  }
}

// Build one fetch stub that returns GQL pages in sequence (last repeats), or an
// error response, so the multi-page + error branches are drivable.
function stubFetch(pages: Array<{ txs?: any[]; rightCursor?: string | null; ok?: boolean; status?: number }>) {
  let i = 0
  const fn = vi.fn(async () => {
    const p = pages[Math.min(i, pages.length - 1)]
    i++
    if (p.ok === false) {
      return {
        ok: false,
        status: p.status ?? 500,
        json: async () => ({}),
        text: async () => "gql boom",
      } as unknown as Response
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          searchMarketplaceTransactions: {
            data: {
              searchSummary: {
                pagination: { rightCursor: p.rightCursor ?? null },
                data: [{ data: p.txs ?? [] }],
              },
            },
          },
        },
      }),
      text: async () => "",
    } as unknown as Response
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  cfg.state = null
  cfg.stateErr = null
  cfg.edSelect = [{ data: [], error: null }]
  cfg.edSelectI = 0
  cfg.edInsert = { data: { id: "ed-new" }, error: null }
  cfg.salesInsert = { error: null }
})
afterEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  vi.unstubAllGlobals()
})

describe("POST /api/backfill", () => {
  it("401s with a wrong bearer token when the server token is set", async () => {
    expect((await POST(req("Bearer wrong"))).status).toBe(401)
  })

  it("401s without an authorization header when the server token is set", async () => {
    expect((await POST(req())).status).toBe(401)
  })
})

describe("POST /api/backfill — early-exit + walk outcomes", () => {
  it("returns the already-complete short-circuit when backfill_state.status is 'complete'", async () => {
    cfg.state = { status: "complete", total_ingested: 42, cursor: "c9" }
    stubFetch([{ txs: [] }]) // never reached
    const res = await POST(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.message).toBe("Backfill already complete")
    expect(body.totalIngested).toBe(42)
  })

  it("completes when the first page has zero transactions (no more to ingest)", async () => {
    cfg.state = { status: "running", total_ingested: 10, cursor: "c0" }
    stubFetch([{ txs: [], rightCursor: null }])
    const res = await POST(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.message).toBe("Backfill complete - no more transactions")
    expect(body.totalThisRun).toBe(0)
    expect(body.totalOverall).toBe(10)
  })

  it("ingests a new edition + a fresh sale and reports totalThisRun (cursor done)", async () => {
    cfg.state = { status: "running", total_ingested: 0, cursor: null }
    cfg.edSelect = [{ data: [], error: null }] // existence miss -> insert
    cfg.edInsert = { data: { id: "ed-new" }, error: null }
    cfg.salesInsert = { error: null }
    stubFetch([{ txs: [tx()], rightCursor: null }])
    const res = await POST(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.totalThisRun).toBe(1)
    expect(body.duplicates).toBe(0)
    expect(body.cursor).toBe("done")
    expect(body.totalOverall).toBe(1)
  })

  it("counts a duplicate sale (23505) and reuses an already-existing edition", async () => {
    cfg.state = { status: "running", total_ingested: 3, cursor: "c0" }
    cfg.edSelect = [{ data: [{ id: "ed-existing" }], error: null }] // existence hit -> no insert
    cfg.salesInsert = { error: { code: "23505" } }
    stubFetch([{ txs: [tx()], rightCursor: null }])
    const res = await POST(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.duplicates).toBe(1)
    expect(body.totalThisRun).toBe(0)
    expect(body.cursor).toBe("done")
    expect(body.totalOverall).toBe(3)
  })

  it("walks all maxPages when a cursor persists and reports cursor:'has_more'", async () => {
    cfg.state = { status: "running", total_ingested: 0, cursor: null }
    cfg.edSelect = [{ data: [{ id: "ed-existing" }], error: null }] // reuse existing edition every page
    cfg.salesInsert = { error: null }
    // Every page carries a rightCursor, so the loop never breaks and runs the full
    // 4-page budget -> the post-loop "has_more" branch (cursor still truthy).
    stubFetch([{ txs: [tx()], rightCursor: "keep-going" }])
    const res = await POST(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.pages).toBe(4)
    expect(body.totalThisRun).toBe(4)
    expect(body.cursor).toBe("has_more")
  })

  it("skips a transaction with no moment and one whose price is <= 0", async () => {
    cfg.state = { status: "running", total_ingested: 0, cursor: null }
    stubFetch([
      {
        txs: [tx({ moment: undefined }), tx({ id: "t2", price: 0, txHash: "0xh2" })],
        rightCursor: null,
      },
    ])
    const res = await POST(req(`Bearer ${TOKEN}`))
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.totalThisRun).toBe(0)
  })

  it("skips an edition that fails to insert with a non-duplicate error", async () => {
    cfg.state = { status: "running", total_ingested: 0, cursor: null }
    cfg.edSelect = [{ data: [], error: null }]
    cfg.edInsert = { data: null, error: { code: "500", message: "insert failed" } }
    stubFetch([{ txs: [tx()], rightCursor: null }])
    const res = await POST(req(`Bearer ${TOKEN}`))
    const body = await res.json()
    expect(body.totalThisRun).toBe(0) // edition skipped -> sale never attempted
  })

  it("recovers the edition id via a retry select after a 23505 insert race", async () => {
    cfg.state = { status: "running", total_ingested: 0, cursor: null }
    // first select (existence) misses, retry select (after 23505) hits
    cfg.edSelect = [
      { data: [], error: null },
      { data: [{ id: "ed-retry" }], error: null },
    ]
    cfg.edInsert = { data: null, error: { code: "23505" } }
    cfg.salesInsert = { error: null }
    stubFetch([{ txs: [tx()], rightCursor: null }])
    const res = await POST(req(`Bearer ${TOKEN}`))
    const body = await res.json()
    expect(body.totalThisRun).toBe(1) // retry recovered edition -> sale landed
  })

  it("returns ok:false and records error state when a GQL page fails", async () => {
    cfg.state = { status: "running", total_ingested: 0, cursor: "c0" }
    stubFetch([{ ok: false, status: 503 }])
    const res = await POST(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(String(body.error)).toContain("GQL 503")
  })

  it("parses a GQL page whose searchSummary.data is a single object (not an array)", async () => {
    cfg.state = { status: "running", total_ingested: 0, cursor: null }
    cfg.edSelect = [{ data: [{ id: "ed-existing" }], error: null }]
    cfg.salesInsert = { error: null }
    // dataField as an OBJECT with a .data array — the non-array branch in fetchSalesPage.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            searchMarketplaceTransactions: {
              data: {
                searchSummary: {
                  pagination: { rightCursor: null },
                  data: { data: [tx()] },
                },
              },
            },
          },
        }),
        text: async () => "",
      })) as unknown as typeof fetch
    )
    const res = await POST(req(`Bearer ${TOKEN}`))
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.totalThisRun).toBe(1)
  })

  it("skips the auth guard entirely when the server token is unset (happy walk)", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    cfg.state = { status: "running", total_ingested: 0, cursor: null }
    stubFetch([{ txs: [], rightCursor: null }])
    const res = await POST(req()) // no auth header, but guard skipped
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })
})

// ── A failed state read must not be mistaken for "no state" (2026-08-25) ─────
//
// The route dropped `error` on its `backfill_state` read. supabase-js RESOLVES a
// query error, so a failed read left `state = null` and every use of it below
// then meant the OPPOSITE of the truth:
//
//   state?.status === "complete"   → false  ⇒ a FINISHED backfill re-walks
//   state?.cursor ?? null          → null   ⇒ the cursor RESETS to the beginning
//   (state?.total_ingested ?? 0)   → 0      ⇒ the cumulative counter is destroyed
//
// ...and then it WRITES that back. `topshot_sales` is `status: "complete"` live,
// so one transient read failure could un-complete a finished backfill
// PERSISTENTLY — the write lands, the next run reads the new status, and the
// early exit never fires again.
//
// These pin the WRITE and the STATUS, not the response text: the old body was
// `{ ok: true, message: "Backfill complete" }` or a normal walk result, neither
// of which mentions an error, so asserting on copy would pass against the defect.
describe("POST /api/backfill — a failed backfill_state read", () => {
  it("does not answer 200 when the state read fails", async () => {
    cfg.stateErr = { message: "boom" }
    const res = await POST(req(`Bearer ${TOKEN}`))
    expect(res.status).not.toBe(200)
    expect(res.status).toBeGreaterThanOrEqual(500)
  })

  it("does NOT walk — the cursor must never be reset from a read that failed", async () => {
    cfg.stateErr = { message: "boom" }
    const seen: string[] = []
    globalThis.fetch = vi.fn(async (u: any) => {
      seen.push(String(u))
      return { ok: true, json: async () => ({}), text: async () => "" } as any
    }) as unknown as typeof fetch
    await POST(req(`Bearer ${TOKEN}`))
    // The TopShot GQL walk is the expensive, cursor-destroying part. It must not
    // start at all: doing nothing costs one cron interval, doing it wrong costs
    // the cursor.
    expect(seen).toEqual([])
  })

  it("classifies a statement timeout as a retryable 503", async () => {
    cfg.stateErr = { code: "57014", message: "canceling statement due to statement timeout" }
    const res = await POST(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(503)
    expect((await res.json()).retryable).toBe(true)
  })

  it("NO-CHANGE CONTROL: a genuinely absent state row still walks", async () => {
    // `single()` on a missing row is a real, expected state for a first run, and
    // the walk MUST still start — otherwise "never walk on null state" would
    // satisfy the cases above by disabling the backfill entirely.
    cfg.state = null
    cfg.stateErr = null
    stubFetch([{ txs: [], rightCursor: null }])
    const res = await POST(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("NO-CHANGE CONTROL: a complete backfill still early-exits without walking", async () => {
    cfg.state = { status: "complete", total_ingested: 4321, cursor: "c1" }
    cfg.stateErr = null
    const seen: string[] = []
    globalThis.fetch = vi.fn(async (u: any) => {
      seen.push(String(u))
      return { ok: true, json: async () => ({}), text: async () => "" } as any
    }) as unknown as typeof fetch
    const res = await POST(req(`Bearer ${TOKEN}`))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.message).toMatch(/already complete/i)
    expect(body.totalIngested).toBe(4321)
    expect(seen).toEqual([])
  })
})
