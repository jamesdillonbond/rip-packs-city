// Golazos buyer-derived wallet discovery.
//
// The load-bearing guarantee is NEGATIVE: discovery must never dispatch a wallet
// scan for an address that is part of a Flowty/Dapper purchase ENVELOPE rather
// than a real collector. Measured against the live table on 2026-08-04, the raw
// candidate set is 18 buyers and exactly one of them —
// 0x3cdbb3d569211ff3, the Flowty storefront escrow — is not a wallet; it carries
// 40 unresolved sales on a lane dead since 2026-04-16 and has no collection to
// borrow from. Excluding it reproduces the 17 real collectors found by hand.
//
// These tests drive runDiscovery() directly rather than the handler, because the
// handler defers everything into after(); the auth guard is covered separately
// against the exported GET/POST.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { installFetchMock, jsonRoute } from "./helpers/route-harness"

// Mutable holder so each test swaps the Supabase fixture without re-importing.
const state = vi.hoisted(() => ({
  unmapped: { data: [] as any[] | null, error: null as any },
  scanState: { data: [] as any[] | null, error: null as any },
  rpcCalls: [] as Array<{ name: string; args: any }>,
  afterFn: null as null | (() => Promise<void>),
}))

// after() throws outside a request scope; capture the callback instead so the
// auth tests can reach the 202 AND assert the work was actually deferred.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return {
    ...actual,
    after: (fn: any) => {
      state.afterFn = fn
    },
  }
})

vi.mock("@/lib/supabase", () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {}
    for (const m of [
      "select", "eq", "is", "not", "gt", "in", "order", "limit",
    ]) {
      b[m] = () => b
    }
    const payload = () =>
      table === "unmapped_sales" ? state.unmapped : state.scanState
    b.then = (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(payload()).then(onF, onR)
    return b
  }
  return {
    supabaseAdmin: {
      from: (t: string) => builder(t),
      rpc: async (name: string, args: any) => {
        state.rpcCalls.push({ name, args })
        return { data: null, error: null }
      },
    },
  }
})

const ORIGIN = "https://t"
const STARTED = "2026-08-04T20:00:00.000Z"

function row(buyer: string | null) {
  return { buyer_address: buyer }
}

/** POST bodies sent to the Golazos scanner, in order. */
function dispatchedWallets(calls: { url: string; init?: RequestInit }[]) {
  return calls
    .filter((c) => c.url.includes("/api/wallet-backfill-golazos"))
    .map((c) => JSON.parse(String(c.init?.body ?? "{}")).wallet as string)
}

function lastRun() {
  const r = state.rpcCalls.filter((c) => c.name === "log_pipeline_run")
  return r[r.length - 1]?.args
}

let h: ReturnType<typeof installFetchMock>

beforeEach(() => {
  state.unmapped = { data: [], error: null }
  state.scanState = { data: [], error: null }
  state.rpcCalls = []
  state.afterFn = null
  process.env.INGEST_SECRET_TOKEN = "ingest-tok"
  process.env.CRON_SECRET = "cron-tok"
  // Collapse the inter-dispatch pacing so the cap test does not sleep 10s.
  process.env.GOLAZOS_DISCOVERY_GAP_MS = "0"
  h = installFetchMock([
    jsonRoute("/api/wallet-backfill-golazos", { accepted: true }, { status: 202 }),
  ])
})

afterEach(() => {
  h.restore()
  delete process.env.GOLAZOS_DISCOVERY_GAP_MS
})

describe("golazos-discover-buyers — envelope-address exclusion", () => {
  it("NEVER dispatches the Flowty storefront escrow, but does dispatch the real collector alongside it", async () => {
    const { runDiscovery } = await import(
      "@/app/api/cron/golazos-discover-buyers/route"
    )
    state.unmapped = {
      data: [
        row("0x3cdbb3d569211ff3"), // Flowty escrow — the live 18th candidate
        row("0xa21d74d8f73ef624"), // real collector, 23 unresolved sales
      ],
      error: null,
    }

    await runDiscovery(ORIGIN, STARTED)

    const sent = dispatchedWallets(h.calls)
    expect(sent).toEqual(["0xa21d74d8f73ef624"])
    expect(sent).not.toContain("0x3cdbb3d569211ff3")
    expect(lastRun().p_extra.excluded_envelope_addresses).toBe(1)
    expect(lastRun().p_extra.dispatched).toBe(1)
  })

  it("excludes the AllDay contract account — the address the aggregator heuristic was reaching for", async () => {
    const { runDiscovery } = await import(
      "@/app/api/cron/golazos-discover-buyers/route"
    )
    state.unmapped = {
      data: [row("0xe4cf4bdc1751c65d"), row("0xead892083b3e2c6c")],
      error: null,
    }

    await runDiscovery(ORIGIN, STARTED)

    expect(dispatchedWallets(h.calls)).toEqual([])
    expect(lastRun().p_extra.excluded_envelope_addresses).toBe(2)
  })

  it("normalises before matching, so a short/upper-case envelope address is still excluded", async () => {
    const { runDiscovery } = await import(
      "@/app/api/cron/golazos-discover-buyers/route"
    )
    // Same escrow, unpadded + upper-case. A raw string compare would miss it.
    state.unmapped = { data: [row("0x3CDBB3D569211FF3")], error: null }

    await runDiscovery(ORIGIN, STARTED)

    expect(dispatchedWallets(h.calls)).toEqual([])
  })
})

describe("golazos-discover-buyers — candidate selection", () => {
  it("does not re-dispatch a wallet already scanned for Golazos", async () => {
    const { runDiscovery } = await import(
      "@/app/api/cron/golazos-discover-buyers/route"
    )
    state.unmapped = {
      data: [row("0xaaaaaaaaaaaaaaaa"), row("0xbbbbbbbbbbbbbbbb")],
      error: null,
    }
    state.scanState = {
      data: [{ wallet_address: "0xaaaaaaaaaaaaaaaa" }],
      error: null,
    }

    await runDiscovery(ORIGIN, STARTED)

    expect(dispatchedWallets(h.calls)).toEqual(["0xbbbbbbbbbbbbbbbb"])
    expect(lastRun().p_extra.already_scanned).toBe(1)
  })

  it("dedupes a buyer appearing on many unresolved sales into ONE scan", async () => {
    const { runDiscovery } = await import(
      "@/app/api/cron/golazos-discover-buyers/route"
    )
    state.unmapped = {
      data: [
        row("0xa21d74d8f73ef624"),
        row("0xa21d74d8f73ef624"),
        row("0xa21d74d8f73ef624"),
      ],
      error: null,
    }

    await runDiscovery(ORIGIN, STARTED)

    expect(dispatchedWallets(h.calls)).toEqual(["0xa21d74d8f73ef624"])
    expect(lastRun().p_extra.unmapped_rows).toBe(3)
    expect(lastRun().p_extra.distinct_buyers).toBe(1)
  })

  it("skips null buyer_address rows — no wallet path can ever resolve them", async () => {
    const { runDiscovery } = await import(
      "@/app/api/cron/golazos-discover-buyers/route"
    )
    state.unmapped = { data: [row(null), row("0xcccccccccccccccc")], error: null }

    await runDiscovery(ORIGIN, STARTED)

    expect(dispatchedWallets(h.calls)).toEqual(["0xcccccccccccccccc"])
  })

  it("requests a FULL walk — a never-scanned wallet has no cache to diff against", async () => {
    const { runDiscovery } = await import(
      "@/app/api/cron/golazos-discover-buyers/route"
    )
    state.unmapped = { data: [row("0xcccccccccccccccc")], error: null }

    await runDiscovery(ORIGIN, STARTED)

    const body = JSON.parse(
      String(
        h.calls.find((c) => c.url.includes("/api/wallet-backfill-golazos"))?.init
          ?.body ?? "{}"
      )
    )
    expect(body.skip_cached).toBe(false)
  })
})

describe("golazos-discover-buyers — bounding is reported, never silent", () => {
  it("caps dispatches per tick and reports the deferred remainder", async () => {
    const { runDiscovery } = await import(
      "@/app/api/cron/golazos-discover-buyers/route"
    )
    // 30 distinct collectors; MAX_DISPATCH is 25.
    state.unmapped = {
      data: Array.from({ length: 30 }, (_, i) =>
        row("0x" + String(i).padStart(16, "d"))
      ),
      error: null,
    }

    await runDiscovery(ORIGIN, STARTED)

    expect(dispatchedWallets(h.calls)).toHaveLength(25)
    expect(lastRun().p_extra.candidates).toBe(30)
    expect(lastRun().p_extra.dispatched).toBe(25)
    expect(lastRun().p_extra.deferred_over_cap).toBe(5)
  })

  it("flags a capped candidate fetch so a truncated read is never read as 'saw the whole backlog'", async () => {
    const { runDiscovery } = await import(
      "@/app/api/cron/golazos-discover-buyers/route"
    )
    // 1000 rows = the PostgREST cap; all one buyer so dispatch stays at 1.
    state.unmapped = {
      data: Array.from({ length: 1000 }, () => row("0xa21d74d8f73ef624")),
      error: null,
    }

    await runDiscovery(ORIGIN, STARTED)

    expect(lastRun().p_extra.candidate_rows_capped).toBe(true)
  })

  it("does not flag the cap on a short read", async () => {
    const { runDiscovery } = await import(
      "@/app/api/cron/golazos-discover-buyers/route"
    )
    state.unmapped = { data: [row("0xa21d74d8f73ef624")], error: null }

    await runDiscovery(ORIGIN, STARTED)

    expect(lastRun().p_extra.candidate_rows_capped).toBe(false)
  })
})

describe("golazos-discover-buyers — failure honesty", () => {
  it("logs ok:false when the unmapped fetch errors, and dispatches nothing", async () => {
    const { runDiscovery } = await import(
      "@/app/api/cron/golazos-discover-buyers/route"
    )
    state.unmapped = { data: null, error: { message: "boom" } }

    await runDiscovery(ORIGIN, STARTED)

    expect(dispatchedWallets(h.calls)).toEqual([])
    expect(lastRun().p_ok).toBe(false)
    expect(lastRun().p_extra.stage).toBe("unmapped_fetch")
  })

  it("logs ok:false when the scan-state fetch errors, rather than re-scanning everyone", async () => {
    const { runDiscovery } = await import(
      "@/app/api/cron/golazos-discover-buyers/route"
    )
    state.unmapped = { data: [row("0xcccccccccccccccc")], error: null }
    state.scanState = { data: null, error: { message: "state down" } }

    await runDiscovery(ORIGIN, STARTED)

    expect(dispatchedWallets(h.calls)).toEqual([])
    expect(lastRun().p_ok).toBe(false)
    expect(lastRun().p_extra.stage).toBe("state_fetch")
  })

  it("logs ok:false when a dispatch is rejected, and keeps going", async () => {
    h.restore()
    h = installFetchMock([
      {
        match: (u) => u.includes("/api/wallet-backfill-golazos"),
        respond: (_u, init) => {
          const w = JSON.parse(String(init?.body ?? "{}")).wallet
          return w === "0xaaaaaaaaaaaaaaaa"
            ? { status: 500, json: { error: "nope" } }
            : { status: 202, json: { accepted: true } }
        },
      },
    ])
    const { runDiscovery } = await import(
      "@/app/api/cron/golazos-discover-buyers/route"
    )
    state.unmapped = {
      data: [row("0xaaaaaaaaaaaaaaaa"), row("0xbbbbbbbbbbbbbbbb")],
      error: null,
    }

    await runDiscovery(ORIGIN, STARTED)

    // both attempted; only the healthy one counts as dispatched
    expect(dispatchedWallets(h.calls)).toHaveLength(2)
    expect(lastRun().p_ok).toBe(false)
    expect(lastRun().p_extra.dispatched).toBe(1)
  })
})

describe("golazos-discover-buyers — auth", () => {
  it("401s with no bearer", async () => {
    const { GET } = await import("@/app/api/cron/golazos-discover-buyers/route")
    const res = await GET(
      new Request(`${ORIGIN}/api/cron/golazos-discover-buyers`) as any
    )
    expect(res.status).toBe(401)
  })

  it("401s on a wrong bearer", async () => {
    const { GET } = await import("@/app/api/cron/golazos-discover-buyers/route")
    const res = await GET(
      new Request(`${ORIGIN}/api/cron/golazos-discover-buyers`, {
        headers: { authorization: "Bearer nope" },
      }) as any
    )
    expect(res.status).toBe(401)
  })

  it("accepts INGEST_SECRET_TOKEN", async () => {
    const { GET } = await import("@/app/api/cron/golazos-discover-buyers/route")
    const res = await GET(
      new Request(`${ORIGIN}/api/cron/golazos-discover-buyers`, {
        headers: { authorization: "Bearer ingest-tok" },
      }) as any
    )
    expect(res.status).toBe(202)
  })

  // Vercel Cron sends ONLY CRON_SECRET. Accepting just INGEST_SECRET_TOKEN is
  // what made /api/cron/pinnacle-sync 401 on every scheduled tick for months.
  it("accepts CRON_SECRET, so the Vercel cron entry is not a silent 401", async () => {
    const { GET } = await import("@/app/api/cron/golazos-discover-buyers/route")
    const res = await GET(
      new Request(`${ORIGIN}/api/cron/golazos-discover-buyers`, {
        headers: { authorization: "Bearer cron-tok" },
      }) as any
    )
    expect(res.status).toBe(202)
  })

  it("defers the real work into after() rather than doing it inline", async () => {
    const { GET } = await import("@/app/api/cron/golazos-discover-buyers/route")
    state.unmapped = { data: [row("0xcccccccccccccccc")], error: null }

    await GET(
      new Request(`${ORIGIN}/api/cron/golazos-discover-buyers`, {
        headers: { authorization: "Bearer cron-tok" },
      }) as any
    )
    // nothing dispatched yet — it is queued, not run
    expect(dispatchedWallets(h.calls)).toEqual([])
    expect(state.afterFn).toBeTypeOf("function")

    await state.afterFn!()
    expect(dispatchedWallets(h.calls)).toEqual(["0xcccccccccccccccc"])
  })

  it("rejects an unauthorised request WITHOUT queuing any work", async () => {
    const { GET } = await import("@/app/api/cron/golazos-discover-buyers/route")
    await GET(
      new Request(`${ORIGIN}/api/cron/golazos-discover-buyers`, {
        headers: { authorization: "Bearer nope" },
      }) as any
    )
    expect(state.afterFn).toBeNull()
  })
})
