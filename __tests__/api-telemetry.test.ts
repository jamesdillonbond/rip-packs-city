import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/telemetry — the usage_events beacon.
// It NEVER returns a non-204 (telemetry must not surface as a UI error), so the
// interesting behavior is all in what it WRITES: the feature normalization
// (lowercase + non-alnum → _ + 80-char cap), the metadata JSON-safety/truncation
// guard, and the server-side identity resolution (allow_list wallet → user:<id>
// sentinel → "anon"). Captures the usage_events insert payload to assert them.

const state: {
  user: any
  userThrows: boolean
  allowRow: any
  insert: any
  afterWork: Promise<unknown> | null
} = {
  user: null,
  userThrows: false,
  allowRow: null,
  insert: null,
  afterWork: null,
}

// ⚠ The route defers its usage_events insert into `after()` (2026-08-27). Before
// that it was a FLOATING PROMISE, and on Vercel most beacons were never written:
// four identical anonymous POSTs returned four 204s and produced exactly ONE row.
// Two consequences for this file: `after()` throws outside a request scope, so the
// callback must be captured; and the deferred work must be DRAINED before assertions
// that read what it wrote.
// ⛔ BUT THE DRAIN IS NOT WHAT CATCHES A REGRESSION, and it would be easy to believe
// it is. The supabase mock records the insert payload SYNCHRONOUSLY, so every
// payload assertion below passes identically against a floating
// `.insert(...).then(...)` — measured 2026-08-27 by restoring that exact offender:
// tsc clean, 11/11 green. The ONLY assertion that separates the two is
// "registers the write as deferred work" below, which fails when `after()` is never
// called. Keep it, and do not add payload assertions expecting them to pin the shape.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { state.afterWork = fn() } }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => {
    if (state.userThrows) throw new Error("auth down")
    return state.user
  },
}))

vi.mock("@/lib/supabase", () => {
  const allowBuilder: any = {
    select: () => allowBuilder,
    ilike: () => allowBuilder,
    limit: () => allowBuilder,
    maybeSingle: async () => ({ data: state.allowRow }),
  }
  return {
    supabaseAdmin: {
      from: (t: string) => {
        if (t === "usage_events") {
          return {
            insert: (payload: any) => {
              state.insert = payload
              return { then: (res: any) => res({ error: null }) }
            },
          }
        }
        return allowBuilder
      },
    },
  }
})

import { POST } from "@/app/api/telemetry/route"

async function post(r: any) {
  state.afterWork = null
  const res = await POST(r)
  if (state.afterWork) await state.afterWork
  return res
}

const req = (body: any, isBad = false) =>
  ({ json: async () => { if (isBad) throw new Error("bad json"); return body } }) as any

beforeEach(() => {
  state.user = null
  state.userThrows = false
  state.allowRow = null
  state.insert = null
  state.afterWork = null
})

describe("POST /api/telemetry", () => {
  // ⚠ THE ONE ASSERTION THAT PINS THE 2026-08-27 FIX. The route must register its
  // usage_events write as DEFERRED work via next/server's `after()`. Before the fix it
  // was a floating `.insert(...).then(...)`, and on Vercel the lambda can be frozen the
  // moment the response returns — four identical anonymous POSTs in production produced
  // four 204s and exactly ONE row. A floating promise never calls `after()`, so
  // `state.afterWork` stays null here and this fails. ✅ Proven against that offender.
  it("registers the usage_events write as deferred after() work, not a floating promise", async () => {
    state.afterWork = null
    const res = await POST(req({ feature: "deferred_probe" }))
    expect(res.status).toBe(204)
    expect(state.afterWork).not.toBeNull()
    await state.afterWork
    expect(state.insert.feature_name).toBe("deferred_probe")
  })

  it("204s and writes nothing on an invalid JSON body", async () => {
    const res = await post(req(null, true))
    expect(res.status).toBe(204)
    expect(state.insert).toBeNull()
  })

  it("204s and writes nothing when feature is missing/blank", async () => {
    expect((await post(req({}))).status).toBe(204)
    expect((await post(req({ feature: "   " }))).status).toBe(204)
    expect(state.insert).toBeNull()
  })

  it("normalizes the feature (lowercase, non-alnum → _)", async () => {
    await post(req({ feature: "  Pack Sniper!!  " }))
    expect(state.insert.feature_name).toBe("pack_sniper__")
  })

  it("caps the feature at 80 chars", async () => {
    await post(req({ feature: "a".repeat(200) }))
    expect(state.insert.feature_name).toHaveLength(80)
  })

  it("resolves an authed user's wallet from allow_list", async () => {
    state.user = { id: "u1", email: "trevor@x.com" }
    state.allowRow = { wallet_addr: "0xabc" }
    await post(req({ feature: "view" }))
    expect(state.insert.wallet_address).toBe("0xabc")
  })

  it("falls back to the user:<id> sentinel when the user has no allow_list wallet", async () => {
    state.user = { id: "u1", email: "trevor@x.com" }
    state.allowRow = null
    await post(req({ feature: "view" }))
    expect(state.insert.wallet_address).toBe("user:u1")
  })

  it("uses 'anon' for an unauthenticated caller", async () => {
    state.user = null
    await post(req({ feature: "view" }))
    expect(state.insert.wallet_address).toBe("anon")
  })

  it("uses 'anon' when identity resolution throws", async () => {
    state.userThrows = true
    await post(req({ feature: "view" }))
    expect(state.insert.wallet_address).toBe("anon")
  })

  it("keeps small JSON-safe metadata", async () => {
    await post(req({ feature: "view", metadata: { tab: "market", n: 3 } }))
    expect(state.insert.metadata).toEqual({ tab: "market", n: 3 })
  })

  it("replaces oversized metadata with a truncation marker", async () => {
    const big = { blob: "x".repeat(5000) }
    await post(req({ feature: "view", metadata: big }))
    expect(state.insert.metadata._truncated).toBe(true)
    expect(state.insert.metadata._bytes).toBeGreaterThan(4096)
  })

  it("nulls non-object metadata", async () => {
    await post(req({ feature: "view", metadata: "not-an-object" }))
    expect(state.insert.metadata).toBeNull()
  })
})
