import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { adminReq } from "./helpers/admin-req"

// Route integration test for /api/admin/drain-conflated-subeditions (GET + POST
// share handle()). Auth via authed(): verifyAdminRequest OR INGEST_SECRET_TOKEN
// OR CRON_SECRET OR RPC_ADMIN_TOKEN (all request-time). None set =>
// fail-closed 401 on both verbs.

const h = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: any }>,
  // Per-RPC error injection. supabase-js RETURNS errors rather than throwing, so
  // this is the shape the route actually sees.
  rpcErrors: {} as Record<string, { code?: string; message: string } | undefined>,
}))

vi.mock("@/lib/supabase", () => {
  const sb: any = {
    rpc: async (fn: string, args: any) => {
      h.rpcCalls.push({ fn, args })
      const err = h.rpcErrors[fn]
      if (err) return { data: null, error: err }
      return { data: 0, error: null }
    },
    from: () => sb,
    insert: async () => ({ data: null, error: null }),
  }
  return { supabaseAdmin: sb }
})

// A Postgres statement-timeout cancellation, as PostgREST relays it.
const STATEMENT_TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" }

import { GET, POST } from "@/app/api/admin/drain-conflated-subeditions/route"

beforeEach(() => {
  h.rpcCalls.length = 0
  h.rpcErrors = {}
  delete process.env.RPC_ADMIN_TOKEN
  delete process.env.INGEST_SECRET_TOKEN
  delete process.env.CRON_SECRET
  // The edge-fn trigger step reads INGEST_SECRET_TOKEN; unset it so
  // triggerSubeditionBackfill short-circuits to "skipped:no_env" (no fetch).
  vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }))
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  delete process.env.INGEST_SECRET_TOKEN
  delete process.env.CRON_SECRET
  vi.unstubAllGlobals()
})

describe("/api/admin/drain-conflated-subeditions", () => {
  it("GET 401s when no secret is configured (fail-closed)", async () => {
    const res = await GET(adminReq("https://t/api/admin/drain-conflated-subeditions"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("POST 401s with a wrong bearer even when a secret is configured", async () => {
    process.env.INGEST_SECRET_TOKEN = "ingest"
    const res = await POST(adminReq("https://t/api/admin/drain-conflated-subeditions", { authorization: "Bearer nope" }))
    expect(res.status).toBe(401)
  })

  it("200s the orchestrator envelope when authed (all seed/remap RPCs mocked)", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await POST(adminReq("https://t/api/admin/drain-conflated-subeditions", { authorization: "Bearer secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.pipeline).toBe("drain-conflated-subeditions")

    // Per-step timing must reach the envelope (and so pipeline_runs.extra): this
    // route runs near its 300s maxDuration, and a bare duration_ms cannot say WHICH
    // of the nine steps consumed it.
    expect(Object.keys(body.step_ms ?? {})).toEqual(
      expect.arrayContaining(["split", "realign", "knots", "conflation_guard"])
    )
  })

  // The knot resolver's p_limit is a DRAIN RATE competing with an arrival rate, not
  // a taste knob. It sat at 5 from 2026-07-06 while the blocked queue grew ~+8.3
  // nfts/night (833→840→849→858 over the four retained runs), so the backlog was
  // divergent, not merely slow — 1,441 candidates against 5/night is ~288 nights on
  // a still-growing pool. Nothing caught that for weeks because the step reports
  // "resolved 5, skipped 0", which reads healthy: the LIMIT binds candidate
  // SELECTION before the loop, so 0-skipped only means none of the 5 it allowed
  // itself to see were rejected.
  //
  // This asserts the limit stays comfortably above the observed arrival rate rather
  // than pinning an exact number, so retuning is free but a silent revert to a
  // starving value reds CI. If arrival ever exceeds this, raise the limit — do not
  // relax the assertion.
  it("drains collision knots faster than they arrive (p_limit must beat ~8.3/night)", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    await POST(adminReq("https://t/api/admin/drain-conflated-subeditions", { authorization: "Bearer secret" }))

    const knot = h.rpcCalls.find((c) => c.fn === "resolve_topshot_subedition_collision_knots")
    expect(knot, "step 6 must still run — it is the only drain for transposed pairs").toBeTruthy()
    expect(knot!.args.p_limit).toBeGreaterThanOrEqual(50)

    // Route ordering is load-bearing: step 6 permutes pairs that 4/4b skipped, so it
    // must run after both, and after the on-chain resolve that gives it resolved nfts.
    const order = h.rpcCalls.map((c) => c.fn)
    expect(order.indexOf("resolve_topshot_subedition_collision_knots"))
      .toBeGreaterThan(order.indexOf("remap_topshot_realign_miskeyed_subeditions"))
    expect(order.indexOf("remap_topshot_realign_miskeyed_subeditions"))
      .toBeGreaterThan(order.indexOf("remap_topshot_split_resolved_subeditions"))
  })

  // ── `ok` must be REACHABLE ────────────────────────────────────────────────
  //
  // Several steps here are expected to be cancelled at their own 120s
  // statement_timeout; until 2026-08-18 each such cancellation populated an
  // `*_error` slot and `ok` is an AND over all of them, so `ok` was pinned false
  // on every tick — while the pipeline was demonstrably working (knot
  // resolutions 76 -> 272 between 08-15 and 08-17, ~1,000 rows/run). A pipeline
  // that cannot report success is indistinguishable from a broken one.
  //
  // These pin the PROPERTY, not the spelling: a truncation must not be able to
  // claim failure, and a real failure must not be able to claim success.
  describe("a by-design cutoff is not a failure", () => {
    it("a clean run reports no truncations (control — the array must be satisfiable at zero)", async () => {
      process.env.RPC_ADMIN_TOKEN = "secret"
      const body = await (await POST(adminReq("https://t/api/admin/drain-conflated-subeditions", { authorization: "Bearer secret" }))).json()
      expect(body.ok).toBe(true)
      expect(body.truncated_steps).toEqual([])
    })

    it("a statement-timeout cutoff still reports ok, and names the step instead of erroring", async () => {
      process.env.RPC_ADMIN_TOKEN = "secret"
      h.rpcErrors["seed_topshot_recent_base_subedition_targets"] = STATEMENT_TIMEOUT
      h.rpcErrors["remap_topshot_realign_miskeyed_subeditions"] = STATEMENT_TIMEOUT

      const body = await (await POST(adminReq("https://t/api/admin/drain-conflated-subeditions", { authorization: "Bearer secret" }))).json()

      expect(body.ok, "a rolled-back, retried-next-tick cutoff must not red the run").toBe(true)
      // Visible, never silent — the same contract skipped_steps carries.
      expect(body.truncated_steps).toEqual(expect.arrayContaining(["seed_recent", "realign"]))
      expect(body.seed_recent_truncated).toMatch(/statement timeout/i)
      // And it must NOT occupy the slot the ok conjunction reads.
      expect(body.seed_recent_error).toBeUndefined()
      expect(body.realign_error).toBeUndefined()
    })

    it("a genuine seed failure still reds the run (mirror — the reclassification must not fail open)", async () => {
      process.env.RPC_ADMIN_TOKEN = "secret"
      h.rpcErrors["seed_topshot_recent_base_subedition_targets"] = {
        code: "23505",
        message: "duplicate key value violates unique constraint",
      }

      const body = await (await POST(adminReq("https://t/api/admin/drain-conflated-subeditions", { authorization: "Bearer secret" }))).json()

      expect(body.ok).toBe(false)
      expect(body.seed_recent_error).toMatch(/duplicate key/i)
      expect(body.truncated_steps).toEqual([])
    })

    it("a GATEWAY timeout is not reclassified — same ~2min, different meaning", async () => {
      process.env.RPC_ADMIN_TOKEN = "secret"
      // The Supabase gateway timeout and the Postgres statement timeout both land
      // at ~2 minutes; only the latter is a rolled-back statement this route asked
      // for. Matching on duration would conflate them, so the match is on 57014 /
      // the cancel text and nothing else.
      h.rpcErrors["seed_topshot_recent_base_subedition_targets"] = { message: "upstream request timeout" }

      const body = await (await POST(adminReq("https://t/api/admin/drain-conflated-subeditions", { authorization: "Bearer secret" }))).json()

      expect(body.ok).toBe(false)
      expect(body.seed_recent_error).toBe("upstream request timeout")
      expect(body.truncated_steps).toEqual([])
    })

    it("every error slot the ok conjunction reads has a truncation counterpart (no slot left behind)", async () => {
      process.env.RPC_ADMIN_TOKEN = "secret"
      // Derived from the route source rather than a curated list, so a tenth step
      // added later cannot quietly opt out of the classification.
      const src = readFileSync(
        join(process.cwd(), "app/api/admin/drain-conflated-subeditions/route.ts"),
        "utf8",
      )
      const okLine = src.split("\n").find((l) => l.includes("const ok = !out.fatal"))
      expect(okLine, "the ok conjunction must still be a single readable expression").toBeTruthy()
      const slots = [...okLine!.matchAll(/!out\.([a-z_]+)/g)].map((m) => m[1]).filter((k) => k.endsWith("_error"))
      expect(slots.length).toBeGreaterThanOrEqual(9)
      for (const slot of slots) {
        expect(src, `${slot} must be written through stepFailed(), not assigned directly`)
          .not.toMatch(new RegExp(`out\\.${slot}\\s*=`))
        expect(src).toContain(`"${slot}"`)
      }
    })
  })
})
