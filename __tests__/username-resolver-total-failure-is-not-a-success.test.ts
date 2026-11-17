import { describe, it, expect, beforeEach, vi } from "vitest"

// ⚠ WHY THIS EXISTS (2026-08-29). `wallet-username-resolver` initialised `ok = true`
// and lowered it ONLY when the Supabase RPC that fetches the queue failed. Every
// per-address upstream failure just incremented `errored`, so a TOTAL outage of Top
// Shot's GraphQL logged `ok: true` with `rows_written: 0`. Six consecutive runs that
// day recorded errored = found (19/19 → 63/63), all green, while
// `public-api.nbatopshot.com` had been answering 530/1033 for 22 hours.
//
// ⭐ The pipeline is on `pipeline_cadence_watchlist` and ACTIVE, so the sentinel's
// Pipeline Success Coverage arm (zero successes AND zero rows written) was pointed
// straight at it and still could not fire — the run claimed a success. A watcher
// that cannot see a failure is the thing this repo counts.
//
// THE PROPERTY PINNED HERE IS THE PREDICATE, in both directions. "Any error reddens
// the run" is the noisy form this repo has already rejected for the cadence arms, so
// the partial / empty / all-miss cases are asserted as CONTROLS, not decoration: a
// fix that simply flipped `ok` to `errored > 0` passes the first test and fails three.

vi.hoisted(() => { process.env.INGEST_SECRET_TOKEN = "tok" })

let capturedAfter: null | (() => Promise<void>) = null
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { capturedAfter = fn } }
})
const st = vi.hoisted(() => ({
  unresolved: { data: [] as any[] | null, error: null as any },
  pipelineRuns: [] as any[],
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => st.unresolved,
    from() {
      return {
        upsert: () => ({ then: (r: any) => r({ error: null }) }),
        insert: (row: any) => { st.pipelineRuns.push(row); return { then: (r: any) => r({ error: null }) } },
      } as any
    },
  },
}))

import { POST } from "@/app/api/cron/resolve-wallet-usernames/route"

const req = () => ({
  headers: new Headers({ authorization: "Bearer tok" }),
  nextUrl: new URL("https://t/api/cron/resolve-wallet-usernames"),
}) as any

// "hit" → username · "MISS" → 200 with no profile · "ERR" → a real HTTP failure,
// carrying a status so the recorded reason is the one production would record.
const byAddr: Record<string, string> = {}
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "tok"
  capturedAfter = null
  st.unresolved = { data: [], error: null }
  st.pipelineRuns = []
  for (const k of Object.keys(byAddr)) delete byAddr[k]
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
    const addr = JSON.parse(init.body).variables.addr
    const v = byAddr[addr]
    if (v === "ERR") return { ok: false, status: 530, json: async () => ({}) }
    if (v === "MISS" || v === undefined) {
      return { ok: true, json: async () => ({ data: { getUserProfile: { publicInfo: { username: null } } } }) }
    }
    return { ok: true, json: async () => ({ data: { getUserProfile: { publicInfo: { username: v } } } }) }
  }))
})

async function run(addrs: string[], fixture: Record<string, string>): Promise<any> {
  st.unresolved = { data: addrs, error: null }
  // ⚠ getUserProfile's flowAddress lookup wants the BARE hex, so the route strips
  // `0x` before the call and the fetch fixture must be keyed that way. Keying it on
  // the 0x form silently lands every address in the "no profile" branch, which reads
  // as a run full of clean misses rather than a broken fixture.
  for (const [k, v] of Object.entries(fixture)) byAddr[k.replace(/^0x/i, "")] = v
  await POST(req())
  expect(capturedAfter, "route did not schedule its after() body").not.toBeNull()
  await capturedAfter!()
  expect(st.pipelineRuns).toHaveLength(1)
  return st.pipelineRuns[0]
}

describe("wallet-username-resolver: a run where every lookup failed is not a success", () => {
  it("records ok=false when EVERY attempt errored", async () => {
    const row = await run(["0xa", "0xb", "0xc"], { "0xa": "ERR", "0xb": "ERR", "0xc": "ERR" })
    expect(row.ok, "3 of 3 lookups failed and the run still claimed success").toBe(false)
    expect(row.rows_written).toBe(0)
    expect(row.extra.errored).toBe(3)
  })

  it("names the count and the first cause, so the failure is triageable from the row alone", async () => {
    const row = await run(["0xa", "0xb"], { "0xa": "ERR", "0xb": "ERR" })
    expect(row.error).toBeTruthy()
    expect(row.error).toContain("2")
    // The reason must be the UPSTREAM status, not a generic string: identifying the
    // 2026-08-29 cause required reading another pipeline's error column entirely.
    expect(row.error).toContain("530")
    expect(row.extra.first_error_reason).toContain("530")
  })

  // ── Controls. Each one fails if `ok` is naively `errored === 0`. ──────────────

  it("CONTROL — a PARTIAL failure stays ok=true (one flaky address must not redden a working run)", async () => {
    const row = await run(["0xa", "0xb", "0xc"], { "0xa": "ERR", "0xb": "alice", "0xc": "bob" })
    expect(row.ok, "a run that resolved 2 of 3 is working, not failing").toBe(true)
    expect(row.extra.errored).toBe(1)
    expect(row.rows_written).toBe(2)
  })

  it("CONTROL — an EMPTY queue stays ok=true (nothing attempted is not a failure)", async () => {
    const row = await run([], {})
    expect(row.ok, "a drained backlog is this pipeline's healthy steady state").toBe(true)
    expect(row.rows_found).toBe(0)
    expect(row.error).toBeNull()
  })

  it("CONTROL — all MISSES stay ok=true (a wallet with no Top Shot profile is a real answer)", async () => {
    const row = await run(["0xa", "0xb"], { "0xa": "MISS", "0xb": "MISS" })
    expect(row.ok, "misses are answers; conflating them with errors would redden the steady state").toBe(true)
    expect(row.extra.errored).toBe(0)
    expect(row.rows_skipped).toBe(2)
  })
})
