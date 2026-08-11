import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/pipeline-health (GET).
// isAuthorized(): Bearer INGEST_SECRET_TOKEN OR RPC_ADMIN_TOKEN, fail-closed.
// Pulls pipeline_runs via query_sql and classifies cadence drift. With no rows
// every known pipeline classifies red/expected_but_missing. Pins the 401 and
// the empty-window happy path.

const rpc: { data: any; error: any } = { data: null, error: null }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/admin/pipeline-health/route"

const ADMIN = "test-admin-token"

function req(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/admin/pipeline-health", { headers })
}

const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString()

let savedIngest: string | undefined
beforeEach(() => {
  savedIngest = process.env.INGEST_SECRET_TOKEN
  delete process.env.RPC_ADMIN_TOKEN
  delete process.env.INGEST_SECRET_TOKEN
  rpc.data = null
  rpc.error = null
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
})

describe("GET /api/admin/pipeline-health", () => {
  it("401s fail-closed when no token env is set", async () => {
    expect((await GET(req(`Bearer ${ADMIN}`))).status).toBe(401)
  })

  it("classifies every known pipeline as expected_but_missing on an empty window", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    rpc.data = []
    const res = await GET(req(`Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.summary.green).toBe(0)
    expect(body.summary.expected_but_missing).toBeGreaterThan(0)
    expect(Array.isArray(body.rows)).toBe(true)
  })

  it("500s on an RPC error", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    rpc.error = { message: "boom" }
    expect((await GET(req(`Bearer ${ADMIN}`))).status).toBe(500)
  })

  it("surfaces the error code on a 500", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    rpc.error = { message: "boom", code: "57014" }
    const res = await GET(req(`Bearer ${ADMIN}`))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe("boom")
    expect(body.code).toBe("57014")
  })

  it("authorizes via the INGEST_SECRET_TOKEN bearer as well", async () => {
    process.env.INGEST_SECRET_TOKEN = "ingest-x"
    rpc.data = []
    const res = await GET(req("Bearer ingest-x"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.summary.expected_but_missing).toBeGreaterThan(0)
  })

  it("treats a null data payload (no error) as an empty window", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    rpc.data = null // error also null
    const res = await GET(req(`Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.summary.green).toBe(0)
    expect(body.summary.expected_but_missing).toBeGreaterThan(0)
  })

  it("classifies green / yellow / red across cadence tiers and unknown pipelines", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    rpc.data = [
      // known cadence (expected 20m): 10m -> green
      { pipeline: "fmv-recalc", last_run: ago(10), runs_6h: 5, fails_6h: 0 },
      // known cadence (expected 20m): 60m -> > 2x, <= 5x -> yellow
      { pipeline: "allday-fmv-populate", last_run: ago(60), runs_6h: 3, fails_6h: 1 },
      // known cadence (expected 20m): 200m -> > 5x -> red
      { pipeline: "golazos-sales-indexer", last_run: ago(200), runs_6h: 1, fails_6h: 0 },
      // known long cadence (weekly): 2000m -> hits the >24h red branch first
      { pipeline: "weekly-db-maintenance", last_run: ago(2000), runs_6h: 1, fails_6h: 0 },
      // unknown cadence, recent -> green (<= 24h)
      { pipeline: "unknown-pipe-fresh", last_run: ago(100), runs_6h: 2, fails_6h: 0 },
      // unknown cadence, > 24h -> red
      { pipeline: "unknown-pipe-stale", last_run: ago(2000), runs_6h: 1, fails_6h: 0 },
      // null run/fail counts -> coerced to 0
      { pipeline: "editions-hydrate-at-insert", last_run: ago(5), runs_6h: null, fails_6h: null },
    ]

    const res = await GET(req(`Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    const byName: Record<string, any> = Object.fromEntries(
      body.rows.map((r: any) => [r.pipeline, r])
    )

    expect(byName["fmv-recalc"].drift).toBe("green")
    expect(byName["fmv-recalc"].expected_but_missing).toBe(false)
    expect(byName["allday-fmv-populate"].drift).toBe("yellow")
    expect(byName["golazos-sales-indexer"].drift).toBe("red")
    expect(byName["weekly-db-maintenance"].drift).toBe("red")

    // unknown cadence: expected_min null, never "expected_but_missing"
    expect(byName["unknown-pipe-fresh"].expected_min).toBeNull()
    expect(byName["unknown-pipe-fresh"].drift).toBe("green")
    expect(byName["unknown-pipe-fresh"].expected_but_missing).toBe(false)
    expect(byName["unknown-pipe-stale"].drift).toBe("red")
    expect(byName["unknown-pipe-stale"].expected_but_missing).toBe(false)

    // null counts coerced to 0
    expect(byName["editions-hydrate-at-insert"].runs_6h).toBe(0)
    expect(byName["editions-hydrate-at-insert"].fails_6h).toBe(0)
    expect(byName["editions-hydrate-at-insert"].drift).toBe("green")

    // summary spans all three buckets, and the unseen known pipelines are red+missing
    expect(body.summary.green).toBeGreaterThanOrEqual(2)
    expect(body.summary.yellow).toBeGreaterThanOrEqual(1)
    expect(body.summary.red).toBeGreaterThanOrEqual(1)
    expect(body.summary.expected_but_missing).toBeGreaterThan(0)

    // sort: red bucket floats to the top
    expect(body.rows[0].drift).toBe("red")
  })
})
