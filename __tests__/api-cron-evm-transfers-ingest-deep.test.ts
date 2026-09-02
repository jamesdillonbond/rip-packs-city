import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of /api/cron/evm-transfers-ingest — the Base/Beezie ERC-721
// Transfer indexer. Captures after() and stubs the @/lib/evm-rpc seam so the
// real decode/window/cursor body runs. Pins:
//   - topic decoding into the exact evm_nft_transfers upsert shape (token_id
//     decimal, last-20-byte addresses, hex block/log index, ISO timestamp) and
//     the cursor advance (+= BLOCKS_PER_WINDOW, running transfer total);
//   - cursor initialization at start_block - 1 for a fresh contract;
//   - defensive skips (ERC-20 3-topic logs, unresolvable timestamps) and the
//     getBlockByNumber timestamp fallback;
//   - 429 handling: window-halving retry, and full-exhaustion recorded as an
//     ok=true DEFERRAL with the cursor untouched (never a fake failure);
//   - non-429 fatal accounting, per-contract budget exhaustion, and the
//     registry/auth guard surfaces.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  getLogsQueue: [] as Array<{ logs?: unknown[]; throw?: string; advanceClockMs?: number }>,
  getLogsCalls: [] as Array<{ slug: string; filter: Record<string, unknown> }>,
  blocksByNumber: {} as Record<string, { timestamp: string } | null>,
  blockCalls: [] as string[],
  // Chain head. The route now clamps every window to this and walks windows
  // until it is reached, so a test that wants exactly ONE window sets it to
  // that window's to-block. 6000 = the default cursor (1000) + one 5000 window.
  headBlock: 6000,
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
vi.mock("@/lib/evm-rpc", () => ({
  getLogs: async (slug: string, filter: Record<string, unknown>) => {
    state.getLogsCalls.push({ slug, filter })
    const b = state.getLogsQueue.shift() ?? { logs: [] }
    if (b.advanceClockMs) vi.setSystemTime(Date.now() + b.advanceClockMs)
    if (b.throw) throw new Error(b.throw)
    return b.logs ?? []
  },
  getBlockByNumber: async (_slug: string, bn: string) => {
    state.blockCalls.push(bn)
    return state.blocksByNumber[bn] ?? null
  },
  getBlockNumber: async () => state.headBlock,
}))

const { GET, POST } = await import("@/app/api/cron/evm-transfers-ingest/route")

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
const CONTRACT = "0xC0FFEE254729296a45a3885639AC7E10F9d54979"
const BEEZIE = { chain_id: 8453, contract_address: CONTRACT, label: "beezie", start_block: 5000 }

const padAddr = (addr: string) => "0x" + addr.replace(/^0x/, "").toLowerCase().padStart(64, "0")
const padNum = (n: number | bigint) => "0x" + BigInt(n).toString(16).padStart(64, "0")

function transferLog(over: Partial<Record<string, unknown>> = {}) {
  return {
    topics: [
      TRANSFER_TOPIC,
      padAddr("0x1111111111111111111111111111111111111111"),
      padAddr("0x2222222222222222222222222222222222222222"),
      padNum(12345),
    ],
    blockNumber: "0x4e2", // 1250
    logIndex: "0x2",
    transactionHash: "0xABCDEF00000000000000000000000000000000000000000000000000000000ff",
    blockTimestamp: "0x665f0000", // 2024-06-04T11:52:32.000Z
    ...over,
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(qs = "", opts: { auth?: string | null } = {}): NextRequest {
  const headers = new Headers()
  if (opts.auth !== null) headers.set("authorization", opts.auth ?? "Bearer evm-token")
  return new NextRequest(`https://t/api/cron/evm-transfers-ingest${qs}`, { method: "POST", headers })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) {
    let settled = false
    const p = Promise.resolve()
      .then(cb)
      .finally(() => {
        settled = true
      })
    let guard = 0
    while (!settled) {
      if (++guard > 500) throw new Error("runDeferred: work did not settle")
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(10_000)
      else await new Promise((r) => setTimeout(r, 0))
    }
    await p
  }
}

function ingestLogs(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls
    .filter((c) => c.name === "log_pipeline_run" && c.args?.p_pipeline === "evm-transfers-ingest")
    .map((c) => c.args!)
}

afterEach(() => {
  vi.useRealTimers()
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "evm-token"
  state.afterCbs.length = 0
  state.getLogsQueue = []
  state.getLogsCalls = []
  state.blocksByNumber = {}
  state.blockCalls = []
})

describe("evm-transfers-ingest — decode + cursor contract", () => {
  it("decodes Transfer topics into exact upsert rows, advances the cursor by the window, and logs the run", async () => {
    state.getLogsQueue = [
      {
        logs: [
          transferLog(),
          transferLog({
            topics: [
              TRANSFER_TOPIC,
              padAddr("0x3333333333333333333333333333333333333333"),
              padAddr("0x4444444444444444444444444444444444444444"),
              padNum(BigInt("99999999999999999999")), // > Number.MAX_SAFE_INTEGER
            ],
            blockNumber: "0x4e3",
            logIndex: "0x0",
          }),
        ],
      },
    ]
    const spy = install({
      evm_nft_contracts: { data: [BEEZIE], error: null },
      evm_indexer_cursors: [
        { data: { last_processed_block: 1000, total_transfers_indexed: 10 }, error: null },
        { data: null, error: null }, // cursor advance update
      ],
      evm_nft_transfers: { data: null, error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, message: "ingest queued" })
    await runDeferred()

    // getLogs was windowed from cursor+1 with the Transfer topic filter.
    expect(state.getLogsCalls).toHaveLength(1)
    expect(state.getLogsCalls[0]).toEqual({
      slug: "base_mainnet",
      filter: {
        fromBlock: "0x3e9", // 1001
        toBlock: "0x1770", // 6000
        address: CONTRACT,
        topics: [TRANSFER_TOPIC],
      },
    })

    const upserts = (spy.writes.evm_nft_transfers ?? []).flatMap((w) => w.rows)
    expect(upserts).toHaveLength(2)
    expect(upserts[0]).toEqual({
      chain_id: 8453,
      contract_address: CONTRACT.toLowerCase(),
      token_id: "12345",
      from_address: "0x1111111111111111111111111111111111111111",
      to_address: "0x2222222222222222222222222222222222222222",
      block_number: 1250,
      log_index: 2,
      transaction_hash: "0xabcdef00000000000000000000000000000000000000000000000000000000ff",
      block_timestamp: "2024-06-04T11:52:32.000Z",
    })
    // uint256 token ids survive as decimal strings (BigInt path, no precision loss).
    expect(upserts[1]).toMatchObject({ token_id: "99999999999999999999", block_number: 1251, log_index: 0 })

    // Cursor advanced to the full requested window with the running total.
    const advance = (spy.writes.evm_indexer_cursors ?? []).find((w) => w.method === "update")
    expect(advance?.rows[0]).toMatchObject({ last_processed_block: 6000, total_transfers_indexed: 12 })

    const logs = ingestLogs(spy.rpcCalls)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      p_ok: true,
      p_rows_found: 2,
      p_rows_written: 2,
      p_rows_skipped: 0,
      p_cursor_before: "1000",
      p_cursor_after: "6000",
      p_collection_slug: "beezie",
    })
    expect(logs[0].p_extra).toMatchObject({
      from_block: 1001,
      to_block: 6000,
      requested_to_block: 6000,
      logs_returned: 2,
      logs_attempts: 1,
    })
  })

  it("initializes a fresh cursor at start_block-1, skips non-standard logs, and resolves missing timestamps via RPC", async () => {
    state.getLogsQueue = [
      {
        logs: [
          // ERC-20 style (3 topics) — defensively skipped.
          transferLog({ topics: [TRANSFER_TOPIC, padAddr("0x1"), padNum(5)] }),
          // Missing blockTimestamp -> resolved via getBlockByNumber.
          transferLog({ blockNumber: "0xaa", blockTimestamp: undefined }),
          // Missing timestamp AND the block lookup returns null -> skipped (partition key NOT NULL).
          transferLog({ blockNumber: "0xbb", blockTimestamp: undefined }),
        ],
      },
    ]
    state.blocksByNumber = { "0xaa": { timestamp: "0x665f0000" }, "0xbb": null }
    const spy = install({
      evm_nft_contracts: { data: [BEEZIE], error: null },
      evm_indexer_cursors: [
        { data: null, error: null }, // no cursor yet
        { data: null, error: null }, // insert
        { data: null, error: null }, // advance
      ],
      evm_nft_transfers: { data: null, error: null },
    })

    await POST(req())
    await runDeferred()

    // Fresh cursor seeded so the first window begins at start_block.
    const init = (spy.writes.evm_indexer_cursors ?? []).find((w) => w.method === "insert")
    expect(init?.rows[0]).toEqual({
      chain_id: 8453,
      contract_address: CONTRACT,
      last_processed_block: 4999,
      total_transfers_indexed: 0,
    })
    expect(state.getLogsCalls[0].filter.fromBlock).toBe("0x" + (5000).toString(16))
    expect(new Set(state.blockCalls)).toEqual(new Set(["0xaa", "0xbb"]))

    const rows = (spy.writes.evm_nft_transfers ?? []).flatMap((w) => w.rows)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ block_number: 0xaa, block_timestamp: "2024-06-04T11:52:32.000Z" })

    const log = ingestLogs(spy.rpcCalls)[0]
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 3, p_rows_written: 1, p_rows_skipped: 2 })
    expect(log.p_extra).toMatchObject({
      cursor_initialized: true,
      skipped_non_standard: 1,
      skipped_no_timestamp: 1,
      blocks_resolved_via_rpc: 2,
    })
  })
})

describe("evm-transfers-ingest — rate-limit discipline", () => {
  it("halves the window on a 429 and advances the cursor only to the block that actually succeeded", async () => {
    vi.useFakeTimers()
    state.getLogsQueue = [{ throw: "HTTP 429 Too Many Requests" }, { logs: [] }]
    const spy = install({
      evm_nft_contracts: { data: [BEEZIE], error: null },
      evm_indexer_cursors: [
        { data: { last_processed_block: 1000, total_transfers_indexed: 0 }, error: null },
        { data: null, error: null },
      ],
    })

    await POST(req())
    await runDeferred()

    expect(state.getLogsCalls).toHaveLength(2)
    // 5000-block window halves: 1001 + (floor(5000*0.5) - 1) = 3500.
    expect(state.getLogsCalls[1].filter.toBlock).toBe("0x" + (3500).toString(16))

    const advance = (spy.writes.evm_indexer_cursors ?? []).find((w) => w.method === "update")
    expect(advance?.rows[0]).toMatchObject({ last_processed_block: 3500 })

    const log = ingestLogs(spy.rpcCalls)[0]
    expect(log).toMatchObject({ p_ok: true, p_cursor_after: "3500" })
    expect(log.p_extra).toMatchObject({
      logs_attempts: 2,
      rate_limited_attempts: 1,
      window_halved: true,
      to_block: 3500,
      requested_to_block: 6000,
    })
  })

  it("full 429 exhaustion is an ok=true DEFERRAL with the cursor untouched — never a fake failure", async () => {
    vi.useFakeTimers()
    state.getLogsQueue = Array.from({ length: 4 }, () => ({ throw: "HTTP 429 rate limit" }))
    const spy = install({
      evm_nft_contracts: { data: [BEEZIE], error: null },
      evm_indexer_cursors: { data: { last_processed_block: 1000, total_transfers_indexed: 0 }, error: null },
    })

    await POST(req())
    await runDeferred()

    expect(state.getLogsCalls).toHaveLength(4)
    // Nothing written, cursor never moved — next tick retries the same window.
    expect(spy.writes.evm_nft_transfers ?? []).toHaveLength(0)
    expect((spy.writes.evm_indexer_cursors ?? []).filter((w) => w.method === "update")).toHaveLength(0)

    const log = ingestLogs(spy.rpcCalls)[0]
    expect(log).toMatchObject({ p_ok: true, p_error: null, p_rows_written: 0, p_cursor_after: null })
    expect(log.p_extra).toMatchObject({ deferred_rate_limited: true })
    expect(String((log.p_extra as Record<string, unknown>).rate_limit_detail)).toContain("429")
  })

  it("a non-429 error hard-fails immediately without burning retries", async () => {
    state.getLogsQueue = [{ throw: "connection reset by peer" }]
    const spy = install({
      evm_nft_contracts: { data: [BEEZIE], error: null },
      evm_indexer_cursors: { data: { last_processed_block: 1000, total_transfers_indexed: 0 }, error: null },
    })

    await POST(req())
    await runDeferred()

    expect(state.getLogsCalls).toHaveLength(1)
    const log = ingestLogs(spy.rpcCalls)[0]
    expect(log).toMatchObject({ p_ok: false, p_error: "connection reset by peer", p_cursor_after: null })
  })
})

describe("evm-transfers-ingest — registry, budget, auth", () => {
  it("a slow first contract exhausts the budget and later contracts log skipped_budget_exhausted", async () => {
    vi.useFakeTimers()
    const second = { chain_id: 747, contract_address: "0xBEEF", label: "flowevm-thing", start_block: 1 }
    state.getLogsQueue = [{ logs: [], advanceClockMs: 30_000 }] // burns the 25s budget
    const spy = install({
      evm_nft_contracts: { data: [BEEZIE, second], error: null },
      evm_indexer_cursors: [
        { data: { last_processed_block: 1000, total_transfers_indexed: 0 }, error: null },
        { data: null, error: null },
      ],
    })

    await POST(req())
    await runDeferred()

    expect(state.getLogsCalls).toHaveLength(1) // second contract never fetched
    const logs = ingestLogs(spy.rpcCalls)
    expect(logs).toHaveLength(2)
    expect(logs[0]).toMatchObject({ p_ok: true, p_collection_slug: "beezie" })
    expect(logs[1]).toMatchObject({ p_ok: true, p_collection_slug: "flowevm-thing" })
    expect(logs[1].p_extra).toMatchObject({ message: "skipped_budget_exhausted", contract: "0xBEEF" })
  })

  it("registry failure, empty registry, and an unsupported chain id each log honestly", async () => {
    // (a) registry read error
    let spy = install({ evm_nft_contracts: { data: null, error: { message: "perm" } } })
    await POST(req())
    await runDeferred()
    expect(ingestLogs(spy.rpcCalls)[0]).toMatchObject({ p_ok: false, p_error: "registry_read_failed: perm" })

    // (b) empty registry
    spy = install({ evm_nft_contracts: { data: [], error: null } })
    await POST(req())
    await runDeferred()
    expect(ingestLogs(spy.rpcCalls)[0].p_extra).toMatchObject({ message: "no_active_contracts" })

    // (c) unsupported chain id
    spy = install({
      evm_nft_contracts: {
        data: [{ chain_id: 999, contract_address: "0x1", label: "mystery", start_block: 1 }],
        error: null,
      },
    })
    await POST(req())
    await runDeferred()
    expect(ingestLogs(spy.rpcCalls)[0]).toMatchObject({ p_ok: false, p_error: "unsupported_chain_id_999" })
  })

  it("500s when the secret is unset, 401s on a wrong token, accepts ?token=, and GET delegates", async () => {
    install({ evm_nft_contracts: { data: [], error: null } })
    delete process.env.INGEST_SECRET_TOKEN
    expect((await POST(req())).status).toBe(500)

    process.env.INGEST_SECRET_TOKEN = "evm-token"
    expect((await POST(req("", { auth: "Bearer wrong" }))).status).toBe(401)
    expect((await POST(req("?token=evm-token", { auth: null }))).status).toBe(200)
    expect((await GET(req("?token=evm-token", { auth: null }))).status).toBe(200)
    await runDeferred()
  })
})
