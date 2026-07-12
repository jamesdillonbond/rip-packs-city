import { describe, it, expect, beforeEach, vi } from "vitest"

// Integration test for lib/studio-sales-history.ts runStudioHistoryDrain().
// The module's pure helpers (toNum/buildQuery/fetchHistoryPage/drainEdition) are
// NOT exported, so every branch is driven through runStudioHistoryDrain with a
// thenable Supabase stub (routes results per-table/op via a hoisted `state`) and
// a stubbed global fetch that returns controlled studio-platform GraphQL payloads.
// Priorities: the 401 auth gate, disabled/seed/dryRun/saturation/throttle/pick
// guard branches, plus authorized happy/empty/dedup/error drain paths.

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

const PROGRESS = "allday_studio_sales_history_progress"
const QUERY = "searchAllDayMarketplaceHistory"
const SEEDFN = "seed_allday_studio_sales_history_targets"

const H = vi.hoisted(() => {
  const state: any = {
    throttleCount: 0,
    targets: { data: [] as any[], error: null as any },
    existing: { data: [] as any[], error: null as any },
    insertError: null as any,
    updateError: null as any,
    pendingCount: 3,
    seedResult: { data: 0 as any, error: null as any },
    seedThrows: false,
    queryThrow: null as string | null,
  }
  const PROGRESS = "allday_studio_sales_history_progress"
  const SEEDFN = "seed_allday_studio_sales_history_targets"

  function resolveQuery(ctx: any) {
    if (state.queryThrow && ctx.table === state.queryThrow) throw new Error("db down")
    if (ctx.op === "insert") return { data: null, error: state.insertError }
    if (ctx.op === "update") return { data: null, error: state.updateError }
    if (ctx.table === "pipeline_runs") return { data: null, error: null, count: state.throttleCount }
    if (ctx.table === PROGRESS) {
      if (ctx.headCount) return { data: null, error: null, count: state.pendingCount }
      return state.targets
    }
    if (ctx.table === "sales") return state.existing
    return { data: [], error: null, count: 0 }
  }

  function makeClient() {
    return {
      from(table: string) {
        const ctx: any = { table, headCount: false, op: "select" }
        const b: any = {}
        const chain = (m: string) => (...args: any[]) => {
          if (m === "select" && args[1] && args[1].head) ctx.headCount = true
          if (m === "insert") ctx.op = "insert"
          if (m === "update") ctx.op = "update"
          if (m === "upsert") ctx.op = "upsert"
          return b
        }
        for (const m of [
          "select", "eq", "neq", "in", "order", "limit", "is", "gte", "lt",
          "not", "ilike", "upsert", "insert", "update",
        ]) {
          b[m] = chain(m)
        }
        b.maybeSingle = async () => resolveQuery(ctx)
        b.single = async () => resolveQuery(ctx)
        b.then = (resolve: any) => resolve(resolveQuery(ctx))
        return b
      },
      rpc: async (name: string) => {
        if (name === SEEDFN) {
          if (state.seedThrows) throw new Error("seed exploded")
          return state.seedResult
        }
        // log_pipeline_run and anything else
        return { data: null, error: null }
      },
    }
  }

  return { state, client: makeClient() }
})

vi.mock("@/lib/supabase", () => ({ supabase: H.client, supabaseAdmin: H.client }))

import { runStudioHistoryDrain } from "@/lib/studio-sales-history"

const CFG = {
  pipelineName: "allday-studio-sales-history",
  collectionId: "dee28451-5d62-409e-a1ad-a83f763ac070",
  collectionSlug: "nfl_all_day",
  marketplace: "allday",
  sourceTag: "studio_history",
  progressTable: PROGRESS,
  seedFn: SEEDFN,
  queryName: QUERY,
  inputType: "SearchAllDayMarketplaceHistoryInput",
  origin: "https://nflallday.com",
  disableEnv: "TEST_STUDIO_DISABLE",
}

function req(url: string, opts: { auth?: string } = {}): any {
  return {
    headers: {
      get: (k: string) => (k.toLowerCase() === "authorization" ? opts.auth ?? null : null),
    },
    nextUrl: new URL(url),
    json: async () => ({}),
  }
}

const BASE = "https://www.rippackscity.com/api/cron/allday-studio-sales-history"
const AUTH = { auth: "Bearer test-ingest-token" }

function saleNode(over: Partial<any> = {}) {
  return {
    nft_id: "999",
    price: "500000000",
    sales_price: "500000000",
    purchased: true,
    created_at: {
      block_height: "123",
      block_time: "2024-01-01T00:00:00Z",
      transaction_hash: "0xabc",
    },
    nft: { serial_number: "7" },
    ...over,
  }
}

function fetchOk(conn: any) {
  return { ok: true, status: 200, json: async () => ({ data: { [QUERY]: conn } }) }
}
function onePage(nodes: any[], over: Partial<any> = {}) {
  return fetchOk({
    totalCount: nodes.length,
    pageInfo: { endCursor: null, hasNextPage: false },
    edges: nodes.map((node) => ({ node })),
    ...over,
  })
}

beforeEach(() => {
  H.state.throttleCount = 0
  H.state.targets = { data: [], error: null }
  H.state.existing = { data: [], error: null }
  H.state.insertError = null
  H.state.updateError = null
  H.state.pendingCount = 3
  H.state.seedResult = { data: 0, error: null }
  H.state.seedThrows = false
  H.state.queryThrow = null
  delete process.env.TEST_STUDIO_DISABLE
  vi.stubGlobal("fetch", vi.fn())
})

// ── Auth gate ────────────────────────────────────────────────────────────────
describe("runStudioHistoryDrain — auth gate", () => {
  it("401s with no authorization header", async () => {
    const res = await runStudioHistoryDrain(req(BASE), CFG as any)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer token", async () => {
    const res = await runStudioHistoryDrain(req(BASE, { auth: "Bearer nope" }), CFG as any)
    expect(res.status).toBe(401)
  })

  it("accepts the CRON_SECRET bearer", async () => {
    const res = await runStudioHistoryDrain(req(BASE, { auth: "Bearer test-cron-secret" }), CFG as any)
    expect(res.status).toBe(200)
    expect((await res.json()).note).toBe("queue_empty")
  })

  it("accepts the token via ?token= query param", async () => {
    const res = await runStudioHistoryDrain(req(`${BASE}?token=test-ingest-token`), CFG as any)
    expect(res.status).toBe(200)
    expect((await res.json()).note).toBe("queue_empty")
  })
})

// ── Disabled kill switch ──────────────────────────────────────────────────────
describe("runStudioHistoryDrain — disabled kill switch", () => {
  it("200 skipped:disabled when disableEnv=1", async () => {
    process.env.TEST_STUDIO_DISABLE = "1"
    const res = await runStudioHistoryDrain(req(BASE, AUTH), CFG as any)
    expect(res.status).toBe(200)
    expect((await res.json()).skipped).toBe("disabled")
  })

  it("200 skipped:disabled when disableEnv=true", async () => {
    process.env.TEST_STUDIO_DISABLE = "true"
    const res = await runStudioHistoryDrain(req(BASE, AUTH), CFG as any)
    expect((await res.json()).skipped).toBe("disabled")
  })
})

// ── Seed mode ────────────────────────────────────────────────────────────────
describe("runStudioHistoryDrain — seed mode", () => {
  it("200 mode:seed with the seeded count", async () => {
    H.state.seedResult = { data: 42, error: null }
    const res = await runStudioHistoryDrain(req(`${BASE}?seed=true`, AUTH), CFG as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mode).toBe("seed")
    expect(body.seeded).toBe(42)
  })

  it("500 when the seed RPC returns an error", async () => {
    H.state.seedResult = { data: null, error: { message: "seed boom" } }
    const res = await runStudioHistoryDrain(req(`${BASE}?seed=true`, AUTH), CFG as any)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("seed boom")
  })

  it("500 when the seed RPC throws", async () => {
    H.state.seedThrows = true
    const res = await runStudioHistoryDrain(req(`${BASE}?seed=true`, AUTH), CFG as any)
    expect(res.status).toBe(500)
    expect((await res.json()).ok).toBe(false)
  })
})

// ── Dry run ──────────────────────────────────────────────────────────────────
describe("runStudioHistoryDrain — dryRun mode", () => {
  it("400 when edition is missing / non-numeric", async () => {
    const res = await runStudioHistoryDrain(req(`${BASE}?dryRun=true&edition=abc`, AUTH), CFG as any)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("dryRun needs")
  })

  it("200 mode:dryRun with a studio_total and sample (writes nothing)", async () => {
    ;(fetch as any).mockResolvedValue(onePage([saleNode(), saleNode({ nft_id: "1000" })]))
    const res = await runStudioHistoryDrain(req(`${BASE}?dryRun=true&edition=123`, AUTH), CFG as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mode).toBe("dryRun")
    expect(body.edition).toBe(123)
    expect(body.studio_total).toBe(2)
    expect(body.pages).toBe(1)
    expect(Array.isArray(body.sample)).toBe(true)
  })

  it("500 mode:dryRun when the GQL fetch is not ok", async () => {
    ;(fetch as any).mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })
    const res = await runStudioHistoryDrain(req(`${BASE}?dryRun=true&edition=123`, AUTH), CFG as any)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain("GQL 503")
  })

  it("500 mode:dryRun when GQL returns an errors array", async () => {
    ;(fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: "rate limited" }] }),
    })
    const res = await runStudioHistoryDrain(req(`${BASE}?dryRun=true&edition=123`, AUTH), CFG as any)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain("rate limited")
  })
})

// ── Self-throttle / saturation ────────────────────────────────────────────────
describe("runStudioHistoryDrain — self-throttle", () => {
  it("200 skipped:saturation when recent non-self fails exceed the threshold", async () => {
    H.state.throttleCount = 20
    const res = await runStudioHistoryDrain(req(BASE, AUTH), CFG as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.skipped).toBe("saturation")
    expect(body.recent_fails).toBe(20)
  })

  it("200 skipped:throttle_error when the throttle read throws", async () => {
    H.state.queryThrow = "pipeline_runs"
    const res = await runStudioHistoryDrain(req(BASE, AUTH), CFG as any)
    expect(res.status).toBe(200)
    expect((await res.json()).skipped).toBe("throttle_error")
  })
})

// ── Target pick ──────────────────────────────────────────────────────────────
describe("runStudioHistoryDrain — target pick", () => {
  it("500 when the progress-table pick errors", async () => {
    H.state.targets = { data: null, error: { message: "pick boom" } }
    const res = await runStudioHistoryDrain(req(BASE, AUTH), CFG as any)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("pick boom")
  })

  it("200 note:queue_empty when there are no pending targets", async () => {
    const res = await runStudioHistoryDrain(req(BASE, AUTH), CFG as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.note).toBe("queue_empty")
    expect(body.pipeline).toBe("allday-studio-sales-history")
  })
})

// ── Full drain paths ─────────────────────────────────────────────────────────
describe("runStudioHistoryDrain — drain paths", () => {
  it("drains one edition end-to-end and inserts a sale", async () => {
    H.state.targets = { data: [{ edition_id: "ed-1", external_id: "123", attempts: 0 }], error: null }
    ;(fetch as any).mockResolvedValue(onePage([saleNode()]))
    const res = await runStudioHistoryDrain(req(BASE, AUTH), CFG as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.editions_processed).toBe(1)
    expect(body.editions_drained).toBe(1)
    expect(body.sales_inserted).toBe(1)
    expect(body.pending_remaining).toBe(3)
  })

  it("marks an edition empty when no purchased rows qualify", async () => {
    H.state.targets = { data: [{ edition_id: "ed-2", external_id: "123", attempts: 0 }], error: null }
    ;(fetch as any).mockResolvedValue(onePage([saleNode({ purchased: false })]))
    const body = await (await runStudioHistoryDrain(req(BASE, AUTH), CFG as any)).json()
    expect(body.editions_empty).toBe(1)
    expect(body.sales_inserted).toBe(0)
  })

  it("counts every candidate as a dupe against existing sales (0 inserted)", async () => {
    H.state.targets = { data: [{ edition_id: "ed-3", external_id: "123", attempts: 0 }], error: null }
    H.state.existing = { data: [{ transaction_hash: "0xabc" }], error: null }
    ;(fetch as any).mockResolvedValue(onePage([saleNode()]))
    const body = await (await runStudioHistoryDrain(req(BASE, AUTH), CFG as any)).json()
    expect(body.editions_drained).toBe(1)
    expect(body.sales_inserted).toBe(0)
    expect(body.dupes_skipped).toBe(1)
  })

  it("falls back to dupe counting on a 23505 batch insert error", async () => {
    H.state.targets = { data: [{ edition_id: "ed-4", external_id: "123", attempts: 0 }], error: null }
    H.state.insertError = { code: "23505", message: "duplicate key value" }
    ;(fetch as any).mockResolvedValue(onePage([saleNode()]))
    const body = await (await runStudioHistoryDrain(req(BASE, AUTH), CFG as any)).json()
    expect(body.dupes_skipped).toBe(1)
    expect(body.sales_inserted).toBe(0)
  })

  it("counts a gql_error when a non-dup insert error leaves the edition pending", async () => {
    H.state.targets = { data: [{ edition_id: "ed-5", external_id: "123", attempts: 0 }], error: null }
    H.state.insertError = { code: "XX999", message: "insert exploded" }
    ;(fetch as any).mockResolvedValue(onePage([saleNode()]))
    const body = await (await runStudioHistoryDrain(req(BASE, AUTH), CFG as any)).json()
    expect(body.gql_errors).toBe(1)
    expect(body.editions_drained).toBe(0)
  })

  it("counts a gql_error when the existing-sales pre-filter read fails", async () => {
    H.state.targets = { data: [{ edition_id: "ed-6", external_id: "123", attempts: 0 }], error: null }
    H.state.existing = { data: null, error: { message: "read fail" } }
    ;(fetch as any).mockResolvedValue(onePage([saleNode()]))
    const body = await (await runStudioHistoryDrain(req(BASE, AUTH), CFG as any)).json()
    expect(body.gql_errors).toBe(1)
  })

  it("errors an edition with a non-numeric external_id", async () => {
    H.state.targets = { data: [{ edition_id: "ed-7", external_id: "not-a-number", attempts: 0 }], error: null }
    const body = await (await runStudioHistoryDrain(req(BASE, AUTH), CFG as any)).json()
    expect(body.editions_error).toBe(1)
    expect(body.editions_processed).toBe(1)
  })

  it("counts a gql_error when the fetch returns a non-ok status", async () => {
    H.state.targets = { data: [{ edition_id: "ed-8", external_id: "123", attempts: 0 }], error: null }
    ;(fetch as any).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    const body = await (await runStudioHistoryDrain(req(BASE, AUTH), CFG as any)).json()
    expect(body.gql_errors).toBe(1)
    expect(body.editions_drained).toBe(0)
  })

  it("counts a gql_error when the GQL response has no connection object", async () => {
    H.state.targets = { data: [{ edition_id: "ed-9", external_id: "123", attempts: 0 }], error: null }
    ;(fetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: {} }) })
    const body = await (await runStudioHistoryDrain(req(BASE, AUTH), CFG as any)).json()
    expect(body.gql_errors).toBe(1)
  })
})
