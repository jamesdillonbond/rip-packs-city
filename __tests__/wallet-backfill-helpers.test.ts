import { describe, it, expect, beforeEach, vi } from "vitest"

// Unit/integration tests for lib/chains/flow/wallet-backfill-helpers.ts — the
// generic per-collection wallet-backfill runner layer (previously ~4%). Seams:
// a hoisted mutable `state` drives a thenable Supabase stub (routes .from()
// reads + .rpc() by name), a mocked fcl.query (details Cadence calls), the
// pipeline-lock module, and a stubbed global fetch that returns base64 JSON-CDC
// Flow-REST getIDs() payloads and enrich-chain JSON. We pin the pure error
// classifiers + Cadence/UUID constants exactly, and drive each runner through
// its guard / happy / skip-cached / mega-wallet / error branches.

const H = vi.hoisted(() => {
  const state: any = {
    // wallet_moments_cache read result (loadCachedMomentIds / *AndKeys)
    cachedRows: [] as Array<{ moment_id: string; edition_key?: string | null }>,
    cachedError: null as any,
    // rpc results
    upsertResult: { data: { written: 0 }, error: null } as any,
    backfillResult: { data: 0, error: null } as any,
    // seeded_wallets SELECT result — drives the stats-refresh freshness gate in
    // stampLastRefreshed. Default [] = "never refreshed" => always refresh,
    // which is the pre-2026-07-26 behaviour every other test assumes.
    seededWalletRows: [] as Array<{ last_refreshed_at: string | null }>,
    // lock + fcl + username-resolve
    lockClaim: true,
    fclQuery: (async () => []) as (arg?: any) => Promise<any>,
    usernameOutcome: { found: false, reason: "not_found" } as any,
    // captured
    rpcCalls: [] as Array<{ name: string; params: any }>,
  }

  function resolveRead(ctx: any) {
    if (ctx.table === "wallet_moments_cache") {
      if (state.cachedError) return { data: null, error: state.cachedError }
      return { data: state.cachedRows, error: null }
    }
    // seeded_wallets SELECT (the stats freshness probe). The UPDATE that
    // stamps last_refreshed_per_collection sets ctx.op and falls through.
    if (ctx.table === "seeded_wallets" && ctx.op !== "update") {
      return { data: state.seededWalletRows, error: null }
    }
    // seeded_wallets update, everything else
    return { data: null, error: null }
  }

  function makeClient() {
    return {
      from(table: string) {
        const ctx: any = { table, op: "select" }
        const b: any = {}
        for (const m of [
          "select", "eq", "in", "order", "limit", "is", "gte", "lt",
          "not", "ilike", "upsert", "insert", "delete", "update", "range",
        ]) {
          b[m] = (..._a: any[]) => {
            if (m === "update") ctx.op = "update"
            return b
          }
        }
        b.then = (resolve: any) => resolve(resolveRead(ctx))
        return b
      },
      rpc: async (name: string, params: any) => {
        state.rpcCalls.push({ name, params })
        if (name === "upsert_wmc_batch") return state.upsertResult
        if (
          name === "backfill_wmc_metadata_from_editions" ||
          name === "backfill_pinnacle_wmc_metadata_from_editions"
        ) {
          return state.backfillResult
        }
        // log_pipeline_run, refresh_seeded_wallet_stats
        return { data: null, error: null }
      },
    }
  }

  return { state, client: makeClient() }
})

vi.mock("@/lib/supabase", () => ({ supabase: H.client, supabaseAdmin: H.client }))
vi.mock("@/lib/chains/flow/flow", () => ({ default: { query: (arg?: any) => H.state.fclQuery(arg) } }))
vi.mock("@/lib/wallet-backfill-lock", () => ({
  walletBackfillLockKey: (slug: string, wallet: string) => `${slug}:${wallet}`,
  claimPipelineLock: async () => H.state.lockClaim,
  releasePipelineLock: async () => {},
}))
vi.mock("@/lib/chains/flow/topshot-username-resolve", () => ({
  isWalletAddress: (v: string) => /^(0x)?[0-9a-fA-F]{16}$/.test(v.trim()),
  resolveTopShotUsernameCacheAware: async () => H.state.usernameOutcome,
}))
vi.mock("@/lib/chains/flow/allday-cadence", () => ({
  GET_UNLOCKED_MOMENT_DETAILS: "ALLDAY_DETAILS",
  GET_UNLOCKED_MOMENT_DETAILS_RANGE: "ALLDAY_DETAILS_RANGE",
}))
vi.mock("@/lib/chains/flow/cadence/pinnacle-wallet", () => ({
  GET_PINNACLE_UNLOCKED_DETAILS: "PIN_DETAILS",
  GET_PINNACLE_UNLOCKED_DETAILS_RANGE: "PIN_DETAILS_RANGE",
}))

import {
  resolveWalletInput,
  fetchOnChainIds,
  isFlowQueryTimeout,
  isStorageLimitError,
  isComputationLimitError,
  isAccessApiInternalServerError,
  isNoCollectionCapabilityError,
  triggerUfcEnrichmentChain,
  runIdOnlyBackfill,
  runAllDayDetailsBackfill,
  runPinnacleDetailsBackfill,
  runPaginatedDetailsBackfill,
  CADENCE_ALLDAY,
  CADENCE_PINNACLE,
  CADENCE_GOLAZOS,
  CADENCE_UFC,
  ALLDAY_COLLECTION_UUID,
  PINNACLE_COLLECTION_UUID,
  GOLAZOS_COLLECTION_UUID,
  UFC_COLLECTION_UUID,
} from "@/lib/chains/flow/wallet-backfill-helpers"

// ── helpers ────────────────────────────────────────────────────────────────
function flowIdsResponse(ids: Array<string | number>) {
  const json = JSON.stringify({ type: "Array", value: ids.map(id => ({ value: String(id) })) })
  const b64 = Buffer.from(json, "utf8").toString("base64")
  return { ok: true, status: 200, text: async () => b64 }
}

const CFG = {
  slug: "nfl_all_day",
  collectionUuid: ALLDAY_COLLECTION_UUID,
  cadenceScript: CADENCE_ALLDAY,
  pipelineName: "wallet-backfill-allday",
}
const WALLET = "0xaaaaaaaaaaaaaaaa"

function baseArgs(over: Partial<any> = {}) {
  return {
    config: CFG,
    startedAtIso: "2026-07-13T00:00:00.000Z",
    startedMs: Date.now(),
    wallet: WALLET,
    skipCached: false,
    force: false,
    ...over,
  }
}

function lastLog() {
  const calls = H.state.rpcCalls.filter((c: any) => c.name ==="log_pipeline_run")
  return calls[calls.length - 1]?.params
}

beforeEach(() => {
  H.state.cachedRows = []
  H.state.cachedError = null
  H.state.upsertResult = { data: { written: 0 }, error: null }
  H.state.backfillResult = { data: 0, error: null }
  H.state.seededWalletRows = []
  H.state.lockClaim = true
  H.state.fclQuery = async () => []
  H.state.usernameOutcome = { found: false, reason: "not_found" }
  H.state.rpcCalls = []
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co"
  process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
  vi.stubGlobal("fetch", vi.fn())
})

// ── error classifiers (pure) ─────────────────────────────────────────────────
describe("error classifiers", () => {
  it("isFlowQueryTimeout matches the flow_query_timeout marker only", () => {
    expect(isFlowQueryTimeout(new Error("flow_query_timeout: X exceeded 35000ms"))).toBe(true)
    expect(isFlowQueryTimeout("flow_query_timeout raw string")).toBe(true)
    expect(isFlowQueryTimeout(new Error("something else"))).toBe(false)
  })

  it("isStorageLimitError matches 1106 / storage-interaction phrasing", () => {
    expect(isStorageLimitError(new Error("error code 1106"))).toBe(true)
    expect(isStorageLimitError(new Error("max interaction with storage exceeded"))).toBe(true)
    expect(isStorageLimitError(new Error("storage used exceeds the limit"))).toBe(true)
    expect(isStorageLimitError("plain 11060 not a word boundary")).toBe(false)
    expect(isStorageLimitError(new Error("unrelated"))).toBe(false)
  })

  it("isComputationLimitError matches 1110 / computation-exceeds phrasing", () => {
    expect(isComputationLimitError(new Error("Cadence error 1110"))).toBe(true)
    expect(isComputationLimitError(new Error("computation exceeds limit (100000)"))).toBe(true)
    expect(isComputationLimitError(new Error("nope"))).toBe(false)
  })

  it("isAccessApiInternalServerError needs BOTH the 500 phrase and /v1/scripts", () => {
    expect(isAccessApiInternalServerError(new Error("error=internal server error path=/v1/scripts"))).toBe(true)
    expect(isAccessApiInternalServerError(new Error("error=internal server error"))).toBe(false)
    expect(isAccessApiInternalServerError(new Error("/v1/scripts only"))).toBe(false)
  })

  it("isNoCollectionCapabilityError requires the 400/InvalidArgument shape and fast elapsed", () => {
    const msg = "Flow script HTTP 400: code = InvalidArgument desc = failed to ex"
    expect(isNoCollectionCapabilityError(new Error(msg))).toBe(true)
    expect(isNoCollectionCapabilityError(new Error(msg), 4000)).toBe(true)
    expect(isNoCollectionCapabilityError(new Error(msg), 20000)).toBe(false) // slow → storage-limit class
    expect(isNoCollectionCapabilityError(new Error("Flow script HTTP 500"))).toBe(false)
  })
})

// ── Cadence + UUID constants ─────────────────────────────────────────────────
describe("Cadence scripts and collection UUIDs", () => {
  it("each getIDs() script targets its collection public path", () => {
    expect(CADENCE_ALLDAY).toContain("/public/AllDayNFTCollection")
    expect(CADENCE_PINNACLE).toContain("/public/PinnacleCollection")
    expect(CADENCE_GOLAZOS).toContain("/public/GolazoNFTCollection")
    expect(CADENCE_UFC).toContain("/public/UFC_NFTCollection")
    for (const s of [CADENCE_ALLDAY, CADENCE_PINNACLE, CADENCE_GOLAZOS, CADENCE_UFC]) {
      expect(s).toContain("getIDs()")
    }
  })

  it("exposes the four collection UUIDs verbatim", () => {
    expect(ALLDAY_COLLECTION_UUID).toBe("dee28451-5d62-409e-a1ad-a83f763ac070")
    expect(PINNACLE_COLLECTION_UUID).toBe("7dd9dd11-e8b6-45c4-ac99-71331f959714")
    expect(GOLAZOS_COLLECTION_UUID).toBe("06248cc4-b85f-47cd-af67-1855d14acd75")
    expect(UFC_COLLECTION_UUID).toBe("9b4824a8-736d-4a96-b450-8dcc0c46b023")
  })
})

// ── resolveWalletInput ───────────────────────────────────────────────────────
describe("resolveWalletInput", () => {
  it("rejects an empty input", async () => {
    expect(await resolveWalletInput("   ")).toEqual({ ok: false, error: "wallet field required", input: "" })
  })

  it("passes a 0x address through and prefixes a bare 16-hex address", async () => {
    expect(await resolveWalletInput("0xbd94cade097e50ac")).toEqual({ ok: true, wallet: "0xbd94cade097e50ac" })
    expect(await resolveWalletInput("bd94cade097e50ac")).toEqual({ ok: true, wallet: "0xbd94cade097e50ac" })
  })

  it("resolves a username via the cache-aware resolver", async () => {
    H.state.usernameOutcome = { found: true, walletAddress: "0xdeadbeefdeadbeef" }
    expect(await resolveWalletInput("jamesdillonbond")).toEqual({ ok: true, wallet: "0xdeadbeefdeadbeef" })
  })

  it("returns a structured error when the username can't be resolved", async () => {
    H.state.usernameOutcome = { found: false, reason: "no_match" }
    const out = await resolveWalletInput("ghost")
    expect(out).toEqual({ ok: false, error: "could not resolve username", reason: "no_match", input: "ghost" })
  })
})

// ── fetchOnChainIds ──────────────────────────────────────────────────────────
describe("fetchOnChainIds", () => {
  it("decodes a base64 JSON-CDC array into string ids", async () => {
    ;(fetch as any).mockResolvedValue(flowIdsResponse([1, 2, 3]))
    expect(await fetchOnChainIds("main(){}", WALLET)).toEqual(["1", "2", "3"])
  })

  it("returns [] when the decoded value array is absent", async () => {
    const b64 = Buffer.from(JSON.stringify({ type: "Array" }), "utf8").toString("base64")
    ;(fetch as any).mockResolvedValue({ ok: true, status: 200, text: async () => b64 })
    expect(await fetchOnChainIds("main(){}", WALLET)).toEqual([])
  })

  it("throws on a non-2xx Flow script response", async () => {
    ;(fetch as any).mockResolvedValue({ ok: false, status: 500, text: async () => "boom" })
    await expect(fetchOnChainIds("main(){}", WALLET)).rejects.toThrow(/Flow script HTTP 500/)
  })
})

// ── triggerUfcEnrichmentChain ────────────────────────────────────────────────
describe("triggerUfcEnrichmentChain", () => {
  it("no-ops when the supabase url / ingest token env is missing", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    expect(await triggerUfcEnrichmentChain(WALLET)).toEqual({ pagesFired: 0, totalEnriched: 0, done: false })
  })

  it("walks pages until the edge fn reports done, summing enriched", async () => {
    ;(fetch as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ enriched: 100, nextStart: 100 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ enriched: 40, done: true }) })
    const out = await triggerUfcEnrichmentChain(WALLET)
    expect(out).toEqual({ pagesFired: 2, totalEnriched: 140, done: true })
  })

  it("stops (done) when nextStart is null even without an explicit done flag", async () => {
    ;(fetch as any).mockResolvedValue({ ok: true, json: async () => ({ enriched: 5, nextStart: null }) })
    const out = await triggerUfcEnrichmentChain(WALLET)
    expect(out).toEqual({ pagesFired: 1, totalEnriched: 5, done: true })
  })

  it("breaks (not done) on a non-ok HTTP response", async () => {
    ;(fetch as any).mockResolvedValue({ ok: false, status: 502, json: async () => ({}) })
    const out = await triggerUfcEnrichmentChain(WALLET)
    expect(out).toEqual({ pagesFired: 0, totalEnriched: 0, done: false })
  })

  it("breaks (not done) when a page fetch throws", async () => {
    ;(fetch as any).mockRejectedValue(new Error("network down"))
    const out = await triggerUfcEnrichmentChain(WALLET)
    expect(out.done).toBe(false)
    expect(out.pagesFired).toBe(0)
  })

  it("breaks when the returned nextStart is non-positive", async () => {
    ;(fetch as any).mockResolvedValue({ ok: true, json: async () => ({ enriched: 3, nextStart: 0 }) })
    const out = await triggerUfcEnrichmentChain(WALLET)
    expect(out).toEqual({ pagesFired: 1, totalEnriched: 3, done: false })
  })
})

// ── stampLastRefreshed stats-refresh gate (2026-07-26) ───────────────────────
// refresh_seeded_wallet_stats wraps holdings_summary(), a CROSS-collection
// aggregate (~290 ms typical, ~21 s / 247 MB on a 152,806-moment whale) — yet
// it was called at the end of EVERY per-collection backfill, so it ran ~11x per
// wallet per day recomputing the same number. 92.9% of backfill runs write zero
// rows and therefore cannot have changed holdings. These pin the gate.
describe("stampLastRefreshed — cross-collection stats refresh gate", () => {
  const statsCalls = () => H.state.rpcCalls.filter((c: any) => c.name === "refresh_seeded_wallet_stats").length

  it("SKIPS the stats refresh when the run wrote nothing and the stats are fresh", async () => {
    H.state.seededWalletRows = [{ last_refreshed_at: new Date(Date.now() - 60_000).toISOString() }]
    ;(fetch as any).mockResolvedValue(flowIdsResponse([]))
    await runIdOnlyBackfill(baseArgs())
    expect(statsCalls()).toBe(0)
  })

  it("still refreshes a zero-write run once the stats age past the window", async () => {
    // cached_fmv_usd drifts as FMV is repriced, so "nothing changed" can never
    // mean "never refresh again" — the skip has to be time-bounded.
    H.state.seededWalletRows = [{ last_refreshed_at: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString() }]
    ;(fetch as any).mockResolvedValue(flowIdsResponse([]))
    await runIdOnlyBackfill(baseArgs())
    expect(statsCalls()).toBe(1)
  })

  it("ALWAYS refreshes when the run actually wrote rows, however fresh the stats are", async () => {
    // This is what keeps last-wins semantics: a real holdings change is never
    // delayed, which is why this is a changed-rows gate and not a time debounce.
    H.state.seededWalletRows = [{ last_refreshed_at: new Date().toISOString() }]
    H.state.upsertResult = { data: { written: 3 }, error: null }
    ;(fetch as any).mockResolvedValue(flowIdsResponse([10, 11, 12]))
    await runIdOnlyBackfill(baseArgs({ skipCached: false }))
    expect(statsCalls()).toBe(1)
  })

  it("fails open and refreshes when the wallet has never been stats-refreshed", async () => {
    H.state.seededWalletRows = [{ last_refreshed_at: null }]
    ;(fetch as any).mockResolvedValue(flowIdsResponse([]))
    await runIdOnlyBackfill(baseArgs())
    expect(statsCalls()).toBe(1)
  })

  it("still stamps the per-collection freshness marker even when the stats refresh is skipped", async () => {
    // last_refreshed_per_collection means "we checked", not "something
    // changed" — the multi-collection cron uses it to find stale wallets, so
    // skipping it would strand the wallet.
    H.state.seededWalletRows = [{ last_refreshed_at: new Date().toISOString() }]
    ;(fetch as any).mockResolvedValue(flowIdsResponse([]))
    await runIdOnlyBackfill(baseArgs())
    expect(statsCalls()).toBe(0)
    // The run still completed and logged, i.e. the stamp path was reached.
    expect(lastLog().p_extra.terminated_reason).toBe("no_more_moments")
  })
})

// ── runIdOnlyBackfill ────────────────────────────────────────────────────────
describe("runIdOnlyBackfill", () => {
  it("no-ops with skipped_in_progress when the lock is held", async () => {
    H.state.lockClaim = false
    const out = await runIdOnlyBackfill(baseArgs())
    expect(out).toEqual({ rowsFound: 0 })
    expect(lastLog().p_extra.terminated_reason).toBe("skipped_in_progress")
  })

  it("logs no_more_moments for an empty wallet and stamps refresh", async () => {
    ;(fetch as any).mockResolvedValue(flowIdsResponse([]))
    const out = await runIdOnlyBackfill(baseArgs())
    expect(out).toEqual({ rowsFound: 0 })
    expect(lastLog().p_extra.on_chain_count).toBe(0)
    expect(H.state.rpcCalls.some((c: any) => c.name ==="refresh_seeded_wallet_stats")).toBe(true)
  })

  it("upserts every id and reports written count when not skipping cache", async () => {
    ;(fetch as any).mockResolvedValue(flowIdsResponse([10, 11, 12]))
    H.state.upsertResult = { data: { written: 3 }, error: null }
    const out = await runIdOnlyBackfill(baseArgs({ skipCached: false }))
    expect(out.rowsFound).toBe(3)
    const log = lastLog()
    expect(log.p_rows_written).toBe(3)
    expect(log.p_rows_skipped).toBe(0)
    const upsert = H.state.rpcCalls.find((c: any) => c.name ==="upsert_wmc_batch")
    expect(upsert.params.p_rows).toHaveLength(3)
  })

  it("filters already-cached ids when skipCached=true", async () => {
    ;(fetch as any).mockResolvedValue(flowIdsResponse([10, 11, 12]))
    H.state.cachedRows = [{ moment_id: "10" }, { moment_id: "11" }]
    H.state.upsertResult = { data: { written: 1 }, error: null }
    const out = await runIdOnlyBackfill(baseArgs({ skipCached: true }))
    expect(out.rowsFound).toBe(3)
    expect(lastLog().p_rows_skipped).toBe(2)
    const upsert = H.state.rpcCalls.find((c: any) => c.name ==="upsert_wmc_batch")
    expect(upsert.params.p_rows).toHaveLength(1)
  })

  // CHANGED 2026-07-25. This test used to assert `p_ok === true` on an upsert
  // failure — it PINNED the silent-data-loss bug: a failing chunk was
  // console.error'd and swallowed, so the run reported success with no counter
  // and the lost rows absent from rows_skipped. 3,497 wallet-backfill runs logged
  // 0 failures across a window that dropped ~37 chunks of up to 200 rows each.
  // A chunk that fetched fine and then failed to write is DATA LOSS and must be
  // visible in pipeline_runs.
  it("a failed upsert chunk marks the run ok=false and is counted, not swallowed", async () => {
    ;(fetch as any).mockResolvedValue(flowIdsResponse([1]))
    H.state.upsertResult = { data: null, error: { message: "upsert boom" } }
    const out = await runIdOnlyBackfill(baseArgs())
    expect(out.rowsFound).toBe(1)
    const log = lastLog()
    expect(log.p_ok).toBe(false)
    expect(log.p_rows_written).toBe(0)
    // the failure is counted...
    expect(log.p_extra.chunk_errors).toBe(1)
    // ...the lost rows are attributed...
    expect(log.p_extra.chunk_rows_lost).toBe(1)
    expect(log.p_extra.first_chunk_error).toBe("upsert boom")
    // ...they show up as skipped (found but never written)...
    expect(log.p_rows_skipped).toBe(1)
    // ...and the error column carries the reason.
    expect(log.p_error).toContain("wmc_upsert_chunk_failures=1")
    expect(log.p_error).toContain("upsert boom")
  })

  it("a clean run reports ok=true with a zero chunk-error count", async () => {
    ;(fetch as any).mockResolvedValue(flowIdsResponse([1, 2]))
    H.state.upsertResult = { data: { written: 2 }, error: null }
    await runIdOnlyBackfill(baseArgs({ skipCached: false }))
    const log = lastLog()
    expect(log.p_ok).toBe(true)
    expect(log.p_error).toBeNull()
    expect(log.p_extra.chunk_errors).toBe(0)
    expect(log.p_extra.chunk_rows_lost).toBe(0)
    expect(log.p_extra.first_chunk_error).toBeNull()
  })

  it("classifies a storage-limit failure as ok with storage_limit_exceeded", async () => {
    ;(fetch as any).mockResolvedValue({ ok: false, status: 500, text: async () => "code 1106 max interaction with storage" })
    const out = await runIdOnlyBackfill(baseArgs())
    expect(out).toEqual({ rowsFound: 0 })
    expect(lastLog().p_ok).toBe(true)
    expect(lastLog().p_extra.terminated_reason).toBe("storage_limit_exceeded")
  })

  it("classifies a fast 400 InvalidArgument as no_collection_capability", async () => {
    ;(fetch as any).mockResolvedValue({ ok: false, status: 400, text: async () => "code = InvalidArgument desc = failed to ex" })
    const out = await runIdOnlyBackfill(baseArgs())
    expect(out).toEqual({ rowsFound: 0 })
    expect(lastLog().p_extra.terminated_reason).toBe("no_collection_capability")
  })

  it("logs a hard error (ok=false) for an unclassified failure", async () => {
    ;(fetch as any).mockRejectedValue(new Error("totally unexpected"))
    const out = await runIdOnlyBackfill(baseArgs())
    expect(out).toEqual({ rowsFound: 0 })
    expect(lastLog().p_ok).toBe(false)
    expect(lastLog().p_extra.terminated_reason).toBe("error")
  })
})

// ── runAllDayDetailsBackfill ─────────────────────────────────────────────────
describe("runAllDayDetailsBackfill", () => {
  it("no-ops (complete) with skipped_in_progress when the lock is held", async () => {
    H.state.lockClaim = false
    const out = await runAllDayDetailsBackfill(baseArgs())
    expect(out).toEqual({ rowsFound: 0, complete: true, nextStartIndex: null })
    expect(lastLog().p_extra.terminated_reason).toBe("skipped_in_progress")
  })

  it("logs no_more_moments (complete) for a wallet with no triples", async () => {
    H.state.fclQuery = async () => []
    const out = await runAllDayDetailsBackfill(baseArgs())
    expect(out).toEqual({ rowsFound: 0, complete: true, nextStartIndex: null })
    expect(lastLog().p_extra.mode).toBe("details_allday")
  })

  it("writes edition_key + serial and runs the post-pass JOIN update", async () => {
    H.state.fclQuery = async () => [
      ["100", "42", "7"],
      ["101", "43", "0"], // serial 0 → null
      ["bad"],            // < 2 elems → skipped
    ]
    H.state.upsertResult = { data: { written: 2 }, error: null }
    H.state.backfillResult = { data: 9, error: null }
    const out = await runAllDayDetailsBackfill(baseArgs())
    expect(out).toEqual({ rowsFound: 3, complete: true, nextStartIndex: null })
    const log = lastLog()
    expect(log.p_extra.rows_to_write).toBe(2)
    expect(log.p_extra.post_pass_metadata_updated).toBe(9)
    const upsert = H.state.rpcCalls.find((c: any) => c.name ==="upsert_wmc_batch")
    expect(upsert.params.p_rows[0].edition_key).toBe("42")
    expect(upsert.params.p_rows[0].serial_number).toBe(7)
    expect(upsert.params.p_rows[1].serial_number).toBeNull()
  })

  it("skips cached ids when skipCached=true", async () => {
    H.state.fclQuery = async () => [["100", "42", "7"], ["101", "43", "8"]]
    H.state.cachedRows = [{ moment_id: "100" }]
    const out = await runAllDayDetailsBackfill(baseArgs({ skipCached: true }))
    expect(out.rowsFound).toBe(2)
    expect(lastLog().p_extra.skipped_cached).toBe(1)
  })

  it("treats a flow_query_timeout as ok and complete", async () => {
    H.state.fclQuery = async () => { throw new Error("flow_query_timeout: GET_UNLOCKED_MOMENT_DETAILS exceeded 35000ms") }
    const out = await runAllDayDetailsBackfill(baseArgs())
    expect(out).toEqual({ rowsFound: 0, complete: true, nextStartIndex: null })
    expect(lastLog().p_extra.terminated_reason).toBe("flow_query_timeout")
  })

  it("treats a storage limit as ok and complete", async () => {
    H.state.fclQuery = async () => { throw new Error("error code 1106 max interaction with storage") }
    const out = await runAllDayDetailsBackfill(baseArgs())
    expect(lastLog().p_extra.terminated_reason).toBe("storage_limit_exceeded")
    expect(out.complete).toBe(true)
  })

  it("falls through to the paginated path on a computation limit", async () => {
    let call = 0
    H.state.fclQuery = async () => {
      call++
      if (call === 1) throw new Error("Cadence error 1110 computation exceeds limit")
      return [["200", "50", "3"]] // range call
    }
    ;(fetch as any).mockResolvedValue(flowIdsResponse([200])) // getIDs()
    H.state.upsertResult = { data: { written: 1 }, error: null }
    const out = await runAllDayDetailsBackfill(baseArgs())
    expect(out.complete).toBe(true)
    expect(lastLog().p_extra.recovered_from).toBe("computation_limit_exceeded")
    expect(lastLog().p_extra.mode).toBe("details_allday_paginated")
  })

  it("falls through to the paginated path on an access-api 500", async () => {
    let call = 0
    H.state.fclQuery = async () => {
      call++
      if (call === 1) throw new Error("error=internal server error at /v1/scripts")
      return [["201", "51", "4"]]
    }
    ;(fetch as any).mockResolvedValue(flowIdsResponse([201]))
    const out = await runAllDayDetailsBackfill(baseArgs())
    expect(out.complete).toBe(true)
    expect(lastLog().p_extra.recovered_from).toBe("access_api_error_likely_computation_limit")
  })

  it("classifies a fast no-collection-capability error", async () => {
    H.state.fclQuery = async () => { throw new Error("Flow script HTTP 400: code = InvalidArgument desc = failed to ex") }
    const out = await runAllDayDetailsBackfill(baseArgs())
    expect(lastLog().p_extra.terminated_reason).toBe("no_collection_capability")
    expect(out.complete).toBe(true)
  })

  it("logs a hard error for an unclassified failure", async () => {
    H.state.fclQuery = async () => { throw new Error("weird explosion") }
    const out = await runAllDayDetailsBackfill(baseArgs())
    expect(lastLog().p_ok).toBe(false)
    expect(lastLog().p_extra.terminated_reason).toBe("error")
    expect(out).toEqual({ rowsFound: 0, complete: true, nextStartIndex: null })
  })

  // See the runIdOnlyBackfill chunk-failure tests — same silent-data-loss class,
  // second of the four upsert sites.
  it("a failed upsert chunk marks the AllDay details run ok=false and counts the loss", async () => {
    H.state.fclQuery = async () => [["100", "42", "7"], ["101", "43", "8"]]
    H.state.upsertResult = { data: null, error: { message: "details boom" } }
    await runAllDayDetailsBackfill(baseArgs())
    const log = lastLog()
    expect(log.p_ok).toBe(false)
    expect(log.p_extra.chunk_errors).toBe(1)
    expect(log.p_extra.chunk_rows_lost).toBe(2)
    expect(log.p_error).toContain("wmc_upsert_chunk_failures=1")
  })
})

// ── runPinnacleDetailsBackfill ───────────────────────────────────────────────

describe("runPinnacleDetailsBackfill", () => {
  const PIN_CFG = {
    slug: "disney_pinnacle",
    collectionUuid: PINNACLE_COLLECTION_UUID,
    cadenceScript: CADENCE_PINNACLE,
    pipelineName: "wallet-backfill-pinnacle",
  }
  const pinArgs = (over: Partial<any> = {}) => baseArgs({ config: PIN_CFG, ...over })

  it("logs no_more_moments for an empty wallet", async () => {
    H.state.fclQuery = async () => []
    const out = await runPinnacleDetailsBackfill(pinArgs())
    expect(out).toEqual({ rowsFound: 0, complete: true, nextStartIndex: null })
    expect(lastLog().p_extra.mode).toBe("details_pinnacle")
  })

  it("writes object-shaped details and runs the pinnacle post-pass", async () => {
    H.state.fclQuery = async () => [
      { id: "1", editionKey: "royal:foil:1", serial: "5" },
      { id: "2", editionKey: null, serial: null },
    ]
    H.state.upsertResult = { data: { written: 2 }, error: null }
    H.state.backfillResult = { data: 4, error: null }
    const out = await runPinnacleDetailsBackfill(pinArgs())
    expect(out.rowsFound).toBe(2)
    const upsert = H.state.rpcCalls.find((c: any) => c.name ==="upsert_wmc_batch")
    expect(upsert.params.p_rows[0].edition_key).toBe("royal:foil:1")
    expect(upsert.params.p_rows[0].serial_number).toBe(5)
    expect(upsert.params.p_rows[1].edition_key).toBeNull()
    expect(H.state.rpcCalls.some((c: any) => c.name ==="backfill_pinnacle_wmc_metadata_from_editions")).toBe(true)
  })

  it("falls through to the pinnacle paginated path on a computation limit", async () => {
    let call = 0
    H.state.fclQuery = async () => {
      call++
      if (call === 1) throw new Error("computation exceeds limit 1110")
      return [{ id: "3", editionKey: "k", serial: "1" }]
    }
    ;(fetch as any).mockResolvedValue(flowIdsResponse([3]))
    const out = await runPinnacleDetailsBackfill(pinArgs())
    expect(lastLog().p_extra.mode).toBe("details_pinnacle_paginated")
    expect(out.complete).toBe(true)
  })

  it("treats a flow_query_timeout as ok and complete", async () => {
    H.state.fclQuery = async () => { throw new Error("flow_query_timeout: GET_PINNACLE_UNLOCKED_DETAILS exceeded") }
    const out = await runPinnacleDetailsBackfill(pinArgs())
    expect(lastLog().p_extra.terminated_reason).toBe("flow_query_timeout")
    expect(out.complete).toBe(true)
  })

  // Third of the four upsert sites.
  it("a failed upsert chunk marks the Pinnacle details run ok=false and counts the loss", async () => {
    H.state.fclQuery = async () => [{ id: "1", editionKey: "royal:foil:1", serial: "5" }]
    H.state.upsertResult = { data: null, error: { message: "pin boom" } }
    await runPinnacleDetailsBackfill(pinArgs())
    const log = lastLog()
    expect(log.p_ok).toBe(false)
    expect(log.p_extra.chunk_errors).toBe(1)
    expect(log.p_extra.chunk_rows_lost).toBe(1)
    expect(log.p_error).toContain("wmc_upsert_chunk_failures=1")
  })
})

// ── runPaginatedDetailsBackfill (direct) ─────────────────────────────────────
describe("runPaginatedDetailsBackfill", () => {
  const pagArgs = (over: Partial<any> = {}) => ({
    ...baseArgs(),
    mode: "allday" as const,
    parentTerminatedReason: "computation_limit_exceeded",
    parentErrorExcerpt: "boom",
    ...over,
  })

  it("logs no_more_moments when getIDs() returns empty", async () => {
    ;(fetch as any).mockResolvedValue(flowIdsResponse([]))
    const out = await runPaginatedDetailsBackfill(pagArgs())
    expect(out).toEqual({ rowsFound: 0, complete: true, nextStartIndex: null })
    expect(lastLog().p_extra.terminated_reason).toBe("no_more_moments")
  })

  it("short-circuits when every on-chain id is already cached+enriched", async () => {
    ;(fetch as any).mockResolvedValue(flowIdsResponse([1, 2]))
    H.state.cachedRows = [
      { moment_id: "1", edition_key: "a" },
      { moment_id: "2", edition_key: "b" },
    ]
    H.state.backfillResult = { data: 7, error: null }
    const out = await runPaginatedDetailsBackfill(pagArgs({ skipCached: true, force: false }))
    expect(out.complete).toBe(true)
    expect(lastLog().p_extra.terminated_reason).toBe("all_ids_already_enriched")
    expect(lastLog().p_extra.post_pass_metadata_updated).toBe(7)
    // chunk loop bypassed → no range fcl.query
    expect(H.state.rpcCalls.some((c: any) => c.name ==="upsert_wmc_batch")).toBe(false)
  })

  it("walks chunks and upserts (allday range mode)", async () => {
    ;(fetch as any).mockResolvedValue(flowIdsResponse([500, 501]))
    H.state.fclQuery = async () => [["500", "60", "1"], ["501", "61", "2"]]
    H.state.upsertResult = { data: { written: 2 }, error: null }
    const out = await runPaginatedDetailsBackfill(pagArgs({ skipCached: false }))
    expect(out).toEqual({ rowsFound: 2, complete: true, nextStartIndex: null })
    const log = lastLog()
    expect(log.p_extra.pagination_chunks).toBe(1)
    expect(log.p_extra.pagination_chunk_errors).toBe(0)
    expect(log.p_extra.chunk_errors).toBe(0)
    expect(log.p_extra.terminated_reason).toBe("no_more_moments")
  })

  // Fourth of the four upsert sites, and the one that most needed this:
  // `pagination_chunk_errors` counts only PAGINATION-fetch failures, so an upsert
  // failure here was invisible on BOTH counters. The chunk fetched fine and the
  // rows were then dropped, so the run must not report success.
  it("a failed upsert chunk marks the paginated run ok=false, distinct from pagination errors", async () => {
    ;(fetch as any).mockResolvedValue(flowIdsResponse([500, 501]))
    H.state.fclQuery = async () => [["500", "60", "1"], ["501", "61", "2"]]
    H.state.upsertResult = { data: null, error: { message: "paginated boom" } }
    await runPaginatedDetailsBackfill(pagArgs({ skipCached: false }))
    const log = lastLog()
    expect(log.p_ok).toBe(false)
    // the pagination FETCH succeeded — the two counters are independent
    expect(log.p_extra.pagination_chunks).toBe(1)
    expect(log.p_extra.pagination_chunk_errors).toBe(0)
    // ...and the upsert failure is what reddens the run
    expect(log.p_extra.chunk_errors).toBe(1)
    expect(log.p_extra.chunk_rows_lost).toBe(2)
    expect(log.p_error).toContain("wmc_upsert_chunk_failures=1")
    expect(log.p_error).toContain("paginated boom")
  })

  it("walks chunks in pinnacle range mode (object rows)", async () => {
    ;(fetch as any).mockResolvedValue(flowIdsResponse([9]))
    H.state.fclQuery = async () => [{ id: "9", editionKey: "k9", serial: "3" }]
    H.state.upsertResult = { data: { written: 1 }, error: null }
    const out = await runPaginatedDetailsBackfill(pagArgs({ mode: "pinnacle" }))
    expect(out.rowsFound).toBe(1)
    expect(lastLog().p_extra.mode).toBe("details_pinnacle_paginated")
  })

  it("marks pagination_failed (ok=false) when every chunk throws", async () => {
    ;(fetch as any).mockResolvedValue(flowIdsResponse([1, 2]))
    H.state.fclQuery = async () => { throw new Error("range call died") }
    const out = await runPaginatedDetailsBackfill(pagArgs({ skipCached: false }))
    expect(out.complete).toBe(false) // isComplete = !allChunksFailed && nextStartIndex===null
    const log = lastLog()
    expect(log.p_ok).toBe(false)
    expect(log.p_extra.terminated_reason).toBe("pagination_failed")
    expect(log.p_extra.pagination_chunk_errors).toBeGreaterThan(0)
  })

  it("breaks on the caller soft deadline and returns a resume cursor", async () => {
    ;(fetch as any).mockResolvedValue(flowIdsResponse([1, 2, 3]))
    H.state.fclQuery = async () => [["1", "1", "1"]]
    const out = await runPaginatedDetailsBackfill(
      pagArgs({ skipCached: false, softDeadlineAt: Date.now() - 1, startIndex: 0 }),
    )
    expect(out.complete).toBe(false)
    expect(out.nextStartIndex).toBe(0)
    expect(lastLog().p_extra.terminated_reason).toBe("soft_deadline")
  })

  it("logs pagination_failed (ok=false) when the getIDs() fetch throws", async () => {
    ;(fetch as any).mockResolvedValue({ ok: false, status: 500, text: async () => "down" })
    const out = await runPaginatedDetailsBackfill(pagArgs())
    expect(out).toEqual({ rowsFound: 0, complete: true, nextStartIndex: null })
    expect(lastLog().p_ok).toBe(false)
    expect(lastLog().p_extra.terminated_reason).toBe("pagination_failed")
  })
})

// ── runPinnacleDetailsBackfill: the rest of the error taxonomy ───────────────
// The AllDay twin has every arm driven; Pinnacle only had three. These are the
// remaining ones, and the classification is what makes them worth pinning: each
// arm decides whether a failure PAGES (ok=false) or is a known, self-recovering
// condition (ok=true + a terminated_reason). Misfiling one either wakes an
// operator for a wallet with no Pinnacle collection, or silently swallows a real
// backfill failure.
describe("runPinnacleDetailsBackfill — error taxonomy + post-pass", () => {
  const PIN_CFG2 = {
    slug: "disney_pinnacle",
    collectionUuid: PINNACLE_COLLECTION_UUID,
    cadenceScript: CADENCE_PINNACLE,
    pipelineName: "wallet-backfill-pinnacle",
  }
  const args = (over: Partial<any> = {}) => baseArgs({ config: PIN_CFG2, ...over })

  it("treats a storage-limit breach as ok and flags the wallet for a sharded scan", async () => {
    H.state.fclQuery = async () => { throw new Error("max interaction with storage exceeded (1106)") }
    const out = await runPinnacleDetailsBackfill(args())
    const log = lastLog()
    expect(log.p_ok).toBe(true)
    expect(log.p_extra.terminated_reason).toBe("storage_limit_exceeded")
    expect(log.p_extra.flagged_for_sharded_scan).toBe(true)
    expect(out.complete).toBe(true)
  })

  it("falls through to the paginated path on an access-api 500 (the other computation-limit shape)", async () => {
    let call = 0
    H.state.fclQuery = async () => {
      call++
      if (call === 1) throw new Error("Flow script failed: error=internal server error at /v1/scripts")
      return [{ id: "3", editionKey: "k", serial: "1" }]
    }
    ;(fetch as any).mockResolvedValue(flowIdsResponse([3]))
    const out = await runPinnacleDetailsBackfill(args())
    expect(lastLog().p_extra.mode).toBe("details_pinnacle_paginated")
    expect(out.complete).toBe(true)
  })

  it("classifies a FAST HTTP-400 InvalidArgument as no_collection_capability (ok, not a page)", async () => {
    H.state.fclQuery = async () => { throw new Error("Flow script HTTP 400: code = InvalidArgument desc = failed to ex") }
    const out = await runPinnacleDetailsBackfill(args())
    const log = lastLog()
    expect(log.p_ok).toBe(true)
    expect(log.p_extra.terminated_reason).toBe("no_collection_capability")
    expect(log.p_extra.flagged_for_no_capability).toBe(true)
    expect(out.complete).toBe(true)
  })

  it("logs a hard error (ok=false) for an unclassified failure", async () => {
    H.state.fclQuery = async () => { throw new Error("something nobody has seen before") }
    const out = await runPinnacleDetailsBackfill(args())
    const log = lastLog()
    expect(log.p_ok).toBe(false)
    expect(log.p_extra.terminated_reason).toBe("error")
    expect(log.p_error).toContain("something nobody has seen before")
    expect(out.complete).toBe(true)
  })

  it("keeps the run ok when the post-pass metadata RPC errors or throws", async () => {
    H.state.fclQuery = async () => [{ id: "1", editionKey: "royal:foil:1", serial: "5" }]
    H.state.upsertResult = { data: { written: 1 }, error: null }

    H.state.backfillResult = { data: null, error: { message: "post-pass down" } }
    await runPinnacleDetailsBackfill(args())
    expect(lastLog().p_ok).toBe(true)
    expect(lastLog().p_extra.post_pass_metadata_updated).toBe(0)

    H.state.backfillResult = { data: 7, error: null }
    await runPinnacleDetailsBackfill(args())
    expect(lastLog().p_extra.post_pass_metadata_updated).toBe(7)
  })

  it("skips already-cached ids when skipCached=true and reports them as skipped", async () => {
    H.state.fclQuery = async () => [
      { id: "1", editionKey: "royal:foil:1", serial: "5" },
      { id: "2", editionKey: "royal:foil:2", serial: "6" },
    ]
    H.state.cachedRows = [{ moment_id: "1", edition_key: "royal:foil:1" }]
    H.state.upsertResult = { data: { written: 1 }, error: null }

    await runPinnacleDetailsBackfill(args({ skipCached: true }))
    const log = lastLog()
    expect(log.p_extra.on_chain_count).toBe(2)
    expect(log.p_extra.skipped_cached).toBe(1)
    expect(log.p_extra.rows_to_write).toBe(1)
  })
})
