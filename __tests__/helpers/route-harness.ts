// Reusable route-integration harness.
//
// Route handlers under app/api/**/route.ts reach the outside world through two
// seams: (1) global fetch (Top Shot / AllDay / Flowty / Flow REST), and (2) the
// Supabase client. The existing route tests mostly exercise auth/param guards;
// driving the actual happy-path body means faithfully stubbing those two seams.
// This module makes that declarative instead of hand-wired per test, so adding
// coverage for a real handler flow is a few lines of fixtures, not a bespoke mock.
//
// Usage (see __tests__/api-edition-floor-integration.test.ts for a worked POC):
//
//   const h = installFetchMock([
//     jsonRoute("nbatopshot.com", { data: { ...gql... } }),
//     jsonRoute("flowty.io", { nfts: [ ...listings... ] }),
//   ])
//   const res = await GET(new Request("https://t/api/x?..."))
//   ...assert on res + h.calls...
//   h.restore()
//
// Keep this file free of `.test.` in its name so vitest does not collect it as a
// suite — it is a helper, imported by suites.

import { vi } from "vitest"

export interface FetchStub {
  /** Return true if this stub should handle the request. */
  match: (url: string, init?: RequestInit) => boolean
  /** Build the response for a matched request. */
  respond: (url: string, init?: RequestInit) => {
    status?: number
    ok?: boolean
    json?: unknown
    text?: string
  }
}

export interface InstalledFetchMock {
  /** Every fetch call made, in order — assert on request bodies/urls. */
  calls: { url: string; init?: RequestInit }[]
  /** Remove the stub and restore the real global fetch. */
  restore: () => void
}

/**
 * Replace global fetch with a stub that dispatches to the first matching
 * FetchStub. An unmatched request throws (loudly) so a test can never silently
 * hit a real endpoint or pass on an unexpected call.
 */
export function installFetchMock(stubs: FetchStub[]): InstalledFetchMock {
  const calls: { url: string; init?: RequestInit }[] = []
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input && typeof input === "object" && "url" in input
          ? String((input as { url: unknown }).url)
          : String(input)
    calls.push({ url, init })
    const stub = stubs.find((s) => s.match(url, init))
    if (!stub) throw new Error(`route-harness: no fetch stub matched ${url}`)
    const r = stub.respond(url, init)
    const status = r.status ?? 200
    const ok = r.ok ?? (status >= 200 && status < 300)
    return {
      ok,
      status,
      json: async () => r.json ?? {},
      text: async () => r.text ?? JSON.stringify(r.json ?? {}),
    } as unknown as Response
  })
  vi.stubGlobal("fetch", fn)
  return { calls, restore: () => vi.unstubAllGlobals() }
}

/** A FetchStub that matches when the request URL contains `urlSubstring` and
 *  returns `json` (optionally with a non-200 status). */
export function jsonRoute(
  urlSubstring: string,
  json: unknown,
  opts: { status?: number; ok?: boolean } = {},
): FetchStub {
  return {
    match: (url) => url.includes(urlSubstring),
    respond: () => ({ json, status: opts.status, ok: opts.ok }),
  }
}

/**
 * Build a chainable Supabase-client stub whose awaited query resolves to fixture
 * data keyed by table name. Every builder method returns the same object so any
 * chain (.select().eq().in().order()...) is valid; awaiting it (or calling
 * .single()/.maybeSingle()) yields the fixture for the table passed to .from().
 * rpc(name) resolves to the fixture keyed by `rpc:<name>` (or an empty result).
 *
 * This mirrors the ad-hoc builder used in api-fmv.test.ts, promoted here for reuse.
 */
export function makeSupabaseFixture(
  fixtures: Record<string, { data?: unknown; error?: unknown }>,
): unknown {
  const payload = (key: string) => fixtures[key] ?? { data: [], error: null }
  const makeBuilder = (table: string) => {
    const b: Record<string, unknown> = {}
    const chain =
      (...args: unknown[]) =>
      () =>
        b
    for (const m of [
      "select", "insert", "update", "upsert", "delete", "eq", "neq", "in", "is",
      "not", "or", "and", "gte", "lte", "gt", "lt", "order", "limit", "range", "match",
      "returns", "filter", "ilike", "like", "contains", "containedBy", "overlaps",
      "textSearch", "csv", "abortSignal",
    ]) {
      b[m] = chain()
    }
    b.single = async () => payload(table)
    b.maybeSingle = async () => payload(table)
    // Thenable: `await supabase.from(t).select()...` resolves to the fixture.
    b.then = (resolve: (v: unknown) => unknown) => resolve(payload(table))
    return b
  }
  return {
    from: (table: string) => makeBuilder(table),
    rpc: async (name: string) => payload(`rpc:${name}`),
  }
}
