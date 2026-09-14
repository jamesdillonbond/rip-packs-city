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
    // Overrides the head:true count returned for wallet_moments_cache (used by
    // countCachedRows in the empty-scan honesty guard). null => derive from
    // cachedRows.length.
    cachedCount: null as number | null,
    cachedError: null as any,
    // rpc results
    upsertResult: { data: { written: 0 }, error: null } as any,
    backfillResult: { data: 0, error: null } as any,
    // seeded_wallets SELECT result — drives the stats-refresh freshness gate in
    // stampLastRefreshed. Default [] = "never refreshed" => always refresh,
    // which is the pre-2026-07-26 behaviour every other test assumes.
    seededWalletRows: [] as Array<{ last_refreshed_at: string | null }>,
    // lock + fcl + username-resolve
    lockClaim: true as boolean | "db_saturated",
    fclQuery: (async () => []) as (arg?: any) => Promise<any>,
    usernameOutcome: { found: false, reason: "not_found" } as any,
    // captured
    rpcCalls: [] as Array<{ name: string; params: any }>,
    // every builder method call on a wallet_moments_cache read, in order —
    // pins the keyset-paging shape (2026-08-30: no .range, .gt cursor).
    wmcReadCalls: [] as Array<{ method: string; args: any[] }>,
    // Every wallet_moments_cache DELETE, captured by its filters (the whole
    // safety property of a delete) plus the id list it was handed.
    wmcDeletes: [] as Array<{
      options: any
      filters: Array<{ method: string; args: any[] }>
      ids: string[]
    }>,
    // Forces the delete chain to return an error, to drive the partial path.
    deleteError: null as any,
  }

  function resolveRead(ctx: any) {
    if (ctx.op === "delete") {
      const rec = ctx.deleteRec
      if (state.deleteError) return { data: null, error: state.deleteError, count: null }
      return { data: null, error: null, count: rec ? rec.ids.length : 0 }
    }
    if (ctx.table === "wallet_moments_cache") {
      if (state.cachedError) return { data: null, error: state.cachedError, count: null }
      // countCachedRows() reads `count` (head:true). Default: derive from
      // cachedRows; tests can override via state.cachedCount.
      const count = state.cachedCount != null
        ? state.cachedCount
        : (Array.isArray(state.cachedRows) ? state.cachedRows.length : 0)
      // Emulate keyset paging: `.gt("moment_id", cursor)` then `.limit(n)`.
      let rows = Array.isArray(state.cachedRows) ? [...state.cachedRows] : state.cachedRows
      if (Array.isArray(rows)) {
        if (ctx.gtMomentId != null) rows = rows.filter((r: any) => String(r.moment_id) > ctx.gtMomentId)
        if (ctx.limit != null) rows = rows.slice(0, ctx.limit)
      }
      return { data: rows, error: null, count }
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
          "select", "eq", "in", "order", "limit", "is", "gte", "lt", "gt",
          "not", "ilike", "upsert", "insert", "delete", "update", "range",
        ]) {
          b[m] = (...a: any[]) => {
            if (m === "update") ctx.op = "update"
            if (m === "delete") {
              ctx.op = "delete"
              ctx.deleteRec = { options: a[0], filters: [], ids: [] as string[] }
              if (table === "wallet_moments_cache") state.wmcDeletes.push(ctx.deleteRec)
            }
            if (ctx.op === "delete" && m !== "delete") {
              ctx.deleteRec.filters.push({ method: m, args: a })
              if (m === "in" && a[0] === "moment_id") ctx.deleteRec.ids = a[1].map(String)
            }
            if (table === "wallet_moments_cache" && ctx.op !== "delete") {
              state.wmcReadCalls.push({ method: m, args: a })
              if (m === "gt" && a[0] === "moment_id") ctx.gtMomentId = String(a[1])
              if (m === "limit") ctx.limit = a[0]
            }
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
  claimPipelineLock: async () => H.state.lockClaim === true,
  // Mirrors the real helper: boolean true/false = claimed / held by a sibling;
  // the literal "db_saturated" = the claim was refused by a saturated database.
  claimPipelineLockDetailed: async () =>
    H.state.lockClaim === "db_saturated"
      ? { claimed: false, reason: "db_saturated" }
      : H.state.lockClaim
        ? { claimed: true, reason: "claimed" }
        : { claimed: false, reason: "in_progress" },
  skippedReasonFor: (claim: { reason: string }) =>
    claim.reason === "db_saturated" ? "skipped_db_saturated" : "skipped_in_progress",
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
  GET_GOLAZOS_MOMENT_DETAILS,
  CADENCE_UFC,
  ALLDAY_COLLECTION_UUID,
  PINNACLE_COLLECTION_UUID,
  GOLAZOS_COLLECTION_UUID,
  UFC_COLLECTION_UUID,
} from "@/lib/chains/flow/wallet-backfill-helpers"
import { deleteUnseenWmcRows, unseenDeleteExtra } from "@/lib/chains/flow/wmc-unseen-delete"

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
  H.state.cachedCount = null
  H.state.cachedError = null
  H.state.upsertResult = { data: { written: 0 }, error: null }
  H.state.backfillResult = { data: 0, error: null }
  H.state.seededWalletRows = []
  H.state.lockClaim = true
  H.state.fclQuery = async () => []
  H.state.usernameOutcome = { found: false, reason: "not_found" }
  H.state.rpcCalls = []
  H.state.wmcDeletes = []
  H.state.deleteError = null
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

  // ── NON-Error REJECTIONS ─────────────────────────────────────────────────
  //
  // Every classifier is `err instanceof Error ? err.message : String(err)`, and
  // until now only two of the five had ANY non-Error case — so the `String(err)`
  // half was dark for the other three. It is not a hypothetical path: FCL and
  // the Flow REST wrapper both reject with non-Error values in practice.
  //
  // ⚠ WHAT THESE PIN IS A REAL LIMITATION, NOT A FIX. `String(err)` on an
  // OBJECT-shaped rejection yields "[object Object]", so a genuine 1106 arriving
  // as `{ message: "... 1106 ..." }` is NOT classified — and the consequence is
  // operational, not cosmetic: storage/computation-limit wallets are marked
  // `ok: true` with a terminated_reason precisely so they stop counting as
  // pipeline failures, so a missed classification puts a permanently-unfixable
  // mega-wallet back into the failure count forever, where it looks like a
  // regression nobody can clear.
  //
  // These tests deliberately DOCUMENT the current behaviour rather than assert
  // the behaviour I would prefer. Reading `.message` off an object-shaped
  // rejection would change retry-vs-abort on production wallet ingest, which is
  // a behaviour change to make deliberately and measure — not a side effect of a
  // coverage pass. Filed rather than shipped.
  it("classifiers read a raw STRING rejection (the String(err) half)", () => {
    expect(isStorageLimitError("Cadence error code 1106 raised")).toBe(true)
    expect(isComputationLimitError("computation exceeds limit (100000)")).toBe(true)
    expect(isAccessApiInternalServerError("error=internal server error path=/v1/scripts")).toBe(true)
    expect(
      isNoCollectionCapabilityError("Flow script HTTP 400: code = InvalidArgument desc = x"),
    ).toBe(true)
  })

  it("an OBJECT-shaped rejection stringifies to [object Object] and is NOT classified", () => {
    // ⚠ Documented limitation — see the block comment above. If this ever starts
    // returning true, someone has taught the classifiers to read `.message` off
    // a non-Error, which is a deliberate change to ingest retry behaviour and
    // should arrive with a measurement of how many wallets it re-classifies.
    const objectShaped = { message: "Cadence error code 1106: max interaction with storage" }
    expect(isStorageLimitError(objectShaped)).toBe(false)
    expect(isComputationLimitError({ message: "computation exceeds limit (100000)" })).toBe(false)
    expect(
      isAccessApiInternalServerError({ message: "error=internal server error /v1/scripts" }),
    ).toBe(false)
  })

  it("null / undefined rejections are classified as unknown, never as a limit", () => {
    // `String(null)` is "null" and `String(undefined)` is "undefined" — neither
    // matches any pattern, which is the safe direction: an unknown failure must
    // stay a real failure rather than be silently marked ok:true.
    for (const bad of [null, undefined, 0, false]) {
      expect(isStorageLimitError(bad), `${String(bad)} must not read as a storage limit`).toBe(false)
      expect(isComputationLimitError(bad)).toBe(false)
      expect(isAccessApiInternalServerError(bad)).toBe(false)
      expect(isNoCollectionCapabilityError(bad)).toBe(false)
      expect(isFlowQueryTimeout(bad)).toBe(false)
    }
  })

  it("isStorageLimitError is CASE-INSENSITIVE but isAccessApiInternalServerError's shape check is explicit", () => {
    // The storage/computation classifiers lowercase the message first; the other
    // two rely on /i flags instead. Both work, and mixing them up when adding a
    // sixth classifier is the easy mistake — an uppercased upstream message
    // would silently stop matching a non-/i pattern.
    expect(isStorageLimitError(new Error("MAX INTERACTION WITH STORAGE EXCEEDED"))).toBe(true)
    expect(isComputationLimitError(new Error("COMPUTATION EXCEEDS LIMIT (100000)"))).toBe(true)
    expect(isAccessApiInternalServerError(new Error("ERROR=INTERNAL SERVER ERROR /V1/SCRIPTS"))).toBe(true)
    expect(
      isNoCollectionCapabilityError(new Error("FLOW SCRIPT HTTP 400: CODE = INVALIDARGUMENT")),
    ).toBe(true)
  })

  it("isNoCollectionCapabilityError's elapsed gate is checked ON the boundary", () => {
    // ⚠ The guard is `elapsedMs > 10_000`, and a fixture at 4s or 20s passes
    // whether the comparison is `>` or `>=` and whether the constant is 10s or
    // 15s — so the existing cases assert far less about the gate than they look
    // like they do. Exactly 10,000 must still classify (the boundary is
    // exclusive); one millisecond past must not.
    const msg = "Flow script HTTP 400: code = InvalidArgument desc = failed to ex"
    expect(isNoCollectionCapabilityError(new Error(msg), 10_000)).toBe(true)
    expect(isNoCollectionCapabilityError(new Error(msg), 10_001)).toBe(false)
    // A non-numeric elapsed is ignored entirely rather than treated as slow —
    // otherwise omitting the argument would flip the verdict.
    expect(isNoCollectionCapabilityError(new Error(msg), undefined)).toBe(true)
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

  it("Golazos details script borrows the broad CollectionPublic interface (has borrowNFT), not the narrow Collection", () => {
    // The narrow &{NonFungibleToken.Collection} borrow returned nil for ~23 live
    // wallets holding real moments (2026-08-04). CollectionPublic is broader and
    // declares borrowNFT, so it resolves for those wallets too.
    expect(GET_GOLAZOS_MOMENT_DETAILS).toContain("&{NonFungibleToken.CollectionPublic}")
    expect(GET_GOLAZOS_MOMENT_DETAILS).not.toContain("&{NonFungibleToken.Collection}>")
    expect(GET_GOLAZOS_MOMENT_DETAILS).toContain("borrowNFT")
    expect(GET_GOLAZOS_MOMENT_DETAILS).toContain("/public/GolazosNFTCollection")
    expect(GET_GOLAZOS_MOMENT_DETAILS).toContain("/public/GolazoNFTCollection")
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

  it("no-ops with skipped_db_saturated when the claim was refused by a saturated database (2026-08-30)", async () => {
    H.state.lockClaim = "db_saturated"
    const out = await runIdOnlyBackfill(baseArgs())
    expect(out).toEqual({ rowsFound: 0 })
    expect(lastLog().p_ok).toBe(true)
    expect(lastLog().p_extra.terminated_reason).toBe("skipped_db_saturated")
    // No chain walk and no write: the whole point is adding zero load.
    expect(fetch).not.toHaveBeenCalled()
    expect(H.state.rpcCalls.some((c: any) => c.name === "upsert_wmc_batch")).toBe(false)
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

  it("reads the cache with keyset paging (moment_id > last, no OFFSET) and the Set is complete across pages (2026-08-30)", async () => {
    // 1,500 cached ids → two pages of the 1,000-row reader. LIMIT/OFFSET made
    // page k re-walk k*1000 index entries (O(n²) on a 154k-row whale).
    const ids = Array.from({ length: 1500 }, (_, i) => String(100000 + i))
    H.state.cachedRows = ids.map((moment_id) => ({ moment_id }))
    H.state.wmcReadCalls.length = 0
    ;(fetch as any).mockResolvedValue(flowIdsResponse(ids.map(Number)))
    const out = await runIdOnlyBackfill(baseArgs({ skipCached: true }))
    expect(out.rowsFound).toBe(1500)
    // Every on-chain id was found in the cache → nothing to upsert.
    expect(lastLog().p_rows_skipped).toBe(1500)
    expect(H.state.rpcCalls.some((c: any) => c.name === "upsert_wmc_batch")).toBe(false)
    const calls = H.state.wmcReadCalls
    expect(calls.some((c: any) => c.method === "range")).toBe(false)
    const gts = calls.filter((c: any) => c.method === "gt")
    expect(gts).toHaveLength(1) // first page has no cursor; second page has one
    expect(gts[0].args).toEqual(["moment_id", ids[999]])
    expect(calls.filter((c: any) => c.method === "limit").every((c: any) => c.args[0] === 1000)).toBe(true)
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

  it("no-ops (complete) with skipped_db_saturated when the claim was refused by a saturated database", async () => {
    H.state.lockClaim = "db_saturated"
    const out = await runAllDayDetailsBackfill(baseArgs())
    expect(out).toEqual({ rowsFound: 0, complete: true, nextStartIndex: null })
    expect(lastLog().p_extra.terminated_reason).toBe("skipped_db_saturated")
  })

  it("logs no_more_moments (complete) for a wallet with no triples", async () => {
    H.state.fclQuery = async () => []
    const out = await runAllDayDetailsBackfill(baseArgs())
    expect(out).toEqual({ rowsFound: 0, complete: true, nextStartIndex: null })
    expect(lastLog().p_extra.mode).toBe("details_allday")
  })

  // ── empty-scan honesty guards (2026-08-04 Golazos shell fix) ───────────────
  // A golazos-style config that opts into the guard.
  const GOLAZOS_CFG = {
    slug: "laliga_golazos",
    collectionUuid: GOLAZOS_COLLECTION_UUID,
    cadenceScript: CADENCE_GOLAZOS,
    detailsCadence: GET_GOLAZOS_MOMENT_DETAILS,
    detailsMode: "details_golazos",
    pipelineName: "wallet-backfill-golazos",
    flagEmptyWithCachedHoldings: true,
  }

  it("flags a non-array fcl result as ok:false (never a silent empty)", async () => {
    H.state.fclQuery = async () => null // degraded resolve, NOT a real [] array
    const out = await runAllDayDetailsBackfill(baseArgs())
    expect(out).toEqual({ rowsFound: 0, complete: false, nextStartIndex: null })
    const log = lastLog()
    expect(log.p_ok).toBe(false)
    expect(log.p_extra.terminated_reason).toBe("non_array_scan_result")
    // must NOT stamp a clean refresh on a failed read
    expect(H.state.rpcCalls.some((c: any) => c.name === "refresh_seeded_wallet_stats")).toBe(false)
  })

  it("flags an empty scan as ok:false when the wallet still has cached holdings (guard on)", async () => {
    H.state.fclQuery = async () => []
    H.state.cachedCount = 1832 // wallet has cached wmc rows but scan returned 0
    const out = await runAllDayDetailsBackfill(baseArgs({ config: GOLAZOS_CFG }))
    expect(out).toEqual({ rowsFound: 0, complete: false, nextStartIndex: null })
    const log = lastLog()
    expect(log.p_ok).toBe(false)
    expect(log.p_extra.terminated_reason).toBe("empty_scan_but_cached_holdings")
    expect(log.p_extra.cached_row_count).toBe(1832)
    expect(log.p_extra.mode).toBe("details_golazos")
    // stale wallet must stay stale → no clean refresh stamp
    expect(H.state.rpcCalls.some((c: any) => c.name === "refresh_seeded_wallet_stats")).toBe(false)
  })

  it("does NOT flag a genuinely-empty wallet (guard on, zero cached rows)", async () => {
    H.state.fclQuery = async () => []
    H.state.cachedCount = 0
    const out = await runAllDayDetailsBackfill(baseArgs({ config: GOLAZOS_CFG }))
    expect(out).toEqual({ rowsFound: 0, complete: true, nextStartIndex: null })
    const log = lastLog()
    expect(log.p_ok).toBe(true)
    expect(log.p_extra.terminated_reason).toBe("no_more_moments")
    // genuine empty DOES stamp a refresh
    expect(H.state.rpcCalls.some((c: any) => c.name === "refresh_seeded_wallet_stats")).toBe(true)
  })

  it("keeps the normal empty path when the guard is OFF even with cached rows (AllDay untouched)", async () => {
    H.state.fclQuery = async () => []
    H.state.cachedCount = 500
    const out = await runAllDayDetailsBackfill(baseArgs()) // CFG = allday, no flag
    expect(out).toEqual({ rowsFound: 0, complete: true, nextStartIndex: null })
    expect(lastLog().p_ok).toBe(true)
    expect(lastLog().p_extra.terminated_reason).toBe("no_more_moments")
  })

  it("does NOT misroute a Golazos computation-limit into the AllDay paginated path", async () => {
    H.state.fclQuery = async () => { throw new Error("computation exceeds limit (100000)") }
    const out = await runAllDayDetailsBackfill(baseArgs({ config: GOLAZOS_CFG }))
    expect(out).toEqual({ rowsFound: 0, complete: false, nextStartIndex: null })
    const log = lastLog()
    expect(log.p_ok).toBe(false)
    expect(log.p_extra.terminated_reason).toBe("computation_limit_no_paginated_path")
    expect(log.p_extra.mode).toBe("details_golazos")
    // terminated_reason proves the gate blocked the paginated path — had it
    // routed, the reason would be pagination_failed / no_more_moments (paginated).
  })

  it("does NOT misroute a Golazos access-api 500 into the AllDay paginated path", async () => {
    H.state.fclQuery = async () => { throw new Error("error=internal server error path=/v1/scripts") }
    const out = await runAllDayDetailsBackfill(baseArgs({ config: GOLAZOS_CFG }))
    expect(out).toEqual({ rowsFound: 0, complete: false, nextStartIndex: null })
    expect(lastLog().p_ok).toBe(false)
    expect(lastLog().p_extra.terminated_reason).toBe("access_api_500_no_paginated_path")
  })

  it("STILL routes an AllDay computation-limit into the paginated path (unchanged)", async () => {
    // First (single-shot) fcl.query throws 1110; the paginated path then reads
    // getIDs() via fetch and re-queries ranges. We only assert it ENTERED
    // pagination (mode label), i.e. the gate did not block AllDay.
    let call = 0
    H.state.fclQuery = async () => {
      call++
      if (call === 1) throw new Error("Cadence error 1110 computation exceeds limit")
      return [] // range calls return empty → pagination completes cleanly
    }
    ;(fetch as any).mockResolvedValue(flowIdsResponse([1, 2]))
    const out = await runAllDayDetailsBackfill(baseArgs()) // CFG = allday
    expect(String(lastLog().p_extra.mode)).toContain("allday_paginated")
    expect(out.complete).toBe(true)
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
    // The cached row must carry edition_key: skipCached is ENRICHMENT-aware, not
    // presence-only (loadCachedMomentIdsAndKeys -> Map<moment_id, edition_key_present>).
    H.state.cachedRows = [{ moment_id: "100", edition_key: "42" }]
    const out = await runAllDayDetailsBackfill(baseArgs({ skipCached: true }))
    expect(out.rowsFound).toBe(2)
    expect(lastLog().p_extra.skipped_cached).toBe(1)
  })

  // Regression for the Golazos "4,796 rows skipped forever" class: a cached row
  // whose edition_key never got written is NOT enriched, so skipCached must
  // re-walk it. A presence-only Set skipped it on every tick, permanently.
  it("does NOT skip a cached id whose edition_key is still null (re-walks it)", async () => {
    H.state.fclQuery = async () => [["100", "42", "7"], ["101", "43", "8"]]
    H.state.cachedRows = [{ moment_id: "100", edition_key: null }]
    H.state.upsertResult = { data: { written: 2 }, error: null }
    const out = await runAllDayDetailsBackfill(baseArgs({ skipCached: true }))
    expect(out.rowsFound).toBe(2)
    expect(lastLog().p_extra.skipped_cached).toBe(0)
    // both rows are re-written, not just the uncached one
    expect(lastLog().p_extra.rows_to_write).toBe(2)
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

  // ── adaptive chunk narrowing on Cadence 1110 (2026-08-28) ──────────────────
  //
  // The exact text mainnet returned on 2026-08-28 for
  // GET_PINNACLE_UNLOCKED_DETAILS_RANGE(0, 250) against 0x8bc1c0249e2ebb3e.
  // Pinned VERBATIM: `isComputationLimitError` matches /\b1110\b/, and a
  // paraphrase would keep these tests green while the real message stopped
  // being recognised.
  const CADENCE_1110 =
    "[Error Code: 1110] failed to execute script at block (e4fe6b): [Error Code: 1110] " +
    "error caused by: 1 error occurred:\n\t* [Error Code: 1101] cadence runtime error: " +
    "Execution failed:\nerror: computation error: [Error Code: 1110] computation limit " +
    "exceeded (used: 100001, limit: 100000)"

  it("NARROWS the window and retries the SAME offset on a computation limit", async () => {
    // 600 ids so the WINDOW actually binds: count = min(activeChunk, remaining),
    // so a 3-id wallet would ask for 3 no matter how wide activeChunk is and the
    // narrowing would be untestable. allday starts at 1000, so the first window
    // is 600 and it 1110s until the halving schedule reaches <= 250 (1000 -> 500
    // -> 250).
    ;(fetch as any).mockResolvedValue(
      flowIdsResponse(Array.from({ length: 600 }, (_, i) => i + 1)),
    )
    const seen: number[] = []
    H.state.fclQuery = async (arg: any) => {
      // args: (arg, t) => [addr, start, count] — capture the width it asked for.
      const args = arg?.args?.((v: any) => v, {}) ?? []
      seen.push(Number(args[2]))
      if (Number(args[2]) > 250) throw new Error(CADENCE_1110)
      return [["1", "10", "1"]]
    }
    H.state.upsertResult = { data: { written: 1 }, error: null }

    const out = await runPaginatedDetailsBackfill(pagArgs({ skipCached: false }))
    const log = lastLog()

    // It recovered instead of writing the wallet off.
    expect(out.complete).toBe(true)
    expect(log.p_ok).toBe(true)
    expect(log.p_extra.pagination_chunks).toBeGreaterThan(0)
    // A narrowing is NOT a chunk error — the offset was retried, not skipped.
    expect(log.p_extra.pagination_chunk_errors).toBe(0)
    expect(log.p_extra.pagination_narrowings).toBeGreaterThan(0)
    // ...and the size it settled on is reported, so the drift stays observable.
    expect(log.p_extra.pagination_chunk_size_final).toBeLessThan(
      log.p_extra.pagination_chunk_size,
    )
    // It narrowed rather than gave up, and every later window reused the
    // learned width instead of re-probing the failing one.
    expect(seen.filter((c) => c > 250).length).toBeGreaterThan(0)
    expect(seen[seen.length - 1]).toBeLessThanOrEqual(250)
  })

  it("gives up at the floor rather than narrowing forever", async () => {
    // Always 1110, at every width. Must terminate, and must report the failure
    // rather than looping until maxDuration kills the route.
    ;(fetch as any).mockResolvedValue(flowIdsResponse([1, 2]))
    let calls = 0
    H.state.fclQuery = async () => {
      calls++
      if (calls > 40) throw new Error("SAFETY: narrowing did not terminate")
      throw new Error(CADENCE_1110)
    }
    const out = await runPaginatedDetailsBackfill(pagArgs({ skipCached: false }))
    const log = lastLog()

    expect(calls).toBeLessThanOrEqual(40)
    expect(out.complete).toBe(false)
    expect(log.p_ok).toBe(false)
    expect(log.p_extra.terminated_reason).toBe("pagination_failed")
    expect(log.p_extra.pagination_chunk_errors).toBeGreaterThan(0)
  })

  it("does NOT narrow for an error that is not a computation limit", async () => {
    // The control. A generic failure must keep the old behaviour — count it,
    // skip the window — or every unrelated outage becomes a narrowing storm.
    ;(fetch as any).mockResolvedValue(flowIdsResponse([1, 2]))
    H.state.fclQuery = async () => { throw new Error("range call died") }
    await runPaginatedDetailsBackfill(pagArgs({ skipCached: false }))
    const log = lastLog()
    expect(log.p_extra.pagination_narrowings).toBe(0)
    expect(log.p_extra.pagination_chunk_errors).toBeGreaterThan(0)
  })

  it("reports the narrowing fields even on a clean first-try run", async () => {
    // Absent-vs-zero: an observer asking "how often are we narrowing" must get
    // 0 from a healthy run, never NULL.
    ;(fetch as any).mockResolvedValue(flowIdsResponse([500, 501]))
    H.state.fclQuery = async () => [["500", "60", "1"], ["501", "61", "2"]]
    H.state.upsertResult = { data: { written: 2 }, error: null }
    await runPaginatedDetailsBackfill(pagArgs({ skipCached: false }))
    const log = lastLog()
    expect(Object.keys(log.p_extra)).toEqual(
      expect.arrayContaining(["pagination_narrowings", "pagination_chunk_size_final"]),
    )
    expect(log.p_extra.pagination_narrowings).toBe(0)
    expect(log.p_extra.pagination_chunk_size_final).toBe(log.p_extra.pagination_chunk_size)
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

// ── delete-not-seen: phantom holdings after a moment LEAVES a wallet ─────────
//
// The defect (2026-09-14, wallet 0x0d79d58c5fe83cdc): wallet_moments_cache is
// only ever written, never pruned on sale/transfer. The sole cleanup is the
// weekly prune_stale_wmc() at last_seen_at > 14 days, so a sold moment inflated
// the dashboard, the /share card and cached_moment_count for ~14-21 days. His
// complete Top Shot pass saw 1,109 moments against 1,159 cached rows.
//
// The load-bearing design claim these pin: the trigger is the OBSERVED ID-SET,
// never last_seen_at. upsert_wmc_batch is change-detecting (it skips a row whose
// edition_key/serial are unchanged and whose last_seen_at is under 24h), so a
// complete pass can confirm every moment and write NOTHING — measured the same
// day on 0xba1a13299beb4b19: found 100, wrote 0. A timestamp-keyed prune would
// have deleted all 100 real, currently-held moments.
describe("deleteUnseenWmcRows (direct)", () => {
  // Driven directly, because the RUNNER-level tests cannot reach two of this
  // helper's own guards: a runner with an empty scan returns before it ever
  // calls the helper, so the helper's empty-observed refusal is unreachable
  // from there and a test that looked like it covered the guard covered the
  // runner's early return instead (caught by mutation, 2026-09-14).
  const call = (over: Partial<Parameters<typeof deleteUnseenWmcRows>[0]> = {}) =>
    deleteUnseenWmcRows({
      wallet: WALLET,
      collectionUuid: ALLDAY_COLLECTION_UUID,
      observedIds: new Set(["1"]),
      pipelineName: "test",
      ...over,
    })

  it("refuses to delete on an EMPTY observed set even with rows cached", async () => {
    H.state.cachedRows = [{ moment_id: "1" }, { moment_id: "2" }]
    const out = await call({ observedIds: new Set<string>() })
    expect(out).toEqual({ deleted: 0, skippedReason: "empty_observed" })
    expect(H.state.wmcDeletes).toHaveLength(0)
  })

  it("refuses when the diff exceeds 90% of a >100-row wallet", async () => {
    H.state.cachedRows = Array.from({ length: 200 }, (_, i) => ({ moment_id: "m" + i }))
    const out = await call({ observedIds: new Set(["m0", "m1"]) })
    expect(out).toEqual({ deleted: 0, skippedReason: "suspiciously_large" })
    expect(H.state.wmcDeletes).toHaveLength(0)
  })

  it("applies the cap only ABOVE 100 cached rows, so an ordinary sell-off still prunes", async () => {
    H.state.cachedRows = Array.from({ length: 100 }, (_, i) => ({ moment_id: "m" + i }))
    const out = await call({ observedIds: new Set(["m0"]) })
    expect(out.deleted).toBe(99)
    expect(out.skippedReason).toBeUndefined()
  })

  it("uses the caller's cached snapshot instead of re-reading the cache", async () => {
    // A second keyset walk on a 154k-row whale is a full index scan for no new
    // information; the reuse is the reason the delete costs nothing extra.
    H.state.cachedRows = [{ moment_id: "ignored" }]
    H.state.wmcReadCalls = []
    const out = await call({ observedIds: new Set(["a"]), cachedIds: new Set(["a", "b"]) })
    expect(out.deleted).toBe(1)
    expect(H.state.wmcDeletes[0].ids).toEqual(["b"])
    expect(H.state.wmcReadCalls).toHaveLength(0)
  })

  it("reads the cache itself when the caller has no snapshot (skip_cached=false)", async () => {
    H.state.cachedRows = [{ moment_id: "1" }, { moment_id: "2" }]
    H.state.wmcReadCalls = []
    const out = await call({ observedIds: new Set(["1"]) })
    expect(out.deleted).toBe(1)
    expect(H.state.wmcReadCalls.length).toBeGreaterThan(0)
  })

  it("chunks the id list so a large prune never builds one oversized request", async () => {
    const cached = new Set(Array.from({ length: 450 }, (_, i) => "k" + i))
    // 100 still held (under the >90% cap), 350 to delete at 200/chunk -> 200 + 150.
    const observed = new Set(Array.from({ length: 100 }, (_, i) => "k" + i))
    const out = await call({ observedIds: observed, cachedIds: cached })
    expect(H.state.wmcDeletes.map((d: any) => d.ids.length)).toEqual([200, 150])
    expect(out.deleted).toBe(350)
  })

  it("stops and reports on a failed chunk rather than counting it as deleted", async () => {
    H.state.deleteError = { message: "boom" }
    const out = await call({ observedIds: new Set(["a"]), cachedIds: new Set(["a", "b"]) })
    expect(out.deleted).toBe(0)
    expect(out.error).toContain("boom")
  })

  it("unseenDeleteExtra always carries unseen_deleted, and a skip says WHY", () => {
    // A skip that reported nothing would read as "nothing had left the wallet".
    expect(unseenDeleteExtra({ deleted: 0 })).toEqual({ unseen_deleted: 0 })
    expect(unseenDeleteExtra({ deleted: 0, skippedReason: "empty_observed" })).toEqual({
      unseen_deleted: 0,
      unseen_delete_skipped: "empty_observed",
    })
  })
})

describe("delete-not-seen (wmc phantom holdings)", () => {
  const deletedIds = () => H.state.wmcDeletes.flatMap((d: any) => d.ids)

  it("deletes exactly the cached ids the complete pass did not observe", async () => {
    ;(fetch as any).mockResolvedValue(flowIdsResponse([10, 11]))
    H.state.cachedRows = [{ moment_id: "10" }, { moment_id: "11" }, { moment_id: "12" }]
    await runIdOnlyBackfill(baseArgs({ skipCached: false }))
    expect(deletedIds()).toEqual(["12"])
    expect(lastLog().p_extra.unseen_deleted).toBe(1)
  })

  it("scopes every delete by wallet AND collection AND an explicit id list", async () => {
    // The whole safety property of a DELETE lives in its filters: a missing or
    // negated predicate removes the complement. Assert the shape, not the count.
    ;(fetch as any).mockResolvedValue(flowIdsResponse([10]))
    H.state.cachedRows = [{ moment_id: "10" }, { moment_id: "99" }]
    await runIdOnlyBackfill(baseArgs({ skipCached: false }))
    expect(H.state.wmcDeletes).toHaveLength(1)
    const d = H.state.wmcDeletes[0]
    expect(d.options).toEqual({ count: "exact" })
    expect(d.filters.map((f: any) => [f.method, f.args[0]])).toEqual([
      ["eq", "wallet_address"],
      ["eq", "collection_id"],
      ["in", "moment_id"],
    ])
    expect(d.filters[0].args[1]).toBe(WALLET)
    expect(d.filters[1].args[1]).toBe(ALLDAY_COLLECTION_UUID)
    expect(d.filters[2].args[1]).toEqual(["99"])
    // Never a negated filter — .not()/.neq() here deletes the complement.
    expect(d.filters.some((f: any) => f.method === "not" || f.method === "neq")).toBe(false)
  })

  it("a complete pass that WROTE NOTHING deletes nothing when it observed every cached id (the 0xba1a trap)", async () => {
    // found=N, written=0 via the change-detect skip. A prune keyed on
    // "last_seen older than this pass" deletes all N here; this one must not.
    ;(fetch as any).mockResolvedValue(flowIdsResponse([1, 2, 3]))
    H.state.cachedRows = [{ moment_id: "1" }, { moment_id: "2" }, { moment_id: "3" }]
    H.state.upsertResult = { data: { written: 0 }, error: null }
    await runIdOnlyBackfill(baseArgs({ skipCached: true }))
    expect(lastLog().p_rows_written).toBe(0)
    expect(H.state.wmcDeletes).toHaveLength(0)
    expect(lastLog().p_extra.unseen_deleted).toBe(0)
  })

  it("an EMPTY scan never deletes — a degraded read and an emptied wallet are the same result", async () => {
    // A nil capability borrow returns [] exactly like an empty collection, so
    // zero observed ids can never license a delete. The 14-day prune is the
    // backstop for a genuinely emptied wallet.
    ;(fetch as any).mockResolvedValue(flowIdsResponse([]))
    H.state.cachedRows = [{ moment_id: "1" }, { moment_id: "2" }]
    await runIdOnlyBackfill(baseArgs({ skipCached: false }))
    expect(H.state.wmcDeletes).toHaveLength(0)
  })

  it("skips the delete when it would remove >90% of a >100-row wallet", async () => {
    H.state.cachedRows = Array.from({ length: 500 }, (_, i) => ({ moment_id: "m" + i }))
    ;(fetch as any).mockResolvedValue(flowIdsResponse(["m0"]))
    await runIdOnlyBackfill(baseArgs({ skipCached: false }))
    expect(H.state.wmcDeletes).toHaveLength(0)
    const extra = lastLog().p_extra
    expect(extra.unseen_deleted).toBe(0)
    expect(extra.unseen_delete_skipped).toBe("suspiciously_large")
  })

  it("does NOT apply the >90% cap to a small wallet — selling 2 of 3 is ordinary", async () => {
    // The cap guards a whale against a latent scan bug; it must not block the
    // normal case, or the guard punishes its own success.
    ;(fetch as any).mockResolvedValue(flowIdsResponse([1]))
    H.state.cachedRows = [{ moment_id: "1" }, { moment_id: "2" }, { moment_id: "3" }]
    await runIdOnlyBackfill(baseArgs({ skipCached: false }))
    expect(deletedIds().sort()).toEqual(["2", "3"])
  })

  it("reports unseen_deleted on EVERY complete pass, including when nothing left", async () => {
    // Absent-vs-zero: an observer keying on unseen_deleted must get 0 from a
    // healthy pass, never NULL.
    ;(fetch as any).mockResolvedValue(flowIdsResponse([1]))
    H.state.cachedRows = [{ moment_id: "1" }]
    await runIdOnlyBackfill(baseArgs({ skipCached: false }))
    expect(Object.keys(lastLog().p_extra)).toContain("unseen_deleted")
    expect(lastLog().p_extra.unseen_deleted).toBe(0)
    expect(lastLog().p_extra.unseen_delete_skipped).toBeUndefined()
  })

  it("surfaces a failed delete chunk instead of reporting the rows as removed", async () => {
    ;(fetch as any).mockResolvedValue(flowIdsResponse([1]))
    H.state.cachedRows = [{ moment_id: "1" }, { moment_id: "2" }]
    H.state.deleteError = { message: "delete boom" }
    await runIdOnlyBackfill(baseArgs({ skipCached: false }))
    const extra = lastLog().p_extra
    expect(extra.unseen_deleted).toBe(0)
    expect(String(extra.unseen_delete_error)).toContain("delete boom")
  })

  it("Pinnacle deletes what its complete details pass did not observe", async () => {
    H.state.fclQuery = async () => [{ id: "1", editionKey: "royal:foil:1", serial: "5" }]
    H.state.cachedRows = [{ moment_id: "1" }, { moment_id: "2" }]
    await runPinnacleDetailsBackfill(
      baseArgs({
        config: {
          slug: "disney_pinnacle",
          collectionUuid: PINNACLE_COLLECTION_UUID,
          cadenceScript: CADENCE_PINNACLE,
          pipelineName: "wallet-backfill-pinnacle",
        },
        skipCached: false,
      }),
    )
    expect(deletedIds()).toEqual(["2"])
  })

  it("a SKIPPED-cached row was still OBSERVED and is never deleted", async () => {
    // observedIds is built before the skip filter. Keying it on what the pass
    // WROTE instead would delete exactly the rows the skip was protecting.
    H.state.fclQuery = async () => [["1", "e1", "1"], ["2", "e2", "2"]]
    H.state.cachedRows = [
      { moment_id: "1", edition_key: "e1" },
      { moment_id: "2", edition_key: "e2" },
    ]
    await runAllDayDetailsBackfill(baseArgs({ skipCached: true }))
    expect(lastLog().p_extra.skipped_cached).toBe(2)
    expect(H.state.wmcDeletes).toHaveLength(0)
  })

  it("an incomplete paginated pass (soft deadline) never deletes", async () => {
    ;(fetch as any).mockResolvedValue(flowIdsResponse([1, 2, 3]))
    H.state.fclQuery = async () => [["1", "1", "1"]]
    H.state.cachedRows = [{ moment_id: "1" }, { moment_id: "9" }]
    const out = await runPaginatedDetailsBackfill({
      ...baseArgs({ skipCached: false, softDeadlineAt: Date.now() - 1, startIndex: 0 }),
      mode: "allday" as const,
      parentTerminatedReason: "computation_limit_exceeded",
      parentErrorExcerpt: "boom",
    })
    expect(out.complete).toBe(false)
    expect(H.state.wmcDeletes).toHaveLength(0)
    expect(lastLog().p_extra.unseen_delete_skipped).toBe("incomplete_pass")
  })

  it("the paginated all-ids-already-enriched exit DOES delete — it is complete and writes nothing", async () => {
    // The found-N/wrote-0 shape again, and the only branch fully-enriched whales
    // ever reach. Skipping it would leave them permanently unprunable.
    ;(fetch as any).mockResolvedValue(flowIdsResponse([1, 2]))
    H.state.cachedRows = [
      { moment_id: "1", edition_key: "a" },
      { moment_id: "2", edition_key: "b" },
      { moment_id: "3", edition_key: "c" },
    ]
    const out = await runPaginatedDetailsBackfill({
      ...baseArgs({ skipCached: true, force: false }),
      mode: "allday" as const,
      parentTerminatedReason: "computation_limit_exceeded",
      parentErrorExcerpt: "boom",
    })
    expect(out.complete).toBe(true)
    expect(lastLog().p_extra.terminated_reason).toBe("all_ids_already_enriched")
    expect(deletedIds()).toEqual(["3"])
  })
})

// ── AllDay LOCKED-moment recovery (studio-platform custody union) ─────────────
//
// The bug (2026-08-08): NFL All Day has no on-chain locking contract, so a
// "locked" moment is held by Dapper and is absent from the wallet's own
// /public/AllDayNFTCollection. getIDs() therefore returns nothing for a wallet
// whose AllDay moments are all locked, and the scan logged ok=true /
// rows_found=0 — indistinguishable from an empty wallet. Real case:
// 0xdcd41c74d2dd0a66 held 5 moments and RPC showed 0.
describe("runAllDayDetailsBackfill — studio custody union", () => {
  const STUDIO_CFG = { ...CFG, studioCustodyHoldings: true }

  function studioResponse(
    nodes: Array<[string, string, string]>,
    totalCount: number = nodes.length,
  ) {
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: {
            searchAllDayNft: {
              totalCount,
              edges: nodes.map(([id, editionId, serial]) => ({
                cursor: `c_${id}`,
                node: { id, serial_number: serial, edition: { id: editionId } },
              })),
            },
          },
        }),
    }
  }

  function upsertRows() {
    const call = H.state.rpcCalls.find((c: any) => c.name === "upsert_wmc_batch")
    return call?.params?.p_rows ?? []
  }

  it("recovers locked moments when the chain sees NOTHING (the reported bug)", async () => {
    H.state.fclQuery = async () => []
    ;(fetch as any).mockResolvedValue(
      studioResponse([
        ["6590418", "2813", "1"],
        ["6605288", "2783", "59"],
        ["5847644", "2392", "355"],
      ]),
    )
    H.state.upsertResult = { data: { written: 3 }, error: null }

    const out = await runAllDayDetailsBackfill(baseArgs({ config: STUDIO_CFG }))

    // Previously this returned rowsFound 0 and wrote nothing.
    expect(out.rowsFound).toBe(3)
    expect(out.complete).toBe(true)
    const rows = upsertRows()
    expect(rows).toHaveLength(3)
    expect(rows[0].moment_id).toBe("6590418")
    expect(rows[0].edition_key).toBe("2813")
    expect(rows[0].serial_number).toBe(1)
  })

  it("keeps on_chain_count honest while reporting what studio added", async () => {
    H.state.fclQuery = async () => [["100", "42", "7"]]
    ;(fetch as any).mockResolvedValue(studioResponse([["200", "43", "8"]]))
    H.state.upsertResult = { data: { written: 2 }, error: null }

    await runAllDayDetailsBackfill(baseArgs({ config: STUDIO_CFG }))

    const extra = lastLog().p_extra
    // on_chain_count must NOT be inflated by custody moments — a future reader
    // has to be able to tell chain truth from Dapper's index.
    expect(extra.on_chain_count).toBe(1)
    expect(extra.holdings_count).toBe(2)
    expect(extra.studio_added).toBe(1)
    expect(extra.studio_ok).toBe(true)
  })

  it("lets the CHAIN win on conflict — studio owner_address can be stale", async () => {
    H.state.fclQuery = async () => [["100", "999", "7"]]
    ;(fetch as any).mockResolvedValue(studioResponse([["100", "111", "42"]]))
    H.state.upsertResult = { data: { written: 1 }, error: null }

    await runAllDayDetailsBackfill(baseArgs({ config: STUDIO_CFG }))

    const rows = upsertRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].edition_key).toBe("999")
    expect(rows[0].serial_number).toBe(7)
    expect(lastLog().p_extra.studio_added).toBe(0)
  })

  // FAIL-SOFT: a studio outage must never break a working on-chain backfill.
  it("still writes the on-chain result when studio fails", async () => {
    H.state.fclQuery = async () => [["100", "42", "7"]]
    ;(fetch as any).mockResolvedValue({ ok: false, status: 503, text: async () => "down" })
    H.state.upsertResult = { data: { written: 1 }, error: null }

    const out = await runAllDayDetailsBackfill(baseArgs({ config: STUDIO_CFG }))

    expect(out.rowsFound).toBe(1)
    expect(upsertRows()).toHaveLength(1)
    const extra = lastLog().p_extra
    expect(extra.studio_ok).toBe(false)
    expect(String(extra.studio_error)).toContain("503")
  })

  it("does not call studio at all for collections that have not opted in", async () => {
    H.state.fclQuery = async () => [["100", "42", "7"]]
    ;(fetch as any).mockResolvedValue(studioResponse([["999", "1", "1"]]))
    H.state.upsertResult = { data: { written: 1 }, error: null }

    // CFG (no studioCustodyHoldings) — Golazos/Pinnacle behaviour is untouched.
    await runAllDayDetailsBackfill(baseArgs())

    expect(upsertRows()).toHaveLength(1)
    expect(lastLog().p_extra.studio_added).toBeUndefined()
    expect(lastLog().p_extra.studio_ok).toBeUndefined()
  })

  it("a wallet genuinely empty in BOTH sources still logs the clean empty path", async () => {
    H.state.fclQuery = async () => []
    ;(fetch as any).mockResolvedValue(studioResponse([], 0))

    const out = await runAllDayDetailsBackfill(baseArgs({ config: STUDIO_CFG }))

    expect(out.rowsFound).toBe(0)
    expect(out.complete).toBe(true)
    expect(lastLog().p_extra.terminated_reason).toBe("no_more_moments")
    expect(lastLog().p_ok).toBe(true)
  })

  // ── delete-not-seen interaction ────────────────────────────────────────────
  // A LOCKED All Day moment is structurally absent from getIDs(), so to a
  // chain-only observer it is indistinguishable from a sold one. These pin the
  // two halves of that: studio is what makes it visible, and a studio walk that
  // DEGRADED must veto the delete entirely rather than let its silence read as
  // "these moments left the wallet".
  it("keeps a LOCKED moment that only studio can see — it was observed, not departed", async () => {
    H.state.fclQuery = async () => [["100", "42", "7"]]
    ;(fetch as any).mockResolvedValue(studioResponse([["200", "43", "8"]]))
    // 100 on chain, 200 locked via studio, 300 genuinely gone.
    H.state.cachedRows = [{ moment_id: "100" }, { moment_id: "200" }, { moment_id: "300" }]

    await runAllDayDetailsBackfill(baseArgs({ config: STUDIO_CFG, skipCached: false }))

    expect(H.state.wmcDeletes.flatMap((d: any) => d.ids)).toEqual(["300"])
  })

  it("does NOT delete when the custody walk degraded — its missing ids are not evidence of a sale", async () => {
    H.state.fclQuery = async () => [["100", "42", "7"]]
    ;(fetch as any).mockResolvedValue({ ok: false, status: 503, text: async () => "down" })
    H.state.cachedRows = [{ moment_id: "100" }, { moment_id: "200" }]

    await runAllDayDetailsBackfill(baseArgs({ config: STUDIO_CFG, skipCached: false }))

    const extra = lastLog().p_extra
    expect(extra.studio_ok).toBe(false)
    expect(H.state.wmcDeletes).toHaveLength(0)
    expect(extra.unseen_deleted).toBe(0)
    expect(extra.unseen_delete_skipped).toBe("studio_custody_walk_degraded")
  })

  it("a collection with NO custody source is not blocked by the studio gate", async () => {
    // The gate must narrow to collections that actually have locked moments, or
    // it silently disables the prune for Golazos/Pinnacle forever.
    H.state.fclQuery = async () => [["100", "42", "7"]]
    H.state.cachedRows = [{ moment_id: "100" }, { moment_id: "300" }]

    await runAllDayDetailsBackfill(baseArgs({ skipCached: false })) // CFG: no studio

    expect(H.state.wmcDeletes.flatMap((d: any) => d.ids)).toEqual(["300"])
    expect(lastLog().p_extra.unseen_delete_skipped).toBeUndefined()
  })
})
