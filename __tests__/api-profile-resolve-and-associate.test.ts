import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for /api/profile/resolve-and-associate (POST only).
// getCurrentUser cookie-auth-gated (with a 250ms one-shot retry) → 401. Guards:
// JSON-body / username, resolver 404 / 502, upsert 500. The success path returns
// { username, walletAddress, associatedCollections } AND schedules an after()
// warm — captured here and driven so its legs are exercised: the DEEP
// multicollection backfill dispatch (the 2026-08-08 fix for open-door signups
// landing page-capped at 50 Top Shot moments and 0 elsewhere), the shallow
// first-paint Top Shot wallet-search, non-ok warns, fetch throws, and the
// aggregate RPC ok/error/throw.

const captured: { fn: null | (() => Promise<void>) } = { fn: null }
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: any) => { captured.fn = fn } }
})

const state: { user: any; resolved: any; resolveThrows: boolean; upsertErr: any; rpc: any; userRetry: boolean } = {
  user: null, resolved: null, resolveThrows: false, upsertErr: null, rpc: { data: 3, error: null }, userRetry: false,
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = { select: () => b, upsert: () => b, eq: () => b, then: (resolve: any) => resolve({ data: null, error: state.upsertErr }) }
    return b
  }
  const client: any = { from: () => build(), rpc: async () => { if (state.rpc?.throws) throw new Error("rpc boom"); return state.rpc } }
  return { supabase: client, supabaseAdmin: client }
})

let userCalls = 0
vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => {
    userCalls++
    if (state.userRetry) return userCalls >= 2 ? state.user : null // null first, then present
    return state.user
  },
}))
// ⚠ MOCKS THE CACHE-AWARE RESOLVER, because that is what the route calls as of
// 2026-09-03. It used to call `resolveTopShotUsername` — live Top Shot GQL and
// nothing else — so every username signup 502'd whenever
// `public-api.nbatopshot.com` was down, even for the 9,370 handles already in
// `wallet_usernames`. The layered resolver was already in the tree, used by the
// ANONYMOUS home analyzer; the signed-in path had the worse implementation.
//
// The mock returns the real `ResolveOutcome` union, not a nullable object,
// because the ROUTE'S 404-vs-502 branch now keys on `reason` — a discrimination
// a `null` return cannot express.
vi.mock("@/lib/chains/flow/topshot-username-resolve", () => ({
  resolveTopShotUsernameCacheAware: async () => {
    if (state.resolveThrows) return { found: false, reason: "topshot_gql_error", detail: "gql down" }
    if (!state.resolved) return { found: false, reason: "username_not_found_on_topshot" }
    return { found: true, ...state.resolved, source: "wallet_usernames", cacheLayer: "wallet_usernames" }
  },
}))

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { POST } from "@/app/api/profile/resolve-and-associate/route"

const req = (body?: any, throws = false) => ({ url: "https://t/api/profile/resolve-and-associate", json: async () => { if (throws) throw new Error("bad json"); return body } }) as any

let fetchMock: any
beforeEach(() => {
  state.user = null; state.resolved = null; state.resolveThrows = false; state.upsertErr = null; state.rpc = { data: 3, error: null }; state.userRetry = false
  userCalls = 0; captured.fn = null
  delete process.env.INGEST_SECRET_TOKEN
  fetchMock = vi.fn(async (url: string) => ({ ok: true, status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe("POST /api/profile/resolve-and-associate — guards", () => {
  it("401s when unauthenticated (both attempts null)", async () => {
    const res = await POST(req({ username: "trevor" }))
    expect(res.status).toBe(401)
    expect(userCalls).toBe(2) // proves the 250ms retry ran
  })
  it("recovers on the retry when the cookie settles late", async () => {
    state.userRetry = true
    state.user = { id: "u1" }
    state.resolved = { walletAddress: "0xbd94cade097e50ac", username: "trevor" }
    expect((await POST(req({ username: "trevor" }))).status).toBe(200)
  })
  it("400s on invalid JSON", async () => {
    state.user = { id: "u1" }
    expect((await POST(req(undefined, true))).status).toBe(400)
  })
  it("400s when username is missing", async () => {
    state.user = { id: "u1" }
    expect((await POST(req({ username: "  " }))).status).toBe(400)
  })
  it("404s when the username can't be resolved", async () => {
    state.user = { id: "u1" }
    expect((await POST(req({ username: "ghost" }))).status).toBe(404)
  })
  it("502s when the Top Shot directory throws", async () => {
    state.user = { id: "u1" }; state.resolveThrows = true
    expect((await POST(req({ username: "trevor" }))).status).toBe(502)
  })
  it("502s on a cache MISS during an outage, and 404s only when Top Shot answered 'no such user'", async () => {
    // 🚨 THE DISCRIMINATION IS THE FIX. `username_not_found_on_topshot` is a real
    // answer about the handle; `not_in_any_cache` (and `topshot_gql_error`) mean
    // WE could not look. The old code could not tell them apart — the live
    // resolver returned `null` for both, so an outage rendered as "no such
    // Dapper username" on a signup form, which sends a real user away believing
    // their handle is wrong.
    state.user = { id: "u1" }
    state.resolved = null
    // Reason-carrying miss: not a 404.
    const mod = await import("@/lib/chains/flow/topshot-username-resolve")
    const spy = vi
      .spyOn(mod, "resolveTopShotUsernameCacheAware")
      .mockResolvedValue({ found: false, reason: "not_in_any_cache" } as never)
    try {
      const res = await POST(req({ username: "someone" }))
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body.error).toMatch(/Couldn.t reach the Top Shot directory/i)
      expect(
        body.error,
        "an outage must not be reported as a bad username",
      ).not.toMatch(/Couldn.t find that Dapper username/i)
    } finally {
      spy.mockRestore()
    }
  })

  it("400s on a whitespace-only handle instead of blaming the directory", async () => {
    // The mirror image of the bug being fixed: reporting OUR failure as the
    // user's is the defect, and reporting the USER'S bad input as our outage is
    // the same error pointed the other way. The `!rawUsername` guard above only
    // catches a missing field.
    state.user = { id: "u1" }
    const mod = await import("@/lib/chains/flow/topshot-username-resolve")
    const spy = vi
      .spyOn(mod, "resolveTopShotUsernameCacheAware")
      .mockResolvedValue({ found: false, reason: "empty_username" } as never)
    try {
      const res = await POST(req({ username: "   " }))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).not.toMatch(/Couldn.t reach the Top Shot directory/i)
    } finally {
      spy.mockRestore()
    }
  })

  it("the route reads the LAYERED resolver, not live GQL — otherwise the fix is inert", () => {
    // A behavioural test cannot see this: the resolver is mocked, so a route
    // calling the live-only function would still pass every case above. The
    // property that makes the fix real is WHICH resolver it calls.
    const src = readFileSync(
      join(process.cwd(), "app/api/profile/resolve-and-associate/route.ts"),
      "utf8",
    )
    expect(src).toMatch(/resolveTopShotUsernameCacheAware\(\s*supabase\s*,/)
    // …and the live-only one is gone. `wallet-search` kept the good pattern for
    // months while this route did not; the regression is a one-word edit.
    expect(src).not.toMatch(/\bresolveTopShotUsername\(/)
  })

  it("500s when the saved_wallets upsert fails", async () => {
    state.user = { id: "u1" }; state.resolved = { walletAddress: "0xabc", username: "t" }; state.upsertErr = { message: "upsert down" }
    expect((await POST(req({ username: "t" }))).status).toBe(500)
  })
})

describe("POST /api/profile/resolve-and-associate — success + after() fan-out", () => {
  async function run(over: Partial<typeof state> = {}) {
    state.user = { id: "u1" }
    state.resolved = { walletAddress: "0xbd94cade097e50ac", username: "trevor" }
    Object.assign(state, over)
    const res = await POST(req({ username: "trevor" }))
    return res
  }

  it("200s and lists the associated collections", async () => {
    const body = await (await run()).json()
    expect(body.username).toBe("trevor")
    expect(body.associatedCollections.length).toBeGreaterThan(0)
    expect(captured.fn).toBeTypeOf("function")
  })

  it("after(): dispatches the DEEP multicollection backfill and calls the aggregate RPC (INGEST set)", async () => {
    process.env.INGEST_SECRET_TOKEN = "ingest-tok"
    await run()
    await captured.fn!()
    const urls = fetchMock.mock.calls.map((c: any[]) => String(c[0]))
    expect(urls.some((u: string) => u.includes("/api/wallet-backfill-multicollection"))).toBe(true)
    // …carrying the INGEST bearer and skip_cached:false so a page-capped
    // cache is fully re-walked rather than skipped.
    const deep = fetchMock.mock.calls.find((c: any[]) =>
      String(c[0]).includes("wallet-backfill-multicollection"))
    expect(deep![1].headers.Authorization).toBe("Bearer ingest-tok")
    expect(JSON.parse(deep![1].body)).toEqual({
      wallet: "0xbd94cade097e50ac",
      skip_cached: false,
    })
    // …plus the shallow Top Shot pass for first paint only.
    const search = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes("/api/wallet-search"))
    expect(search).toBeTruthy()
    expect(JSON.parse(search![1].body).collectionId).toBe("nba-top-shot")
    // The old per-collection shallow fan-out is GONE — that was the under-warm bug.
    expect(urls.filter((u: string) => u.includes("/api/wallet-search")).length).toBe(1)
    expect(urls.some((u: string) => u.includes("/api/ufc-wallet-scan"))).toBe(false)
  })

  it("after(): skips the deep warm when INGEST_SECRET_TOKEN is unset (would 401)", async () => {
    await run() // beforeEach deletes the env var
    await captured.fn!()
    const urls = fetchMock.mock.calls.map((c: any[]) => String(c[0]))
    expect(urls.some((u: string) => u.includes("wallet-backfill-multicollection"))).toBe(false)
    // first paint still happens
    expect(urls.some((u: string) => u.includes("/api/wallet-search"))).toBe(true)
  })

  it("after(): tolerates non-ok HTTP and fetch throws + an aggregate RPC error", async () => {
    process.env.INGEST_SECRET_TOKEN = "ingest-tok"
    state.rpc = { data: null, error: { message: "rpc err" } }
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("wallet-backfill-multicollection")) return { ok: false, status: 503 }
      throw new Error("network down") // wallet-search throws
    })
    vi.stubGlobal("fetch", fetchMock)
    await run()
    await expect(captured.fn!()).resolves.toBeUndefined() // never throws
  })

  it("after(): tolerates an aggregate RPC that throws", async () => {
    state.rpc = { throws: true }
    await run()
    await expect(captured.fn!()).resolves.toBeUndefined()
  })
})
