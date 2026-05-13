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
import { getLogs, type ChainSlug, type EvmLog } from "@/lib/evm-rpc";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PIPELINE = "evm-transfers-ingest";

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const BLOCKS_PER_WINDOW = 5000;
const BUDGET_MS = 25_000;
const UPSERT_CHUNK = 500;

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
    const toBlock = lastProcessed + BLOCKS_PER_WINDOW;

    // Fetch logs filtered to this contract + Transfer topic.
    const logs: EvmLog[] = await getLogs(chainSlug, {
      fromBlock: numberToHex(fromBlock),
      toBlock: numberToHex(toBlock),
      address: c.contract_address,
      topics: [TRANSFER_TOPIC],
    });
    rowsFound = logs.length;
    extra.from_block = fromBlock;
    extra.to_block = toBlock;
    extra.logs_returned = logs.length;

    // Decode + dedup in-memory before upserting.
    const inserts: Array<Record<string, unknown>> = [];
    let skippedNonStandard = 0;
    for (const log of logs) {
      // ERC-721 Transfer = 4 topics. ERC-20 emits 3; skip those defensively.
      if (!log.topics || log.topics.length < 4) {
        skippedNonStandard++;
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
        block_timestamp: null,
      });
    }
    if (skippedNonStandard > 0) extra.skipped_non_standard = skippedNonStandard;

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
