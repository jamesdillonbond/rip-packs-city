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
vi.mock("@/lib/flow", () => ({ default: { query: (arg?: any) => H.state.fclQuery(arg) } }))
vi.mock("@/lib/wallet-backfill-lock", () => ({
  walletBackfillLockKey: (slug: string, wallet: string) => `${slug}:${wallet}`,
  claimPipelineLock: async () => H.state.lockClaim,
  releasePipelineLock: async () => {},
}))
vi.mock("@/lib/topshot-username-resolve", () => ({
  isWalletAddress: (v: string) => /^(0x)?[0-9a-fA-F]{16}$/.test(v.trim()),
  resolveTopShotUsernameCacheAware: async () => H.state.usernameOutcome,
}))
vi.mock("@/lib/allday-cadence", () => ({
  GET_UNLOCKED_MOMENT_DETAILS: "ALLDAY_DETAILS",
  GET_UNLOCKED_MOMENT_DETAILS_RANGE: "ALLDAY_DETAILS_RANGE",
}))
vi.mock("@/lib/cadence/pinnacle-wallet", () => ({
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

  it("survives an upsert RPC error (logs ok, written stays 0)", async () => {
    ;(fetch as any).mockResolvedValue(flowIdsResponse([1]))
    H.state.upsertResult = { data: null, error: { message: "upsert boom" } }
    const out = await runIdOnlyBackfill(baseArgs())
    expect(out.rowsFound).toBe(1)
    expect(lastLog().p_ok).toBe(true)
    expect(lastLog().p_rows_written).toBe(0)
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
    expect(log.p_extra.terminated_reason).toBe("no_more_moments")
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
