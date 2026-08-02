import { describe, it, expect, beforeEach, vi } from "vitest"

// PIPELINE OBSERVABILITY — app/api/allday-pack-listings (added by fa1d356,
// 2026-08-01). Companion to __tests__/pipeline-observability-ingest-routes.ts
// (which pins the synchronous invoked-marker and the happy complete row) and to
// the -ingest suite (which pins the grouping/upsert MATH). This file drives the
// log paths those two leave dark, all of them failure-shaped:
//
//  * the FATAL-CATCH around after(). This is the entire reason the wrapper was
//    added: an uncaught throw inside after() previously wrote nothing at all, so
//    a genuine crash and a Vercel-dropped after() produced byte-identical
//    evidence (one marker row, no completion). Pinned to emit ok:false with
//    failed_at:"uncaught" while STILL pairing to the marker via p_started_at.
//  * the two early-abort arms (editions fetch / cached_listings fetch). These
//    used to `return NextResponse.json(...)` from inside a deferred body — a
//    Response object thrown away by after(), i.e. a completely silent abort.
//  * the PARTIAL WRITE. rows_found vs rows_written diverging is the only way a
//    half-successful upsert sweep is visible; the route comment claims to report
//    it, so it is pinned in both the returned-error and thrown-error shapes.
//  * log_pipeline_run's own error/throw arms, so instrumentation can never take
//    the ingest down.

let capturedPromise: Promise<unknown> | null = null
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (p: Promise<unknown>) => { capturedPromise = p } }
})

const st = vi.hoisted(() => ({
  editions: { data: null as any[] | null, error: null as any },
  listings: { data: null as any[] | null, error: null as any },
  plcDelete: { error: null as any },
  upsert: { error: null as any },
  upsertThrows: false,
  editionsThrows: false,
  rpcResult: { data: null as any, error: null as any },
  rpcThrows: false,
  rpcCalls: [] as Array<{ name: string; args: any }>,
  upserted: [] as any[],
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      const b: any = {
        select: () => b,
        eq: () => b,
        range: () => b,
        delete: () => { b.__mode = "delete"; return b },
        upsert: (chunk: any[]) => {
          b.__mode = "upsert"
          if (st.upsertThrows) throw new Error("upsert transport exploded")
          st.upserted.push(...chunk)
          return b
        },
        then: (resolve: any) => {
          if (table === "editions") {
            if (st.editionsThrows) throw new Error("editions read exploded")
            return resolve(st.editions)
          }
          if (table === "cached_listings") return resolve(st.listings)
          if (table === "pack_listings_cache") {
            // The route awaits the SAME table for both the delete sweep and each
            // upsert chunk, so the stub must answer per-method or a delete-error
            // fixture would be masked by the upsert one.
            return resolve(b.__mode === "delete" ? st.plcDelete : st.upsert)
          }
          return resolve({ data: [], error: null })
        },
      }
      return b
    },
    rpc: async (name: string, args: any) => {
      st.rpcCalls.push({ name, args })
      if (st.rpcThrows && name === "log_pipeline_run") throw new Error("rpc transport exploded")
      return st.rpcResult
    },
  }),
}))

import { POST } from "@/app/api/allday-pack-listings/route"

const post = () => ({ headers: new Headers({ authorization: "Bearer tok" }) }) as any
const logs = () => st.rpcCalls.filter((c) => c.name === "log_pipeline_run").map((c) => c.args)

function edition(over: Record<string, unknown> = {}) {
  return {
    id: "e1",
    external_id: "ad-1",
    set_name: "Base Set",
    tier: "MOMENT_TIER_COMMON",
    series: 1,
    player_name: "Josh Allen",
    ...over,
  }
}
function listing(over: Record<string, unknown> = {}) {
  return { set_name: "Base Set", tier: "COMMON", ask_price: "12.5", thumbnail_url: null, ...over }
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "tok"
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.test"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "k"
  capturedPromise = null
  st.editions = { data: [], error: null }
  st.listings = { data: [], error: null }
  st.plcDelete = { error: null }
  st.upsert = { error: null }
  st.upsertThrows = false
  st.editionsThrows = false
  st.rpcResult = { data: null, error: null }
  st.rpcThrows = false
  st.rpcCalls = []
  st.upserted = []
})

describe("allday-pack-listings — the fatal-catch around after()", () => {
  it("an uncaught THROW inside the deferred body still writes an ok:false completion row", async () => {
    // Without this wrapper the throw escapes after() and NOTHING is written, so
    // a crash looks exactly like a dropped after(). The marker alone cannot
    // disambiguate — the failure row is what makes it a crash.
    st.editionsThrows = true

    await POST(post())
    await capturedPromise

    const l = logs()
    expect(l).toHaveLength(2)
    expect(l[0].p_extra).toEqual({ phase: "invoked" })
    expect(l[1].p_ok).toBe(false)
    expect(l[1].p_extra.phase).toBe("complete")
    expect(l[1].p_extra.failed_at).toBe("uncaught")
    expect(String(l[1].p_error)).toContain("editions read exploded")
    // Both rows share started_at so the pair reads as ONE run, not two.
    expect(l[1].p_started_at).toBe(l[0].p_started_at)
    expect(l[1].p_pipeline).toBe("allday-pack-listings")
    expect(l[1].p_collection_slug).toBe("nfl_all_day")
  })

  it("the marker is ok:true so a crashed run cannot double-count in v_pipeline_failure_rates", async () => {
    st.editionsThrows = true
    await POST(post())
    await capturedPromise
    const l = logs()
    expect(l[0].p_ok).toBe(true)
    expect(l.filter((r) => r.p_ok === false)).toHaveLength(1)
  })
})

describe("allday-pack-listings — early aborts that used to be silent", () => {
  it("an editions-fetch ERROR logs failed_at:editions_fetch and writes nothing", async () => {
    st.editions = { data: null, error: { message: "editions denied" } }

    await POST(post())
    await capturedPromise

    const l = logs()
    expect(l).toHaveLength(2)
    expect(l[1].p_ok).toBe(false)
    expect(l[1].p_extra.failed_at).toBe("editions_fetch")
    expect(String(l[1].p_error)).toContain("editions denied")
    expect(st.upserted).toHaveLength(0)
  })

  it("a cached_listings-fetch ERROR reports how many editions HAD loaded before the abort", async () => {
    // rows_found/editions carry the partial progress, so an abort at step 2 is
    // distinguishable from an abort at step 1 without reading the message.
    st.editions = { data: [edition(), edition({ id: "e2", external_id: "ad-2" })], error: null }
    st.listings = { data: null, error: { message: "listings denied" } }

    await POST(post())
    await capturedPromise

    const l = logs()
    expect(l[1].p_ok).toBe(false)
    expect(l[1].p_extra.failed_at).toBe("cached_listings_fetch")
    expect(l[1].p_extra.editions).toBe(2)
    expect(l[1].p_rows_found).toBe(2)
    expect(st.upserted).toHaveLength(0)
  })
})

describe("allday-pack-listings — partial writes are now reportable", () => {
  it("an upsert ERROR leaves rows_written < rows_found and counts the gap in rows_skipped", async () => {
    st.editions = { data: [edition()], error: null }
    st.listings = { data: [listing()], error: null }
    st.upsert = { error: { message: "upsert rejected" } }

    await POST(post())
    await capturedPromise

    const l = logs()
    expect(l[1].p_ok).toBe(true) // the sweep completed; it just wrote nothing
    expect(l[1].p_extra.phase).toBe("complete")
    expect(l[1].p_rows_found).toBeGreaterThan(0)
    expect(l[1].p_rows_written).toBe(0)
    expect(l[1].p_rows_skipped).toBe(l[1].p_rows_found)
  })

  it("a THROWN upsert is caught per-chunk and still reported as an under-write", async () => {
    st.editions = { data: [edition()], error: null }
    st.listings = { data: [listing()], error: null }
    st.upsertThrows = true

    await POST(post())
    await capturedPromise

    const l = logs()
    expect(l[1].p_rows_written).toBe(0)
    expect(l[1].p_rows_skipped).toBe(l[1].p_rows_found)
  })

  it("a delete ERROR is surfaced in extra.delete_error rather than swallowed", async () => {
    // A failed delete means the previous sweep's rows survive alongside the new
    // ones — stale packs on the board. It is non-fatal by design, so the log is
    // the only place it can be noticed.
    st.editions = { data: [edition()], error: null }
    st.listings = { data: [listing()], error: null }
    st.plcDelete = { error: { message: "delete blocked" } }

    await POST(post())
    await capturedPromise

    const l = logs()
    expect(l[1].p_extra.delete_error).toBe("delete blocked")
  })

  it("a clean sweep reports delete_error null and rows_written === rows_found", async () => {
    st.editions = { data: [edition()], error: null }
    st.listings = { data: [listing()], error: null }

    await POST(post())
    await capturedPromise

    const l = logs()
    expect(l[1].p_ok).toBe(true)
    expect(l[1].p_extra.delete_error).toBeNull()
    expect(l[1].p_rows_written).toBe(l[1].p_rows_found)
    expect(l[1].p_rows_skipped).toBe(0)
    expect(l[1].p_extra.editions_loaded).toBe(1)
    expect(l[1].p_extra.listings_loaded).toBe(1)
    expect(typeof l[1].p_extra.elapsed_ms).toBe("number")
  })

  it("groups listings by set::tier — lowest ask wins, count accumulates, first image sticks", async () => {
    // Drives the grouping arms the observability numbers are computed FROM: a
    // blank set_name is skipped, a non-positive ask is skipped, and a later row
    // backfills a missing thumbnail without overwriting a present one.
    st.editions = { data: [edition()], error: null }
    st.listings = {
      data: [
        listing({ ask_price: "20", thumbnail_url: null }),
        listing({ ask_price: "8", thumbnail_url: "http://img/a" }),
        listing({ ask_price: "0", thumbnail_url: "http://img/never" }), // non-positive -> skipped
        listing({ set_name: "   ", ask_price: "1" }), // blank set -> skipped
      ],
      error: null,
    }

    await POST(post())
    await capturedPromise

    const l = logs()
    expect(l[1].p_extra.listings_loaded).toBe(4)
    expect(l[1].p_extra.groups_with_listings).toBe(1)
    const row = st.upserted.find((r) => r.pack_name === "Base Set — COMMON")
    expect(row).toBeTruthy()
    expect(row.lowest_ask_usd).toBe(8) // lowest of 20 / 8 (0 and blank-set rows skipped)
    expect(row.total_listed).toBe(2) // only the two positive-ask Base Set rows
    expect(row.image_url).toBe("http://img/a") // backfilled from the row that had one
  })
})

describe("allday-pack-listings — instrumentation must never break the ingest", () => {
  it("swallows a log_pipeline_run ERROR result and still completes the sweep", async () => {
    st.editions = { data: [edition()], error: null }
    st.listings = { data: [listing()], error: null }
    st.rpcResult = { data: null, error: { message: "pipeline_runs full" } }

    const res = await POST(post())
    expect(res.status).toBe(200)
    await expect(capturedPromise).resolves.toBeUndefined()
    expect(st.upserted.length).toBeGreaterThan(0)
  })

  it("swallows a log_pipeline_run THROW — the invoked marker failing must not 500 the route", async () => {
    st.rpcThrows = true
    const res = await POST(post())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: "accepted" })
    await expect(capturedPromise).resolves.toBeUndefined()
  })
})
