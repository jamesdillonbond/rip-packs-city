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
      // ⚠ NOT a weekly pipeline despite the name — jobid 198 runs `40 9 * * *`,
      // i.e. DAILY (expected 1440m). 2000m > the 24h floor, which applies here
      // precisely BECAUSE it is expected at least daily -> red.
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
    // ...and it carries the DAILY expectation now, not the 7-day one.
    expect(byName["weekly-db-maintenance"].expected_min).toBe(60 * 24)

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

  // ── THE 24h FLOOR MUST NOT OVERRIDE A LONGER DECLARED CADENCE ─────────────
  //
  // The floor used to fire unconditionally, before the 2x/5x multiples, so every
  // long-cadence entry was inert: with expectedMin >= 720 the yellow branch is
  // unreachable (2x >= 24h). A genuinely weekly pipeline therefore read RED from
  // 24h after each run until the next — ~6 days in 7, while running perfectly.
  //
  // Measured 2026-08-25: weekly-wmc-prune (jobid 199, `20 10 * * 0`) ran exactly
  // on schedule Sunday 08-23 10:20Z and read RED ~65h later.
  //
  // ⚠ Pinned as a PAIR. The weekly case proves the floor no longer over-fires;
  // the daily control proves removing it did not make the check toothless — a
  // fix that simply deleted the floor would pass the first and fail the second.
  it("a genuinely WEEKLY pipeline silent 65h is NOT red — the 24h floor does not override its cadence", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    rpc.data = [
      // weekly-wmc-prune: jobid 199 `20 10 * * 0`, expected 60*24*8 = 11520m.
      // 3900m is well inside 2x (23040m) — a weekly job three days after its run.
      { pipeline: "weekly-wmc-prune", last_run: ago(3900), runs_6h: 0, fails_6h: 0 },
    ]
    const res = await GET(req(`Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    const row = body.rows.find((r: any) => r.pipeline === "weekly-wmc-prune")
    expect(row.drift).not.toBe("red")
    expect(row.drift).toBe("green")
  })

  it("the daily CONTROL: a pipeline expected at least daily IS still red past 24h", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    rpc.data = [
      // Same 3900m silence, but a pipeline whose expectation is <= 24h. The floor
      // still applies here, so the fix above did not weaken the common case.
      { pipeline: "weekly-db-maintenance", last_run: ago(3900), runs_6h: 0, fails_6h: 0 },
      { pipeline: "fmv-recalc", last_run: ago(3900), runs_6h: 0, fails_6h: 0 },
    ]
    const res = await GET(req(`Bearer ${ADMIN}`))
    const body = await res.json()
    const byName: Record<string, any> = Object.fromEntries(body.rows.map((r: any) => [r.pipeline, r]))
    expect(byName["weekly-db-maintenance"].drift).toBe("red")
    expect(byName["fmv-recalc"].drift).toBe("red")
  })
})
