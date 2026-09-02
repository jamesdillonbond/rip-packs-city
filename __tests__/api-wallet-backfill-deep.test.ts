import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of POST /api/wallet-backfill — the fire-and-forget TopShot Cadence
// walk. The shallow test stops at the 202/4xx guards; these capture after() and
// drive the real walk body through a stubbed fcl seam, pinning:
//   - the exact upsert_wmc_batch row contract computed from Cadence metadata
//     (edition_key = setID:playID, parsed serial/series, null-safe fields);
//   - skip_cached diff semantics (cached ids never re-walked, honest skip
//     accounting) vs the forced full walk;
//   - per-moment metadata failures degrade per-row, never the run;
//   - the concurrency lock no-op, storage-limit (1106) ok:true reclass,
//     no-capability reclass, and generic-error ok:false paths;
//   - recordScan + stampLastRefreshed side effects and username resolution.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  ownedIds: [] as number[],
  ownedIdsError: null as Error | null,
  metadataById: {} as Record<string, Record<string, string>>,
  metadataCalls: [] as string[],
  ownedCalls: 0,
  lockClaimed: true as boolean | "db_saturated",
  lockClaims: [] as string[],
  lockReleases: [] as string[],
  resolveOutcome: { found: false } as { found: boolean; walletAddress?: string; reason?: string },
  resolveCalls: [] as string[],
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))
vi.mock("@/lib/chains/flow/flow", () => ({
  default: {
    query: async (opts: { cadence: string; args?: (arg: unknown, t: unknown) => unknown[] }) => {
      if (opts.cadence.includes("getIDs")) {
        state.ownedCalls++
        if (state.ownedIdsError) throw state.ownedIdsError
        return state.ownedIds
      }
      const collected: string[] = []
      opts.args?.(((v: unknown) => {
        collected.push(String(v))
        return v
      }) as never, {} as never)
      const id = collected[1]
      state.metadataCalls.push(id)
      const meta = state.metadataById[id]
      if (!meta) throw new Error(`no nft ${id}`)
      return meta
    },
  },
}))
vi.mock("@/lib/chains/flow/topshot-username-resolve", () => ({
  isWalletAddress: (v: string) => /^(0x)?[a-fA-F0-9]{16}$/.test(v.trim()),
  resolveTopShotUsernameCacheAware: async (_sb: unknown, input: string) => {
    state.resolveCalls.push(input)
    return state.resolveOutcome
  },
}))
vi.mock("@/lib/chains/flow/wallet-backfill-helpers", () => ({
  isStorageLimitError: (err: unknown) =>
    String(err instanceof Error ? err.message : err).includes("1106"),
  isNoCollectionCapabilityError: (err: unknown) =>
    String(err instanceof Error ? err.message : err).includes("could not borrow a reference"),
}))
vi.mock("@/lib/wallet-backfill-lock", () => ({
  walletBackfillLockKey: (slug: string, wallet: string) => `${slug}:${wallet}`,
  claimPipelineLock: async (key: string) => {
    state.lockClaims.push(key)
    return state.lockClaimed === true
  },
  claimPipelineLockDetailed: async (key: string) => {
    state.lockClaims.push(key)
    if (state.lockClaimed === "db_saturated") return { claimed: false, reason: "db_saturated" }
    return state.lockClaimed ? { claimed: true, reason: "claimed" } : { claimed: false, reason: "in_progress" }
  },
  skippedReasonFor: (claim: { reason: string }) =>
    claim.reason === "db_saturated" ? "skipped_db_saturated" : "skipped_in_progress",
  releasePipelineLock: async (key: string) => {
    state.lockReleases.push(key)
  },
}))

const { POST } = await import("@/app/api/wallet-backfill/route")

const WALLET = "0xbd94cade097e50ac"
const TS_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture({
    "rpc:upsert_wmc_batch": { data: { written: 0 }, error: null },
    ...fixtures,
  })
  state.sb = spy.fixture
  return spy
}

function post(body: Record<string, unknown>): NextRequest {
  return new NextRequest("https://t/api/wallet-backfill", {
    method: "POST",
    headers: new Headers({
      authorization: "Bearer backfill-token",
      "content-type": "application/json",
    }),
    body: JSON.stringify(body),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function meta(over: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    player: "Damian Lillard",
    team: "Portland Trail Blazers",
    setName: "Base Set",
    series: "5",
    serial: "12",
    mint: "15000",
    playID: "45",
    setID: "3",
    ...over,
  }
}

function walkLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls
    .filter((c) => c.name === "log_pipeline_run" && c.args?.p_pipeline === "wallet-backfill")
    .at(-1)?.args
}
function scanCall(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.find((c) => c.name === "record_wallet_backfill_scan")?.args
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "backfill-token"
  state.afterCbs.length = 0
  state.ownedIds = []
  state.ownedIdsError = null
  state.metadataById = {}
  state.metadataCalls = []
  state.ownedCalls = 0
  state.lockClaimed = true
  state.lockClaims = []
  state.lockReleases = []
  state.resolveOutcome = { found: false }
  state.resolveCalls = []
})

describe("wallet-backfill — walk + upsert contract", () => {
  it("full walk (skip_cached=false): exact wmc rows, post-pass, stats stamp, scan record, ok log", async () => {
    state.ownedIds = [1, 2, 3]
    state.metadataById = {
      "1": meta({ serial: "12" }),
      "2": meta({ serial: "3401", playID: "46" }),
      "3": meta({ serial: "", series: "", setName: "" }), // null-safe branches
    }
    const spy = install({
      "rpc:upsert_wmc_batch": { data: { written: 3 }, error: null },
      "rpc:backfill_wmc_metadata_from_editions": { data: 2, error: null },
    })

    const res = await POST(post({ wallet: WALLET, skip_cached: false }))
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({
      accepted: true,
      wallet_address: WALLET,
      skip_cached: false,
    })
    await runDeferred()

    // One flush (3 rows < UPSERT_CHUNK) with the handler-computed row shape.
    const upserts = spy.rpcCalls.filter((c) => c.name === "upsert_wmc_batch")
    expect(upserts).toHaveLength(1)
    const rows = upserts[0].args?.p_rows as Array<Record<string, unknown>>
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      wallet_address: WALLET,
      collection_id: TS_UUID,
      moment_id: "1",
      edition_key: "3:45",
      serial_number: 12,
      player_name: "Damian Lillard",
      set_name: "Base Set",
      tier: null,
      series_number: 5,
      acquired_at: null,
      fmv_usd: null,
    })
    expect(typeof rows[0].last_seen_at).toBe("string")
    expect(rows[1]).toMatchObject({ moment_id: "2", edition_key: "3:46", serial_number: 3401 })
    // Empty-string Cadence fields become nulls, not "" echoes.
    expect(rows[2]).toMatchObject({
      moment_id: "3",
      serial_number: null,
      series_number: null,
      set_name: null,
    })

    // Post-pass metadata fill + refresh stamp + per-collection jsonb bump.
    expect(
      spy.rpcCalls.some(
        (c) =>
          c.name === "backfill_wmc_metadata_from_editions" &&
          c.args?.p_wallet_address === WALLET &&
          c.args?.p_collection_id === TS_UUID,
      ),
    ).toBe(true)
    expect(spy.rpcCalls.some((c) => c.name === "refresh_seeded_wallet_stats")).toBe(true)
    const stamp = (spy.writes.seeded_wallets ?? []).find((w) => w.method === "update")
    expect(Object.keys((stamp?.rows[0].last_refreshed_per_collection as object) ?? {})).toEqual([
      "nba_top_shot",
    ])

    expect(scanCall(spy.rpcCalls)).toMatchObject({
      p_wallet: WALLET,
      p_collection_slug: "nba_top_shot",
      p_found_count: 3,
    })

    const log = walkLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 3, p_rows_written: 3, p_rows_skipped: 0 })
    // ⚠ `rows_to_write` is the DENOMINATOR deep-audit R30 asks loss to be judged
    // against. This lane buffers and flushes its own chunks, so it had no `rows`
    // array to measure and emitted nothing — leaving the biggest wallet lane the
    // only one whose loss RATE was not computable. An absolute `chunk_rows_lost: 0`
    // proves nothing on a day only a handful of rows are handed to the writer.
    expect(log?.p_extra).toMatchObject({ chunk_errors: 0, chunk_rows_lost: 0, rows_to_write: 3 })
    expect(log?.p_extra).toMatchObject({
      wallet: WALLET,
      on_chain_count: 3,
      total_moments_seen: 3,
      post_pass_metadata_updated: 2,
      terminated_reason: "no_more_moments",
      skip_cached: false,
    })

    expect(state.lockClaims).toEqual([`nba_top_shot:${WALLET}`])
    expect(state.lockReleases).toEqual([`nba_top_shot:${WALLET}`])
  })

  it("skip_cached (default) walks only the on-chain diff and counts the cached skips honestly", async () => {
    state.ownedIds = [1, 2, 3]
    state.metadataById = { "3": meta({ serial: "7" }) } // 1/2 cached — must never be fetched
    const spy = install({
      wallet_moments_cache: { data: [{ moment_id: "1" }, { moment_id: "2" }], error: null },
      "rpc:upsert_wmc_batch": { data: { written: 1 }, error: null },
    })

    const res = await POST(post({ wallet: WALLET }))
    expect((await res.json()).skip_cached).toBe(true)
    await runDeferred()

    expect(state.metadataCalls).toEqual(["3"])
    const rows = spy.rpcCalls.find((c) => c.name === "upsert_wmc_batch")?.args
      ?.p_rows as Array<Record<string, unknown>>
    expect(rows.map((r) => r.moment_id)).toEqual(["3"])

    const log = walkLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_rows_found: 1, p_rows_written: 1, p_rows_skipped: 2 })
    expect(log?.p_extra).toMatchObject({ on_chain_count: 3, skipped_cached: 2, skip_cached: true })
    // recordScan reports the full on-chain holding, not the diff.
    expect(scanCall(spy.rpcCalls)).toMatchObject({ p_found_count: 3 })
  })

  it("an empty wallet short-circuits: no upsert, stats still stamped, scan records 0", async () => {
    state.ownedIds = []
    const spy = install({})

    await POST(post({ wallet: WALLET, skip_cached: false }))
    await runDeferred()

    expect(spy.rpcCalls.filter((c) => c.name === "upsert_wmc_batch")).toHaveLength(0)
    expect(spy.rpcCalls.some((c) => c.name === "refresh_seeded_wallet_stats")).toBe(true)
    const log = walkLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0 })
    expect(log?.p_extra).toMatchObject({ on_chain_count: 0, terminated_reason: "no_more_moments" })
    expect(scanCall(spy.rpcCalls)).toMatchObject({ p_found_count: 0 })
  })

  it("a per-moment metadata failure degrades that row only — the run stays ok", async () => {
    state.ownedIds = [1, 2]
    state.metadataById = { "1": meta() } // id 2 throws
    const spy = install({ "rpc:upsert_wmc_batch": { data: { written: 1 }, error: null } })

    await POST(post({ wallet: WALLET, skip_cached: false }))
    await runDeferred()

    const rows = spy.rpcCalls.find((c) => c.name === "upsert_wmc_batch")?.args
      ?.p_rows as Array<Record<string, unknown>>
    expect(rows.map((r) => r.moment_id)).toEqual(["1"])
    const log = walkLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 2, p_rows_written: 1 })
    expect(log?.p_extra).toMatchObject({ total_moments_seen: 1 })
  })

  // A per-moment metadata failure (above) is a tolerable partial — the moment was
  // never fetched, so nothing was lost. A failed wmc UPSERT is different: the rows
  // WERE fetched and then dropped. Those used to be console.error'd and swallowed
  // with the run still logging ok:true, making chunk-level data loss invisible
  // (3,497 runs reported 0 failures while ~37 chunks of up to 200 rows vanished).
  it("a failed wmc upsert chunk marks the run ok=false and reports the lost rows", async () => {
    state.ownedIds = [1, 2]
    state.metadataById = { "1": meta(), "2": meta({ playID: "46" }) }
    const spy = install({
      "rpc:upsert_wmc_batch": { data: null, error: { message: "wmc upsert boom" } },
    })

    const res = await POST(post({ wallet: WALLET, skip_cached: false }))
    // The route still accepts + returns 202; the failure surfaces in pipeline_runs.
    expect(res.status).toBe(202)
    await runDeferred()

    const log = walkLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(log?.p_rows_written).toBe(0)
    expect(log?.p_error).toContain("wmc_upsert_chunk_failures=1")
    expect(log?.p_error).toContain("wmc upsert boom")
    expect(log?.p_extra).toMatchObject({
      chunk_errors: 1,
      chunk_rows_lost: 2,
      // Both halves of the ratio, on the same run: 2 of 2 attempted were lost.
      rows_to_write: 2,
      first_chunk_error: "wmc upsert boom",
    })
    // the 2 fetched-but-unwritten rows are attributed as skipped
    expect(log?.p_rows_skipped).toBe(2)
  })
})

describe("wallet-backfill — lock + error reclassification", () => {
  it("a concurrent run holding the lock no-ops (no walk, no release, skipped_in_progress log)", async () => {
    state.lockClaimed = false
    state.ownedIds = [1]
    const spy = install({})

    await POST(post({ wallet: WALLET }))
    await runDeferred()

    expect(state.ownedCalls).toBe(0) // never even asked the chain
    expect(state.lockReleases).toHaveLength(0)
    const log = walkLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0 })
    expect(log?.p_extra).toMatchObject({ terminated_reason: "skipped_in_progress" })
    expect(scanCall(spy.rpcCalls)).toMatchObject({ p_found_count: 0 })
  })

  it("a claim refused by a saturated database no-ops with skipped_db_saturated (no walk, no release) — 2026-08-30", async () => {
    state.lockClaimed = "db_saturated"
    state.ownedIds = [1]
    const spy = install({})

    await POST(post({ wallet: WALLET }))
    await runDeferred()

    expect(state.ownedCalls).toBe(0)
    expect(state.lockReleases).toHaveLength(0)
    const log = walkLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0 })
    expect(log?.p_extra).toMatchObject({ terminated_reason: "skipped_db_saturated" })
  })

  it("Cadence 1106 storage-limit reclassifies as ok:true + sharded-scan flag (mega-wallet, not a failure)", async () => {
    state.ownedIdsError = new Error("[Error Code: 1106] computation exceeds max interaction with storage")
    const spy = install({})

    await POST(post({ wallet: WALLET }))
    await runDeferred()

    const log = walkLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true })
    expect(log?.p_extra).toMatchObject({
      terminated_reason: "storage_limit_exceeded",
      flagged_for_sharded_scan: true,
    })
    // ⚠ THE CHUNK KEYS MUST BE PRESENT ON THIS PATH, not merely zero-valued.
    // These three exit paths used to emit no chunk fields at all, so a run that
    // lost chunks and THEN hit one of them reported neither the loss nor the
    // attempt — the run most likely to have lost rows was the one that hid it.
    // Asserted as PRESENCE, because absent and zero are different answers.
    for (const k of ["chunk_errors", "chunk_rows_lost", "rows_to_write"]) {
      expect(Object.keys(log?.p_extra as object)).toContain(k)
    }
    expect(String((log?.p_extra as Record<string, unknown>).error_excerpt)).toContain("1106")
    expect(state.lockReleases).toEqual([`nba_top_shot:${WALLET}`])
  })

  it("a no-collection-capability wallet reclassifies as ok:true with its own flag", async () => {
    state.ownedIdsError = new Error("could not borrow a reference to the collection")
    const spy = install({})

    await POST(post({ wallet: WALLET }))
    await runDeferred()

    const log = walkLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true })
    expect(log?.p_extra).toMatchObject({
      terminated_reason: "no_collection_capability",
      flagged_for_no_capability: true,
    })
    for (const k of ["chunk_errors", "chunk_rows_lost", "rows_to_write"]) {
      expect(Object.keys(log?.p_extra as object)).toContain(k)
    }
  })

  it("a generic walk error logs ok:false with the message and still releases the lock", async () => {
    state.ownedIdsError = new Error("access node timeout")
    const spy = install({})

    await POST(post({ wallet: WALLET }))
    await runDeferred()

    const log = walkLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: false, p_error: "access node timeout" })
    expect(log?.p_extra).toMatchObject({ terminated_reason: "error" })
    for (const k of ["chunk_errors", "chunk_rows_lost", "rows_to_write"]) {
      expect(Object.keys(log?.p_extra as object)).toContain(k)
    }
    expect(state.lockReleases).toEqual([`nba_top_shot:${WALLET}`])
  })
})

describe("wallet-backfill — input resolution", () => {
  it("resolves a username to its wallet before the walk and reports it in the 202", async () => {
    state.resolveOutcome = { found: true, walletAddress: WALLET }
    state.ownedIds = []
    install({})

    const res = await POST(post({ wallet: "jamesdillonbond" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body).toMatchObject({ accepted: true, wallet_address: WALLET, input: "jamesdillonbond" })
    expect(state.resolveCalls).toEqual(["jamesdillonbond"])
  })

  it("prefixes a bare 16-hex address with 0x", async () => {
    state.ownedIds = []
    install({})
    const res = await POST(post({ wallet: "bd94cade097e50ac" }))
    expect(res.status).toBe(202)
    expect((await res.json()).wallet_address).toBe(WALLET)
    expect(state.resolveCalls).toHaveLength(0)
  })
})
