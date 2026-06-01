// app/api/cron/evm-transfers-ingest/route.ts
//
// Generic ERC-721 Transfer event indexer. Reads the evm_nft_contracts
// registry, walks each active contract forward from its evm_indexer_cursors
// entry by up to BLOCKS_PER_WINDOW blocks, decodes Transfer event topics,
// upserts into evm_nft_transfers, and advances the cursor.
//
// Beezie Collectibles on Base is the first registered target. New contracts
// require only an INSERT into evm_nft_contracts.
//
// Auth: Bearer INGEST_SECRET_TOKEN (also accepts ?token=). GET/POST.
// Fire-and-forget via after() so cron-job.org's 30s HTTP cap can't kill the
// ingest mid-write; internal work is still bounded to BUDGET_MS so a slow
// contract can't starve later contracts in the same tick.

import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import {
  getLogs,
  getBlockByNumber,
  type ChainSlug,
  type EvmLog,
} from "@/lib/evm-rpc";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PIPELINE = "evm-transfers-ingest";

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// 5k baseline (lowered from 10k on 2026-05-31, Q6). A 10k-block getLogs was
// the burst that tripped base_mainnet's rate limit in the first place; 5k
// still vastly outpaces Base's ~1800 blocks/hr so the forward cursor never
// lags, and the common-case tick now stays under the 429 threshold without
// needing a retry. Backfill is marginally slower but still makes progress.
const BLOCKS_PER_WINDOW = 5000;
const BUDGET_MS = 25_000;
const UPSERT_CHUNK = 500;

// Rate-limit recovery: on HTTP 429 from the proxy, the contract's
// getLogs window is retried with exponential backoff and a halved
// window. With a 5k baseline the halving walks 5k→2.5k→1.25k→0.625k over
// four attempts, so even a heavy Beezie activity burst can shrink under the
// threshold before the helper gives up (the 3-attempt ceiling occasionally
// still threw ok=false on sustained bursts — Q6).
const LOGS_RETRY_MAX_ATTEMPTS = 4;
const LOGS_RETRY_BASE_MS = 2000;
const LOGS_RETRY_JITTER_MS = 500;
const RETRY_WINDOW_FACTOR = 0.5;

function isRateLimitErr(msg: string): boolean {
  return msg.includes("429") || /rate.?limit/i.test(msg);
}

async function fetchLogsWithRateLimitBackoff(
  chainSlug: ChainSlug,
  fromBlock: number,
  initialToBlock: number,
  contractAddress: string
): Promise<{
  logs: EvmLog[];
  effectiveToBlock: number;
  attempts: number;
  rate_limited_attempts: number;
}> {
  let toBlock = initialToBlock;
  let attempts = 0;
  let rateLimited = 0;
  let lastErr: unknown;
  for (let attempt = 0; attempt < LOGS_RETRY_MAX_ATTEMPTS; attempt++) {
    attempts++;
    try {
      const logs = await getLogs(chainSlug, {
        fromBlock: numberToHex(fromBlock),
        toBlock: numberToHex(toBlock),
        address: contractAddress,
        topics: [TRANSFER_TOPIC],
      });
      return { logs, effectiveToBlock: toBlock, attempts, rate_limited_attempts: rateLimited };
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!isRateLimitErr(msg)) throw err;
      rateLimited++;
      // Halve the window from this attempt forward so the next try is
      // less likely to re-hit the limit. Round down, but keep ≥1 block.
      toBlock = Math.max(
        fromBlock,
        fromBlock + Math.max(1, Math.floor((toBlock - fromBlock + 1) * RETRY_WINDOW_FACTOR) - 1)
      );
      if (attempt < LOGS_RETRY_MAX_ATTEMPTS - 1) {
        const delay =
          LOGS_RETRY_BASE_MS * Math.pow(2, attempt) +
          Math.floor(Math.random() * LOGS_RETRY_JITTER_MS);
        console.log(
          `[${PIPELINE}] getLogs 429 attempt=${attempt + 1} sleeping=${delay}ms next_window=${fromBlock}..${toBlock}`
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`getLogs exhausted ${LOGS_RETRY_MAX_ATTEMPTS} attempts: ${String(lastErr)}`);
}

const CHAIN_SLUG_BY_ID: Record<number, ChainSlug> = {
  747: "flow_evm_mainnet",
  8453: "base_mainnet",
};

interface ContractRow {
  chain_id: number;
  contract_address: string;
  label: string;
  start_block: number;
}

interface CursorRow {
  chain_id: number;
  contract_address: string;
  last_processed_block: number;
  total_transfers_indexed: number;
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function topicToAddress(topic: string): string {
  // 32-byte topic, address is the last 20 bytes (40 hex chars).
  return ("0x" + topic.slice(-40)).toLowerCase();
}

function topicToTokenId(topic: string): string {
  // uint256 in a 32-byte topic. BigInt(hex) → decimal string.
  return BigInt(topic).toString();
}

function hexToNumber(hex: string): number {
  return Number.parseInt(hex, 16);
}

function numberToHex(n: number): string {
  return "0x" + n.toString(16);
}

function blockTimestampHexToIso(hex: string): string {
  return new Date(Number.parseInt(hex, 16) * 1000).toISOString();
}

async function runIngest(startedAtIso: string, startedMs: number): Promise<void> {
  // Pull active registry once.
  const { data: contracts, error: contractsErr } = await (supabaseAdmin as any)
    .from("evm_nft_contracts")
    .select("chain_id, contract_address, label, start_block")
    .eq("is_active", true)
    .order("id", { ascending: true });

  if (contractsErr) {
    await logRun({
      startedAtIso,
      ok: false,
      error: `registry_read_failed: ${contractsErr.message}`,
      collection_slug: null,
      rows_found: 0,
      rows_written: 0,
      cursor_before: null,
      cursor_after: null,
      extra: { elapsed_ms: Date.now() - startedMs },
    });
    return;
  }

  const rows = (contracts ?? []) as ContractRow[];
  if (rows.length === 0) {
    await logRun({
      startedAtIso,
      ok: true,
      error: null,
      collection_slug: null,
      rows_found: 0,
      rows_written: 0,
      cursor_before: null,
      cursor_after: null,
      extra: { message: "no_active_contracts", elapsed_ms: Date.now() - startedMs },
    });
    return;
  }

  for (const c of rows) {
    const remainingMs = BUDGET_MS - (Date.now() - startedMs);
    if (remainingMs <= 1000) {
      await logRun({
        startedAtIso,
        ok: true,
        error: null,
        collection_slug: c.label,
        rows_found: 0,
        rows_written: 0,
        cursor_before: null,
        cursor_after: null,
        extra: {
          message: "skipped_budget_exhausted",
          contract: c.contract_address,
          chain_id: c.chain_id,
          elapsed_ms: Date.now() - startedMs,
        },
      });
      continue;
    }

    await runContract(c, startedAtIso, startedMs);
  }
}

async function runContract(
  c: ContractRow,
  startedAtIso: string,
  startedMs: number
): Promise<void> {
  const chainSlug = CHAIN_SLUG_BY_ID[c.chain_id];
  const extra: Record<string, unknown> = {
    contract: c.contract_address,
    chain_id: c.chain_id,
  };
  let ok = true;
  let errorMsg: string | null = null;
  let rowsFound = 0;
  let rowsWritten = 0;
  let cursorBefore: string | null = null;
  let cursorAfter: string | null = null;

  try {
    if (!chainSlug) {
      throw new Error(`unsupported_chain_id_${c.chain_id}`);
    }

    // Load or initialize the cursor.
    const { data: cursorData, error: cursorErr } = await (supabaseAdmin as any)
      .from("evm_indexer_cursors")
      .select("last_processed_block, total_transfers_indexed")
      .eq("chain_id", c.chain_id)
      .eq("contract_address", c.contract_address)
      .maybeSingle();

    if (cursorErr) throw new Error(`cursor_read_failed: ${cursorErr.message}`);

    let lastProcessed: number;
    let totalIndexed: number;
    if (!cursorData) {
      // last_processed_block = start_block - 1 so the first window begins
      // at start_block (fromBlock = lastProcessed + 1).
      lastProcessed = c.start_block - 1;
      totalIndexed = 0;
      const { error: insertErr } = await (supabaseAdmin as any)
        .from("evm_indexer_cursors")
        .insert({
          chain_id: c.chain_id,
          contract_address: c.contract_address,
          last_processed_block: lastProcessed,
          total_transfers_indexed: 0,
        });
      if (insertErr) throw new Error(`cursor_insert_failed: ${insertErr.message}`);
      extra.cursor_initialized = true;
    } else {
      lastProcessed = Number((cursorData as CursorRow).last_processed_block ?? 0);
      totalIndexed = Number((cursorData as CursorRow).total_transfers_indexed ?? 0);
    }
    cursorBefore = String(lastProcessed);

    const fromBlock = lastProcessed + 1;
    const requestedToBlock = lastProcessed + BLOCKS_PER_WINDOW;

    // Fetch logs filtered to this contract + Transfer topic. On a 429,
    // the helper halves the window and retries with backoff; we advance
    // the cursor to whatever to-block actually succeeded.
    const logsRes = await fetchLogsWithRateLimitBackoff(
      chainSlug,
      fromBlock,
      requestedToBlock,
      c.contract_address
    );
    const logs: EvmLog[] = logsRes.logs;
    const toBlock = logsRes.effectiveToBlock;
    rowsFound = logs.length;
    extra.from_block = fromBlock;
    extra.to_block = toBlock;
    extra.requested_to_block = requestedToBlock;
    extra.logs_returned = logs.length;
    extra.logs_attempts = logsRes.attempts;
    if (logsRes.rate_limited_attempts > 0) {
      extra.rate_limited_attempts = logsRes.rate_limited_attempts;
      extra.window_halved = toBlock < requestedToBlock;
    }

    // Resolve block_timestamp per log. block_timestamp is a partition key
    // column on evm_nft_transfers and rejects NULL. Base RPC includes
    // `blockTimestamp` (hex unix seconds) on each log; for providers that
    // don't, fall back to eth_getBlockByNumber batched over unique block
    // numbers so we don't make one round-trip per log.
    const tsByBlock = new Map<string, string>(); // blockNumber hex -> ISO
    const missingBlocks = new Set<string>();
    for (const log of logs) {
      if (log.blockTimestamp) {
        if (!tsByBlock.has(log.blockNumber)) {
          tsByBlock.set(log.blockNumber, blockTimestampHexToIso(log.blockTimestamp));
        }
      } else {
        missingBlocks.add(log.blockNumber);
      }
    }
    if (missingBlocks.size > 0) {
      const fetched = await Promise.all(
        Array.from(missingBlocks).map(async (bn) => {
          const block = await getBlockByNumber(chainSlug, bn);
          return [bn, block?.timestamp ?? null] as const;
        })
      );
      for (const [bn, tsHex] of fetched) {
        if (tsHex) tsByBlock.set(bn, blockTimestampHexToIso(tsHex));
      }
      extra.blocks_resolved_via_rpc = missingBlocks.size;
    }

    // Decode + dedup in-memory before upserting.
    const inserts: Array<Record<string, unknown>> = [];
    let skippedNonStandard = 0;
    let skippedNoTimestamp = 0;
    for (const log of logs) {
      // ERC-721 Transfer = 4 topics. ERC-20 emits 3; skip those defensively.
      if (!log.topics || log.topics.length < 4) {
        skippedNonStandard++;
        continue;
      }
      const blockTs = tsByBlock.get(log.blockNumber);
      if (!blockTs) {
        // Partition key column is NOT NULL — skip rather than fail the batch.
        skippedNoTimestamp++;
        continue;
      }
      inserts.push({
        chain_id: c.chain_id,
        contract_address: c.contract_address.toLowerCase(),
        token_id: topicToTokenId(log.topics[3]),
        from_address: topicToAddress(log.topics[1]),
        to_address: topicToAddress(log.topics[2]),
        block_number: hexToNumber(log.blockNumber),
        log_index: hexToNumber(log.logIndex),
        transaction_hash: log.transactionHash.toLowerCase(),
        block_timestamp: blockTs,
      });
    }
    if (skippedNonStandard > 0) extra.skipped_non_standard = skippedNonStandard;
    if (skippedNoTimestamp > 0) extra.skipped_no_timestamp = skippedNoTimestamp;

    for (let i = 0; i < inserts.length; i += UPSERT_CHUNK) {
      const batch = inserts.slice(i, i + UPSERT_CHUNK);
      const { error: upsertErr } = await (supabaseAdmin as any)
        .from("evm_nft_transfers")
        .upsert(batch, {
          onConflict:
            "chain_id,contract_address,token_id,block_number,log_index,block_timestamp",
          ignoreDuplicates: true,
        });
      if (upsertErr) {
        throw new Error(`upsert_failed: ${upsertErr.message}`);
      }
      rowsWritten += batch.length;
    }

    // Advance the cursor to toBlock once all writes succeed. We advance
    // even on empty ranges so the walk makes forward progress.
    const { error: advanceErr } = await (supabaseAdmin as any)
      .from("evm_indexer_cursors")
      .update({
        last_processed_block: toBlock,
        last_advanced_at: new Date().toISOString(),
        total_transfers_indexed: totalIndexed + rowsWritten,
      })
      .eq("chain_id", c.chain_id)
      .eq("contract_address", c.contract_address);
    if (advanceErr) throw new Error(`cursor_advance_failed: ${advanceErr.message}`);
    cursorAfter = String(toBlock);
  } catch (err) {
    ok = false;
    errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[${PIPELINE}] ${c.label} fatal: ${errorMsg}`);
  } finally {
    extra.elapsed_ms = Date.now() - startedMs;
    await logRun({
      startedAtIso,
      ok,
      error: errorMsg,
      collection_slug: c.label,
      rows_found: rowsFound,
      rows_written: rowsWritten,
      cursor_before: cursorBefore,
      cursor_after: cursorAfter,
      extra,
    });
  }
}

async function logRun(args: {
  startedAtIso: string;
  ok: boolean;
  error: string | null;
  collection_slug: string | null;
  rows_found: number;
  rows_written: number;
  cursor_before: string | null;
  cursor_after: string | null;
  extra: Record<string, unknown>;
}) {
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE,
      p_started_at: args.startedAtIso,
      p_rows_found: args.rows_found,
      p_rows_written: args.rows_written,
      p_rows_skipped: args.rows_found - args.rows_written,
      p_ok: args.ok,
      p_error: args.error,
      p_collection_slug: args.collection_slug,
      p_cursor_before: args.cursor_before,
      p_cursor_after: args.cursor_after,
      p_extra: Object.keys(args.extra).length > 0 ? args.extra : null,
    });
  } catch (logErr) {
    console.log(
      `[${PIPELINE}] log_pipeline_run err: ${logErr instanceof Error ? logErr.message : String(logErr)}`
    );
  }
}

function authorized(req: NextRequest): boolean {
  const expected = process.env.INGEST_SECRET_TOKEN;
  if (!expected) return false;
  const bearer = req.headers.get("authorization");
  if (bearer && bearer.startsWith("Bearer ") && bearer.slice(7) === expected) {
    return true;
  }
  const qp = req.nextUrl.searchParams.get("token");
  return qp === expected;
}

export async function POST(req: NextRequest) {
  if (!process.env.INGEST_SECRET_TOKEN) {
    return NextResponse.json(
      { error: "INGEST_SECRET_TOKEN not set" },
      { status: 500 }
    );
  }
  if (!authorized(req)) return unauthorized();

  const startedAtIso = new Date().toISOString();
  const startedMs = Date.now();

  after(async () => {
    try {
      await runIngest(startedAtIso, startedMs);
    } catch (err) {
      console.log(
        `[${PIPELINE}] top-level fatal: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });

  return NextResponse.json({ ok: true, message: "ingest queued", started_at: startedAtIso });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
