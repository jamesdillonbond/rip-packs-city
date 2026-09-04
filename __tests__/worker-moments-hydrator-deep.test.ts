import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"

// ── topshot-moments-hydrator: the DEEP path ────────────────────────────────
//
// The sibling worker-moments-hydrator-handler.test.ts covers the entry gate and
// the two candidate-read outcomes, and says so explicitly:
//
//     "The deep GraphQL/edition-resolve/write path (env.TOPSHOT_PROXY fan-out)
//      is intentionally out of scope here"
//
// That honest exclusion IS the coverage hole: measured 2026-08-15 when the
// worker gate landed, workers/topshot-moments-hydrator/index.ts sat at
// **26.3% statements / 29.9% branches** — the worst file in `workers/**` — and
// everything below this line is what was dark.
//
// ── WHY IT IS WORTH DRIVING ────────────────────────────────────────────────
// This worker maps a raw on-chain nft_id to (edition_id, serial_number). That
// mapping is what every edition-keyed FMV, badge, special-serial and portfolio
// figure downstream is joined on. Its failures are all SILENT by construction —
// a stalled tick writes fewer rows, it does not error — so the interesting
// behaviour is entirely in which partial failures it survives:
//
//   • a PARTIAL GraphQL error (one burned/retired moment nulls its own alias)
//     must NOT discard the other 49 lookups in the chunk. The code comment
//     records that the previous version did exactly that, and that it let
//     permanently-unresolvable ids at the head of the queue STARVE it.
//   • an edition the catalog has not reached yet must self-heal via
//     ensure_topshot_edition_stub, and that RPC must be de-duplicated per
//     (set, play) pair — 300 candidates routinely span 10-20 editions.
//   • a genuine catalog gap (stub returns NULL) must be counted and reported,
//     not silently dropped.
//
// ⚠ The supabase stub here keys on BOTH table and terminal method, which is not
// fussiness: readCandidates ends on `.limit()` against
// v_moments_needing_hydration, resolveEditions ends on `.or()` against
// `editions`. A single shared builder — the shape the sibling file uses, which
// is correct for its narrower scope — cannot model the two, and the failure mode
// is that every query resolves as whichever table was configured last.

const H = vi.hoisted(() => ({ sb: null as any }))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => H.sb,
  SupabaseClient: class {},
}))

import worker from "@/workers/topshot-moments-hydrator/index.ts"

const TOKEN = "ingest-secret"

interface SbOpts {
  candidates?: unknown[]
  editions?: unknown[]
  editionsError?: { message: string } | null
  rpc?: Record<string, unknown>
}

/**
 * Table-aware chainable stub.
 *
 * ⚠ `from()` returns a builder that CLOSES OVER its own table. Reusing one
 * singleton makes every chain resolve as the last-configured table — the trap
 * documented in CLAUDE.md after it made an already-correct route look broken.
 */
function makeSb(opts: SbOpts = {}) {
  const rpc = opts.rpc ?? {}
  const rpcFn = vi.fn(async (name: string) =>
    name in rpc ? (rpc[name] as any) : { data: null, error: null },
  )
  const api: any = {
    rpc: rpcFn,
    from(table: string) {
      const b: any = {}
      const self = () => b
      b.select = self
      b.eq = self
      b.order = self
      // v_moments_needing_hydration terminates on .limit()
      b.limit = () =>
        Promise.resolve({ data: table === "editions" ? [] : (opts.candidates ?? []), error: null })
      // editions terminates on .or()
      b.or = () =>
        Promise.resolve({
          data: opts.editions ?? [],
          error: opts.editionsError ?? null,
        })
      return b
    },
  }
  return api
}

/** A GQL response for `count` aliased getMintedMoment lookups. `null` entries
 *  model an alias upstream could not resolve. */
function gqlBody(
  nodes: Array<{ serial: number; set: number; play: number } | null>,
  errors?: unknown[],
) {
  const data: Record<string, unknown> = {}
  nodes.forEach((n, i) => {
    data[`m${i}`] = n
      ? { data: { flowSerialNumber: n.serial, set: { flowId: n.set }, play: { flowID: n.play } } }
      : { data: null }
  })
  return errors ? { data, errors } : { data }
}

function proxyReturning(body: unknown, init: ResponseInit = { status: 200 }) {
  // ⚠ The parameter is DECLARED even though the stub ignores it. `vi.fn(async () => ...)`
  // types its calls as `[]`, so `mock.calls[0][0]` is a tsc error — and the
  // assertion that the worker hits `/topshot` with the proxy secret reads that
  // argument. A stub that cannot be inspected cannot pin a contract.
  return {
    fetch: vi.fn(async (_req: Request) => new Response(JSON.stringify(body), init)),
  }
}

function envWith(proxy: unknown) {
  return {
    SUPABASE_URL: "https://db.example",
    SUPABASE_SERVICE_ROLE_KEY: "svc",
    INGEST_SECRET_TOKEN: TOKEN,
    TOPSHOT_PROXY: proxy,
    TS_PROXY_SECRET: "ts-secret",
  } as any
}

function req(): Request {
  return new Request("https://mh.example/", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
}

const cand = (id: string, owner: string | null = "0xowner") => ({
  nft_id: id,
  owner_address: owner,
  source_pack_rip_id: null,
  acquired_date: "2026-05-01T00:00:00Z",
})

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe("topshot-moments-hydrator — the happy path end to end", () => {
  it("resolves a moment to its edition and writes it", async () => {
    H.sb = makeSb({
      candidates: [cand("n1")],
      editions: [{ id: "ed-uuid-1", set_id_onchain: 100, play_id_onchain: 200 }],
      rpc: { replace_topshot_moments_batch: { data: 1, error: null } },
    })
    const env = envWith(proxyReturning(gqlBody([{ serial: 7, set: 100, play: 200 }])))

    const res = await worker.fetch(req(), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body).toMatchObject({ ok: true, candidates_read: 1, moments_written: 1 })
    expect(body.edition_resolution_failures).toBe(0)
    expect(body.graphql_failures).toBe(0)

    // The payload the RPC receives is the contract with the DB side.
    const call = H.sb.rpc.mock.calls.find((c: any[]) => c[0] === "replace_topshot_moments_batch")
    expect(call[1].payload).toEqual([
      { nft_id: "n1", edition_id: "ed-uuid-1", serial_number: 7, owner_address: "0xowner" },
    ])
  })

  it("sends the proxy secret and hits the /topshot route on the binding", async () => {
    // The hostname is ignored (Cloudflare routes via the binding) but the PATH
    // selects the upstream in the proxy's UPSTREAM_MAP, so it is load-bearing.
    const proxy = proxyReturning(gqlBody([{ serial: 1, set: 1, play: 2 }]))
    H.sb = makeSb({
      candidates: [cand("n1")],
      editions: [{ id: "e1", set_id_onchain: 1, play_id_onchain: 2 }],
      rpc: { replace_topshot_moments_batch: { data: 1, error: null } },
    })
    await worker.fetch(req(), envWith(proxy))

    const sent = proxy.fetch.mock.calls[0][0]
    expect(new URL(sent.url).pathname).toBe("/topshot")
    expect(sent.headers.get("X-Proxy-Secret")).toBe("ts-secret")
    expect(sent.method).toBe("POST")
  })
})

describe("topshot-moments-hydrator — a PARTIAL GraphQL error must not discard the chunk", () => {
  it("keeps the good aliases when one id nulls its own", async () => {
    // ⚠ THE REGRESSION THIS PINS IS DOCUMENTED IN THE SOURCE: the previous
    // version discarded the ENTIRE chunk on any `errors` entry, so a single
    // burned/retired id wasted 49 good lookups — and permanently-unresolvable
    // ids at the head of v_moments_needing_hydration STARVED the whole queue
    // (the observed ok=false / fetched_from_graphql:0 runs).
    H.sb = makeSb({
      candidates: [cand("good1"), cand("burned"), cand("good2")],
      editions: [{ id: "e1", set_id_onchain: 10, play_id_onchain: 20 }],
      rpc: { replace_topshot_moments_batch: { data: 2, error: null } },
    })
    const env = envWith(
      proxyReturning(
        gqlBody(
          [{ serial: 1, set: 10, play: 20 }, null, { serial: 2, set: 10, play: 20 }],
          [{ message: "moment not found" }],
        ),
      ),
    )

    const body = (await (await worker.fetch(req(), env)).json()) as any
    expect(body.moments_written, "the two good aliases still land").toBe(2)
    // The null alias is counted as a graphql failure, not lost silently.
    expect(body.graphql_failures).toBe(1)
    // ...and the partial error is still reported for telemetry.
    expect(JSON.stringify(body.errors ?? [])).toContain("moment not found")
  })

  it("a HARD chunk failure (non-200) is distinct from a partial one", async () => {
    H.sb = makeSb({ candidates: [cand("n1")] })
    const env = envWith(proxyReturning("upstream exploded", { status: 502 }))

    const body = (await (await worker.fetch(req(), env)).json()) as any
    expect(body.moments_written).toBe(0)
    expect(JSON.stringify(body.errors)).toContain("gql HTTP 502")
    // ⚠ ok is FALSE here and true in the partial case above — that split is the
    // whole point of tracking hardFailure separately.
    expect(body.ok).toBe(false)
  })

  it("a thrown fetch is also a hard failure, not a crash", async () => {
    H.sb = makeSb({ candidates: [cand("n1")] })
    const env = envWith({
      fetch: vi.fn(async () => {
        throw new Error("binding unavailable")
      }),
    })
    const res = await worker.fetch(req(), env)
    expect(res.status, "the cron must still get a recorded answer").toBe(200)
    const body = (await res.json()) as any
    expect(body.ok).toBe(false)
    expect(JSON.stringify(body.errors)).toContain("binding unavailable")
  })

  it("unparseable JSON is a hard failure rather than an unhandled throw", async () => {
    H.sb = makeSb({ candidates: [cand("n1")] })
    const env = envWith({ fetch: vi.fn(async () => new Response("<html>nope", { status: 200 })) })
    const body = (await (await worker.fetch(req(), env)).json()) as any
    expect(body.ok).toBe(false)
    expect(JSON.stringify(body.errors)).toContain("gql json parse")
  })
})

describe("topshot-moments-hydrator — edition self-heal", () => {
  it("creates a stub when the catalog has no row, and DEDUPES the RPC per pair", async () => {
    // Three moments spanning ONE (set, play) pair. The dedupe cache is what keeps
    // a 300-candidate run from firing 300 identical stub RPCs.
    H.sb = makeSb({
      candidates: [cand("n1"), cand("n2"), cand("n3")],
      editions: [], // catalog miss for every one
      rpc: {
        ensure_topshot_edition_stub: { data: "stub-uuid", error: null },
        replace_topshot_moments_batch: { data: 3, error: null },
      },
    })
    const env = envWith(
      proxyReturning(
        gqlBody([
          { serial: 1, set: 55, play: 66 },
          { serial: 2, set: 55, play: 66 },
          { serial: 3, set: 55, play: 66 },
        ]),
      ),
    )

    const body = (await (await worker.fetch(req(), env)).json()) as any
    expect(body.moments_written).toBe(3)
    expect(body.edition_resolution_failures).toBe(0)

    const stubCalls = H.sb.rpc.mock.calls.filter(
      (c: any[]) => c[0] === "ensure_topshot_edition_stub",
    )
    expect(stubCalls.length, "one RPC per distinct (set, play), not per moment").toBe(1)
    expect(stubCalls[0][1]).toEqual({ p_set_id_onchain: 55, p_play_id_onchain: 66 })
  })

  it("a NULL stub result is a real catalog gap — counted and reported, not dropped", async () => {
    // ⚠ ensure_topshot_edition_stub returns NULL when the PARENT SET is unknown
    // too. That is a genuine gap needing human intervention, so it must surface
    // rather than vanish into a smaller moments_written.
    H.sb = makeSb({
      candidates: [cand("n1")],
      editions: [],
      rpc: {
        ensure_topshot_edition_stub: { data: null, error: null },
        replace_topshot_moments_batch: { data: 0, error: null },
      },
    })
    const env = envWith(proxyReturning(gqlBody([{ serial: 1, set: 999, play: 888 }])))

    const body = (await (await worker.fetch(req(), env)).json()) as any
    expect(body.edition_resolution_failures).toBe(1)
    expect(body.moments_written).toBe(0)
    expect(JSON.stringify(body.errors)).toContain("catalog_gap")
  })

  it("an ERRORING stub RPC is reported under its own source", async () => {
    H.sb = makeSb({
      candidates: [cand("n1")],
      editions: [],
      rpc: {
        ensure_topshot_edition_stub: { data: null, error: { message: "permission denied" } },
        replace_topshot_moments_batch: { data: 0, error: null },
      },
    })
    const env = envWith(proxyReturning(gqlBody([{ serial: 1, set: 1, play: 2 }])))

    const body = (await (await worker.fetch(req(), env)).json()) as any
    expect(JSON.stringify(body.errors)).toContain("ensure_topshot_edition_stub")
    expect(JSON.stringify(body.errors)).toContain("permission denied")
  })

  it("a failed editions SELECT degrades to the stub path rather than aborting the run", async () => {
    H.sb = makeSb({
      candidates: [cand("n1")],
      editionsError: { message: "statement timeout" },
      rpc: {
        ensure_topshot_edition_stub: { data: "stub-uuid", error: null },
        replace_topshot_moments_batch: { data: 1, error: null },
      },
    })
    const env = envWith(proxyReturning(gqlBody([{ serial: 1, set: 1, play: 2 }])))

    const body = (await (await worker.fetch(req(), env)).json()) as any
    expect(JSON.stringify(body.errors)).toContain("statement timeout")
    // The run continues — a transient editions read must not cost the tick.
    expect(body.moments_written).toBe(1)
  })
})

describe("topshot-moments-hydrator — unresolvable moments", () => {
  it.each([
    ["zero serial", { serial: 0, set: 1, play: 2 }],
    ["negative serial", { serial: -3, set: 1, play: 2 }],
  ])("%s is counted as a graphql failure, not written", async (_label, node) => {
    H.sb = makeSb({
      candidates: [cand("n1")],
      editions: [{ id: "e1", set_id_onchain: 1, play_id_onchain: 2 }],
      rpc: { replace_topshot_moments_batch: { data: 0, error: null } },
    })
    const env = envWith(proxyReturning(gqlBody([node as any])))

    const body = (await (await worker.fetch(req(), env)).json()) as any
    expect(body.graphql_failures).toBe(1)
    expect(body.moments_written).toBe(0)
  })
})

describe("topshot-moments-hydrator — the write leg", () => {
  it("an RPC error surfaces under moments_write and reddens ok", async () => {
    H.sb = makeSb({
      candidates: [cand("n1")],
      editions: [{ id: "e1", set_id_onchain: 1, play_id_onchain: 2 }],
      rpc: {
        replace_topshot_moments_batch: { data: null, error: { message: "function does not exist" } },
      },
    })
    const env = envWith(proxyReturning(gqlBody([{ serial: 1, set: 1, play: 2 }])))

    const body = (await (await worker.fetch(req(), env)).json()) as any
    expect(JSON.stringify(body.errors)).toContain("moments_write")
    expect(body.moments_written).toBe(0)
    expect(body.ok).toBe(false)
  })

  it("a NON-NUMERIC RPC return is reported as a shape probe rather than counted as 0", async () => {
    // ⚠ The RPC is `RETURNS int`. If that signature ever drifts, Number(data) is
    // NaN — and silently coercing NaN to 0 would make a broken write path
    // indistinguishable from an empty batch. The worker keeps a one-shot probe
    // for exactly this; without a test it reads as dead defensive code.
    H.sb = makeSb({
      candidates: [cand("n1")],
      editions: [{ id: "e1", set_id_onchain: 1, play_id_onchain: 2 }],
      rpc: { replace_topshot_moments_batch: { data: { rows: 5 }, error: null } },
    })
    const env = envWith(proxyReturning(gqlBody([{ serial: 1, set: 1, play: 2 }])))

    const body = (await (await worker.fetch(req(), env)).json()) as any
    expect(JSON.stringify(body.errors)).toContain("non-numeric")
    expect(body.moments_written).toBe(0)
  })

  it("logs a pipeline_runs row carrying the counters", async () => {
    H.sb = makeSb({
      candidates: [cand("n1")],
      editions: [{ id: "e1", set_id_onchain: 1, play_id_onchain: 2 }],
      rpc: { replace_topshot_moments_batch: { data: 1, error: null } },
    })
    const env = envWith(proxyReturning(gqlBody([{ serial: 1, set: 1, play: 2 }])))
    await worker.fetch(req(), env)

    const log = H.sb.rpc.mock.calls.find((c: any[]) => c[0] === "log_pipeline_run")
    expect(log, "the watchlist keys on this row existing").toBeTruthy()
    expect(log[1]).toMatchObject({ p_pipeline: "topshot-moments-hydrator", p_ok: true })
    expect(log[1].p_rows_written).toBe(1)
  })
})
