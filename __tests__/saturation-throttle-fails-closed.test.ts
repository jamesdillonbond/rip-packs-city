import { describe, it, expect, beforeEach, vi } from "vitest"

// BEHAVIOURAL proof for the saturation self-throttle: a count that fails by
// RETURNING an error must abandon the tick, exactly as a THROW already did.
//
// The nine routes carrying this guard each read the count as `count ?? 0`, so a
// returned error became 0, read as "no recent failures", and let the tick proceed
// during the saturation the guard exists to detect. The completeness half — that
// all nine (and any tenth) read the error at all — is
// `__tests__/saturation-throttle-reads-its-error.test.ts`. This file proves the
// runtime behaviour on a representative route so that guard is pinned to a real
// property rather than to a spelling.
//
// ⚠ WHY A BLANKET-ERROR STUB IS SOUND HERE, and why I first thought it was not.
// The obvious objection is that a stub returning an error for EVERY read cannot
// isolate the throttle read. It does not need to: the throttle is the FIRST read
// and it RETURNS EARLY, so on the failing path the route never reaches another
// query. Believing otherwise is what made this look like it needed nine
// hand-sequenced stubs — a cost estimate that was wrong, and worth recording,
// because it is the reason the fix nearly got filed instead of shipped.

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

const st = vi.hoisted(() => ({
  // null = the throttle count succeeds (gate open). Set to make it FAIL by
  // returning, which is the shape supabase-js actually produces for a 57014.
  countError: null as { message: string } | null,
  countThrows: false,
}))

const sbChain: any = {
  from: () => sbChain,
  select: () => sbChain,
  eq: () => sbChain,
  neq: () => sbChain,
  in: () => sbChain,
  not: () => sbChain,
  gte: () => sbChain,
  lt: () => sbChain,
  order: () => sbChain,
  limit: () => sbChain,
  update: () => sbChain,
  insert: () => sbChain,
  upsert: () => sbChain,
  maybeSingle: async () => ({ data: { done: true }, error: null }),
  single: async () => ({ data: { done: true }, error: null }),
  then: (r: any) => {
    if (st.countThrows) throw new Error("pool exhausted")
    if (st.countError) return r({ data: null, count: null, error: st.countError })
    return r({ data: [], error: null, count: 0 })
  },
}
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => sbChain, rpc: async () => ({ data: null, error: null }) },
}))

import { makeReq } from "./cron-req-helper"

const authed = () => makeReq({ method: "GET", auth: "Bearer test-ingest-token" })

async function load() {
  vi.resetModules()
  return (await import("@/app/api/cron/ufc-studio-sales-history-backfill/route")).GET
}

beforeEach(() => {
  st.countError = null
  st.countThrows = false
})

describe("saturation self-throttle fails CLOSED on an unreadable count", () => {
  it("a RETURNED count error abandons the tick", async () => {
    // The path that fires in production. Before the fix this fell through
    // `count ?? 0` and the walk proceeded.
    st.countError = { message: "canceling statement due to statement timeout" }
    const res = await (await load())(authed())
    const body = await res.json()
    expect(res.status).toBe(200) // a cron must not 5xx on a self-throttle
    expect(body.ok).toBe(false)
    expect(body.skipped).toBe("throttle_error")
    // ⚠ Not "saturation": that would claim we MEASURED saturation. We measured
    // nothing — the two outcomes must stay distinguishable in pipeline_runs.
    expect(body.skipped).not.toBe("saturation")
  })

  it("a THROWN count error abandons the tick the same way (unchanged behaviour)", async () => {
    // Regression pin on the half that was already correct, so a future edit
    // cannot fix the returned case by breaking the thrown one.
    st.countThrows = true
    const res = await (await load())(authed())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.skipped).toBe("throttle_error")
  })

  it("a SUCCESSFUL count below the threshold still opens the gate", async () => {
    // The other direction: the fix must not turn a healthy platform into a
    // permanently-throttled one, which would silently stop nine backfills.
    const res = await (await load())(authed())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.skipped).not.toBe("throttle_error")
    expect(body.skipped).not.toBe("saturation")
  })
})
