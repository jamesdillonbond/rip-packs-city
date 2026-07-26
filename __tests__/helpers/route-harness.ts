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
 * A FetchStub that matches a GraphQL request by its `operationName` (parsed from
 * the POST body) rather than by URL — so a route that POSTs several operations to
 * the same endpoint can fixture each one. Pass a single `{ data }` response, or an
 * array to return a different page per call (for pagination loops); the last entry
 * repeats once the array is exhausted. This is Component B of the deep-loop layer
 * (see docs/audits/test-coverage-deep-loop-fixture-layer-2026-07-17.md) — used by
 * the GQL-fan-out routes (pack-ev's packEditionsV3 pagination, AllDay feed).
 */
export function gqlRoute(operationName: string, response: unknown | unknown[]): FetchStub {
  const pages = Array.isArray(response) ? response : [response]
  let call = 0
  return {
    match: (_url, init) => {
      const raw = init?.body
      if (typeof raw !== "string") return false
      try {
        const parsed = JSON.parse(raw)
        return parsed?.operationName === operationName || parsed?.query?.includes?.(operationName)
      } catch {
        return false
      }
    },
    respond: () => {
      const page = pages[Math.min(call, pages.length - 1)]
      call++
      return { json: page }
    },
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
  fixtures: Record<
    string,
    // `count` is part of the payload for a `.select(col, { count: "exact",
    // head: true })` read — a route that asks "how many rows are there" gets it
    // from the result envelope, not from data.length, so a fixture must be able
    // to supply it.
    | { data?: unknown; error?: unknown; count?: number | null }
    | Array<{ data?: unknown; error?: unknown; count?: number | null }>
  >,
): unknown {
  // Sequence-aware (Component B): if a fixture value is an ARRAY of payloads, each
  // successive query on that key consumes the next entry (the last repeats once
  // exhausted) — for a table queried multiple times with different expected shapes,
  // or a paginated read. A plain object is returned as-is on every call.
  const seq: Record<string, number> = {}
  const payload = (key: string) => {
    const f = fixtures[key]
    if (Array.isArray(f)) {
      const i = seq[key] ?? 0
      seq[key] = i + 1
      return f[Math.min(i, f.length - 1)] ?? { data: [], error: null }
    }
    return f ?? { data: [], error: null }
  }
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
    // Proper thenable: `.then` returns a real Promise so both `await builder` AND
    // `builder.then(cb).catch(cb)` (supabase-js supports the latter) work. Returning
    // the raw value here would break any `.then().catch()` chain in the route.
    b.then = (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(payload(table)).then(onF, onR)
    b.catch = (onR?: (e: unknown) => unknown) => Promise.resolve(payload(table)).catch(onR)
    b.finally = (cb?: () => void) => Promise.resolve(payload(table)).finally(cb)
    return b
  }
  return {
    from: (table: string) => makeBuilder(table),
    rpc: async (name: string) => payload(`rpc:${name}`),
  }
}

export interface RecordedRpcCall {
  name: string
  args: Record<string, unknown> | undefined
}

export interface RecordedWrite {
  method: "insert" | "upsert" | "update"
  rows: Record<string, unknown>[]
}

/**
 * makeSupabaseFixture plus observability: records every rpc(name, args) call and
 * every insert/upsert/update payload per table, so a deep-loop test can assert
 * on what the handler WROTE (e.g. the exact log_pipeline_run row an incident
 * exit path produces), not just on the response. `failWrites` lists tables whose
 * write methods THROW — the lever for driving a handler's fatal-catch path.
 */
export function makeInstrumentedSupabaseFixture(
  fixtures: Parameters<typeof makeSupabaseFixture>[0],
  opts: { failWrites?: string[] } = {},
): {
  fixture: unknown
  rpcCalls: RecordedRpcCall[]
  writes: Record<string, RecordedWrite[]>
} {
  const fixture = makeSupabaseFixture(fixtures) as {
    from: (t: string) => Record<string, unknown>
    rpc: (name: string, args?: Record<string, unknown>) => Promise<unknown>
  }
  const rpcCalls: RecordedRpcCall[] = []
  const writes: Record<string, RecordedWrite[]> = {}
  const baseRpc = fixture.rpc.bind(fixture)
  fixture.rpc = async (name, args) => {
    rpcCalls.push({ name, args })
    return baseRpc(name, args)
  }
  const baseFrom = fixture.from.bind(fixture)
  fixture.from = (table: string) => {
    const b = baseFrom(table)
    for (const method of ["insert", "upsert", "update"] as const) {
      const base = b[method] as (rows: unknown) => unknown
      b[method] = (rows: unknown) => {
        if (opts.failWrites?.includes(table)) {
          throw new Error(`forced ${table} ${method} failure`)
        }
        const arr = Array.isArray(rows) ? rows : [rows]
        ;(writes[table] ??= []).push({ method, rows: arr as Record<string, unknown>[] })
        return base(rows)
      }
    }
    return b
  }
  return { fixture, rpcCalls, writes }
}
