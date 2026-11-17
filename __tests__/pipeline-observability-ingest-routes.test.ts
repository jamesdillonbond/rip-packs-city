import { describe, it, expect, beforeEach, vi } from "vitest"

// DEFECT 1 REGRESSION GUARD (2026-08-01).
//
// app/api/allday-pack-listings/route.ts and app/api/pinnacle-sales-indexer/route.ts
// are BOTH live cron-driven ingests that shipped with NO log_pipeline_run call of
// any kind. They were therefore invisible to pipeline_runs,
// detect_stalled_pipelines() and pipeline_cadence_watchlist: each was verifiably
// working only by inspecting its DESTINATION TABLE, and had either silently
// stopped, nothing would have paged.
//
// These tests pin the observability itself — not the ingest math, which the
// sibling *-ingest / *-deep suites already cover. The specific things that must
// not regress:
//   * allday-pack-listings emits a SYNCHRONOUS phase:"invoked" marker BEFORE
//     after() is scheduled, so "after() was dropped" stays distinguishable from
//     "the route was never reached". A completion row alone cannot do that.
//   * pinnacle-sales-indexer is synchronous and logs on EVERY terminal path,
//     including the no-op "already up to date" tick — a watchlist keyed on
//     SILENCE cannot tell a quiet chain from a dead pipeline unless quiet ticks
//     are still recorded.

// ── allday-pack-listings ────────────────────────────────────────────────────
describe("allday-pack-listings — pipeline observability", () => {
  let capturedPromise: Promise<unknown> | null = null
  const calls: any[] = []
  const hbRows: any[] = []

  beforeEach(() => {
    vi.resetModules()
    calls.length = 0
    hbRows.length = 0
    capturedPromise = null
    process.env.INGEST_SECRET_TOKEN = "tok"
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.test"
    process.env.SUPABASE_SERVICE_ROLE_KEY = "k"
  })

  async function load() {
    vi.doMock("next/server", async (importOriginal) => {
      const actual = await importOriginal<typeof import("next/server")>()
      return { ...actual, after: (p: Promise<unknown>) => { capturedPromise = p } }
    })
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        from(table?: string) {
          // The invocation marker is a `pipeline_runs` INSERT since 2026-08-20
          // (lib/pipeline/heartbeat.ts), not a self-named log_pipeline_run row.
          if (table === "pipeline_runs") {
            return { insert: async (row: any) => { hbRows.push(row); return { error: null } } }
          }
          const b: any = {
            select: () => b, eq: () => b, order: () => b, range: () => b, delete: () => b,
            upsert: () => b,
            then: (resolve: any) => resolve({ data: [], error: null }),
          }
          return b
        },
        rpc: async (name: string, args: any) => { calls.push({ name, args }); return { data: null, error: null } },
      }),
    }))
    return await import("@/app/api/allday-pack-listings/route")
  }

  const post = () => ({ headers: new Headers({ authorization: "Bearer tok" }) }) as any

  it("writes a synchronous invocation marker BEFORE after() is scheduled", async () => {
    const { POST } = await load()
    await POST(post())
    // Asserted BEFORE awaiting the captured promise: the marker must already
    // exist purely from the synchronous part of the handler. That ordering is
    // the whole point — a marker written after the work cannot survive the kill
    // it exists to record.
    expect(hbRows).toHaveLength(1)
    expect(hbRows[0].collection_slug).toBe("nfl_all_day")
    expect(hbRows[0].ok).toBe(true)

    // ⚠ AND IT MUST NOT BE UNDER THE PIPELINE'S OWN NAME. It was until
    // 2026-08-20, and that silenced the very alarm it was added to protect:
    // `detect_stalled_pipelines()` takes max(started_at) with no phase filter,
    // so a self-named marker refreshed `last_run` on every tick. This route ran
    // 212 markers against 208 completions — 6 dead ticks behind a 90-min arm,
    // none of which could ever fire.
    expect(hbRows[0].pipeline).toBe("allday-pack-listings-heartbeat")
    expect(calls.filter((c) => c.name === "log_pipeline_run")).toHaveLength(0)
  })

  it("writes a phase:complete row once the deferred body finishes", async () => {
    const { POST } = await load()
    await POST(post())
    await capturedPromise
    const logs = calls.filter((c) => c.name === "log_pipeline_run")
    expect(logs.length).toBe(1)
    expect(logs[0].args.p_extra.phase).toBe("complete")
    expect(logs[0].args.p_ok).toBe(true)
    // The marker and the completion still share one started_at, so they pair up
    // as a single run for the kill-detection correlation.
    expect(logs[0].args.p_started_at).toBe(hbRows[0].started_at)
  })

  it("does NOT log when the request is unauthorized", async () => {
    const { POST } = await load()
    await POST({ headers: new Headers({ authorization: "Bearer nope" }) } as any)
    expect(calls.filter((c) => c.name === "log_pipeline_run")).toHaveLength(0)
    // Nor a marker: "heartbeat only" must keep meaning "killed mid-flight", not
    // "someone probed the endpoint without a token".
    expect(hbRows).toHaveLength(0)
  })
})

// ── pinnacle-sales-indexer ──────────────────────────────────────────────────
describe("pinnacle-sales-indexer — pipeline observability", () => {
  const calls: any[] = []
  const st = { cursor: 100, cursorErr: null as any }

  beforeEach(() => {
    vi.resetModules()
    calls.length = 0
    st.cursor = 100
    st.cursorErr = null
    process.env.INGEST_SECRET_TOKEN = "tok"
  })

  async function load() {
    vi.doMock("@/lib/supabase", () => ({
      supabaseAdmin: {
        from() {
          const b: any = {
            select: () => b, eq: () => b, in: () => b, update: () => b,
            single: async () => ({ data: { last_processed_block: st.cursor }, error: st.cursorErr }),
            then: (resolve: any) => resolve({ data: [], error: null }),
          }
          return b
        },
        rpc: async (name: string, args: any) => { calls.push({ name, args }); return { data: null, error: null } },
      },
    }))
    vi.doMock("@/lib/pipeline-chain", () => ({ fireNextPipelineStep: async () => {} }))
    // Chain height below the cursor => the "already up to date" no-op tick.
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify([{ header: { height: "50" } }]), { status: 200 }))
    return await import("@/app/api/pinnacle-sales-indexer/route")
  }

  const req = () => ({
    headers: new Headers({ authorization: "Bearer tok" }),
    nextUrl: new URL("https://t/api/pinnacle-sales-indexer"),
  }) as any

  it("logs the NO-OP 'already up to date' tick — a quiet chain must not look dead", async () => {
    const { POST } = await load()
    const res = await POST(req())
    expect(res.status).toBe(200)
    const logs = calls.filter((c) => c.name === "log_pipeline_run")
    expect(logs.length).toBe(1)
    expect(logs[0].args.p_pipeline).toBe("pinnacle-sales-indexer")
    expect(logs[0].args.p_collection_slug).toBe("disney_pinnacle")
    expect(logs[0].args.p_ok).toBe(true)
    expect(logs[0].args.p_extra.phase).toBe("up_to_date")
  })

  it("logs ok:false when the cursor read fails", async () => {
    st.cursorErr = { message: "cursor boom" }
    const { POST } = await load()
    const res = await POST(req())
    expect(res.status).toBe(500)
    const logs = calls.filter((c) => c.name === "log_pipeline_run")
    expect(logs.length).toBe(1)
    expect(logs[0].args.p_ok).toBe(false)
    expect(logs[0].args.p_error).toContain("cursor boom")
    expect(logs[0].args.p_extra.phase).toBe("cursor_read_failed")
  })

  it("does NOT log when the request is unauthorized", async () => {
    const { POST } = await load()
    await POST({
      headers: new Headers({ authorization: "Bearer nope" }),
      nextUrl: new URL("https://t/api/pinnacle-sales-indexer"),
    } as any)
    expect(calls.filter((c) => c.name === "log_pipeline_run")).toHaveLength(0)
  })
})
