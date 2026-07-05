// supabase/functions/backfill-topshot-base-parallel-probe/index.ts
//
// Population B subedition sweep (2026-07-05) — resolves the on-chain subedition of
// TopShot base-resident HELD moments (wallet_moments_cache rows on a setID:playID
// base whose play has ::N siblings) that were NEVER a subedition-resolution target,
// so they never entered topshot_moment_subeditions and never got re-keyed. The
// "Jrue class" from the 07-04/05 subedition audit (~134k nfts).
//
//   Candidates were materialized ONCE into public.topshot_base_parallel_probe_queue
//   (dense bigint `seq` PK) because the live candidate scan is a ~88s full wmc scan;
//   this fn drains that queue by an indexed seq cursor (~80ms/batch). The cursor is
//   event_cursor(id='backfill-topshot-base-parallel-probe').last_processed_block =
//   the highest seq fully processed. Each tick pulls seq > cursor (ORDER BY seq,
//   LIMIT batch_size) via get_topshot_base_parallel_probe_targets (returns JSONB so
//   it is not clamped by PostgREST's 1000-row cap).
//
//   For each nft_id it calls TopShot.getMomentsSubedition(nftID) on Flow mainnet
//   (a contract-level pure map lookup — one Cadence script loops an ARRAY and
//   returns {nftID: subeditionID}; absent/nil = 0 = Standard). Confirmed parallels
//   (subedition_id > 0) are inserted into topshot_moment_subeditions ON CONFLICT
//   (nft_id) DO NOTHING (base_external_id from the queue satisfies its NOT NULL).
//   Standard moments (0) are never written; the cursor still advances past them.
//
//   Downstream: the existing daily drain-conflated-subeditions orchestrator
//   catalogs the ::N editions and re-keys (split/realign) the newly-mapped moments
//   off base on its next run — no new re-key logic here.
//
//   Self-terminating: when the queue is exhausted the fn logs done=true and stops
//   advancing the cursor (terminal state). A pipeline_alert_suppression row silences
//   the resulting cursor_stalled, exactly like allday_pack_opens_backfill.
//
// Auth: INGEST_SECRET_TOKEN bearer (or ?token=). EdgeRuntime.waitUntil drains.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const INGEST_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN");
if (!INGEST_TOKEN) throw new Error("INGEST_SECRET_TOKEN is required");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const FLOW_REST = Deno.env.get("FLOW_REST_URL") ?? "https://rest-mainnet.onflow.org";

const CURSOR_KEY = "backfill-topshot-base-parallel-probe";
const PIPELINE = "topshot-base-parallel-probe";
const COLLECTION_SLUG = "nba-top-shot";

const DEFAULT_BATCH_SIZE = 20_000; // queue rows pulled per tick (drains ~134k in ~7 ticks)
const MAX_BATCH_SIZE = 40_000;
const CHUNK = 500;                 // nft_ids per on-chain script call (pure map reads, cheap)
const CONCURRENCY = 8;
const SCRIPT_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 800;
const SOFT_BUDGET_MS = 130_000;    // stop dispatching with headroom for upsert + log
const UPSERT_CHUNK = 1000;

// Batched contract-level read — loops the array, returns {nftID: subeditionID}.
// subeditionID 0 explicit for some; nil (absent) for never-subedition'd moments —
// both mean Standard.
const SUBEDITION_SCRIPT = `
import TopShot from 0x0b2a3299cc857e29
access(all) fun main(ids: [UInt64]): {UInt64: UInt32} {
  let out: {UInt64: UInt32} = {}
  for id in ids {
    let sub = TopShot.getMomentsSubedition(nftID: id)
    if sub != nil { out[id] = sub! }
  }
  return out
}
`;

interface Target { seq: number; nft_id: string; base_external_id: string; }
interface MapRow { nft_id: string; base_external_id: string; subedition_id: number; resolved_at: string; }

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

// Cadence/JSON unwrapper for a {UInt64: UInt32} Dictionary response.
function decodeDict(node: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!node || typeof node !== "object") return out;
  const d = node as { type?: string; value?: Array<{ key: { value: string }; value: { value: string } }> };
  if (d.type !== "Dictionary" || !Array.isArray(d.value)) return out;
  for (const kv of d.value) {
    const k = String(kv.key?.value ?? "");
    const v = Number(kv.value?.value ?? NaN);
    if (k && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

async function runScript(ids: string[]): Promise<Record<string, number>> {
  const arg = { type: "Array", value: ids.map((v) => ({ type: "UInt64", value: v })) };
  const body = { script: btoa(SUBEDITION_SCRIPT), arguments: [btoa(JSON.stringify(arg))] };
  const res = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SCRIPT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`script HTTP ${res.status}`);
  const json = (await res.json()) as { value?: string } | string;
  const rawValue = typeof json === "string" ? json : String(json.value ?? "");
  if (!rawValue) return {};
  return decodeDict(JSON.parse(atob(rawValue)));
}

// Resolve one chunk with bounded retry. Returns {nftID: subeditionID} (absent = 0).
async function resolveChunk(ids: string[]): Promise<Record<string, number>> {
  let lastErr: string | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await runScript(ids);
    } catch (err) {
      lastErr = err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
      if (attempt < MAX_RETRIES) await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }
  throw new Error(lastErr ?? "chunk_failed");
}

interface Summary {
  batch_requested: number;
  cursor_before: number;
  cursor_after: number;
  targets_returned: number;
  ids_resolved: number;
  parallels_found: number;
  inserted: number;
  chunk_errors: number;
  first_chunk_error: string | null;
  budget_stopped: boolean;
  done: boolean;
  fatal: string | null;
}

async function logPipelineRun(args: {
  startedAt: string; rowsFound: number; rowsWritten: number; rowsSkipped: number;
  ok: boolean; error?: string | null; cursorBefore: number; cursorAfter: number;
  extra: Record<string, unknown>;
}): Promise<void> {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabase as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE,
      p_started_at: args.startedAt,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error ?? null,
      p_collection_slug: COLLECTION_SLUG,
      p_cursor_before: String(args.cursorBefore),
      p_cursor_after: String(args.cursorAfter),
      p_extra: args.extra,
    });
  } catch (err) {
    console.log(`[ts-base-parallel-probe] log_pipeline_run failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function readCursor(): Promise<number> {
  const { data } = await supabase.from("event_cursor")
    .select("last_processed_block").eq("id", CURSOR_KEY).maybeSingle();
  const v = (data as { last_processed_block?: number | string } | null)?.last_processed_block;
  return v ? Number(v) : 0;
}

async function writeCursor(value: number): Promise<void> {
  await supabase.from("event_cursor").upsert(
    { id: CURSOR_KEY, last_processed_block: value, updated_at: new Date().toISOString() },
    { onConflict: "id" },
  );
}

async function run(batchSize: number, startedAt: string): Promise<Summary> {
  const t0 = Date.now();
  const cursorBefore = await readCursor();
  const summary: Summary = {
    batch_requested: batchSize, cursor_before: cursorBefore, cursor_after: cursorBefore,
    targets_returned: 0, ids_resolved: 0, parallels_found: 0, inserted: 0,
    chunk_errors: 0, first_chunk_error: null, budget_stopped: false, done: false, fatal: null,
  };

  const { data: targetsData, error: targetsErr } = await supabase.rpc(
    "get_topshot_base_parallel_probe_targets", { p_after: cursorBefore, p_limit: batchSize },
  );
  if (targetsErr) {
    summary.fatal = `get_topshot_base_parallel_probe_targets:${targetsErr.message.slice(0, 200)}`;
    await logPipelineRun({ startedAt, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0, ok: false,
      error: summary.fatal, cursorBefore, cursorAfter: cursorBefore,
      extra: summary as unknown as Record<string, unknown> });
    return summary;
  }

  const targets = ((targetsData ?? []) as Target[]).filter((t) => t?.nft_id);
  summary.targets_returned = targets.length;
  summary.done = targets.length < batchSize; // fewer than requested => end of queue

  if (targets.length === 0) {
    // Terminal no-op. Leave the cursor frozen (see the cursor_stalled suppression row).
    await logPipelineRun({ startedAt, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0, ok: true,
      error: null, cursorBefore, cursorAfter: cursorBefore,
      extra: { ...summary, note: "queue exhausted — Population B backfill complete" } as unknown as Record<string, unknown> });
    return summary;
  }

  // Chunk in seq order (targets are seq-ordered). Track per-chunk success so the
  // cursor only advances over the contiguous successfully-resolved prefix — a
  // chunk error never skips a candidate (it is re-pulled next tick).
  const chunks: Target[][] = [];
  for (let i = 0; i < targets.length; i += CHUNK) chunks.push(targets.slice(i, i + CHUNK));
  const chunkOk: boolean[] = new Array(chunks.length).fill(false);
  const resolvedAt = new Date().toISOString();
  const dict: Record<string, number> = {};

  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      if (Date.now() - t0 > SOFT_BUDGET_MS) { summary.budget_stopped = true; return; }
      const idx = cursor++;
      if (idx >= chunks.length) return;
      const chunk = chunks[idx];
      try {
        const d = await resolveChunk(chunk.map((t) => t.nft_id));
        for (const t of chunk) dict[t.nft_id] = d[t.nft_id] ?? 0;
        chunkOk[idx] = true;
      } catch (err) {
        summary.chunk_errors++;
        if (!summary.first_chunk_error) {
          summary.first_chunk_error = err instanceof Error ? err.message.slice(0, 160) : String(err);
        }
      }
    }
  }
  const pool = Math.max(1, Math.min(CONCURRENCY, chunks.length));
  await Promise.all(Array.from({ length: pool }, () => worker()));

  summary.ids_resolved = Object.keys(dict).length;

  // Confirmed parallels (subedition_id > 0) -> map. Standard (0) never written.
  // Safe to insert every resolved parallel (idempotent) even from chunks past a
  // failed one — the cursor won't advance past the failure, so they re-run as a
  // no-op ON CONFLICT next tick.
  const rows: MapRow[] = [];
  for (const t of targets) {
    const sub = dict[t.nft_id];
    if (sub && sub > 0) {
      rows.push({ nft_id: t.nft_id, base_external_id: t.base_external_id, subedition_id: sub, resolved_at: resolvedAt });
    }
  }
  summary.parallels_found = rows.length;

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const slice = rows.slice(i, i + UPSERT_CHUNK);
    const { error: upErr } = await supabase.from("topshot_moment_subeditions")
      .upsert(slice, { onConflict: "nft_id", ignoreDuplicates: true });
    if (upErr) {
      summary.fatal = `upsert:${upErr.message.slice(0, 200)}`;
      await logPipelineRun({ startedAt, rowsFound: targets.length, rowsWritten: summary.inserted,
        rowsSkipped: 0, ok: false, error: summary.fatal, cursorBefore, cursorAfter: cursorBefore,
        extra: summary as unknown as Record<string, unknown> });
      return summary; // do NOT advance the cursor on a write failure
    }
    summary.inserted += slice.length;
  }

  // Advance the cursor to the max seq of the contiguous successful chunk prefix.
  const firstFail = chunkOk.findIndex((ok) => !ok);
  let cursorAfter: number;
  if (firstFail === -1) {
    // every chunk resolved -> jump to the batch's max seq
    cursorAfter = targets[targets.length - 1].seq;
  } else if (firstFail === 0) {
    cursorAfter = cursorBefore; // first chunk failed -> no advance, retry next tick
  } else {
    const lastGoodChunk = chunks[firstFail - 1];
    cursorAfter = lastGoodChunk[lastGoodChunk.length - 1].seq;
  }
  summary.cursor_after = cursorAfter;
  if (cursorAfter > cursorBefore) await writeCursor(cursorAfter);

  await logPipelineRun({
    startedAt, rowsFound: targets.length, rowsWritten: summary.inserted,
    rowsSkipped: Math.max(0, targets.length - summary.ids_resolved),
    ok: summary.chunk_errors === 0 || summary.ids_resolved > 0,
    error: summary.first_chunk_error, cursorBefore, cursorAfter,
    extra: {
      inserted: summary.inserted,
      done: summary.done && summary.chunk_errors === 0,
      cursor: cursorAfter,
      ...summary,
    } as unknown as Record<string, unknown>,
  });

  console.log(
    `[ts-base-parallel-probe] targets=${summary.targets_returned} resolved=${summary.ids_resolved} parallels=${summary.parallels_found} inserted=${summary.inserted} chunk_errors=${summary.chunk_errors} cursor ${cursorBefore}->${cursorAfter} done=${summary.done} budget_stopped=${summary.budget_stopped}`,
  );
  return summary;
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const auth = req.headers.get("Authorization") ?? "";
  const tokenParam = url.searchParams.get("token") ?? "";
  if (!auth.includes(INGEST_TOKEN!) && tokenParam !== INGEST_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  let body: { batch_size?: number } = {};
  if (req.method === "POST") {
    try { body = await req.json(); } catch { /* empty body is fine */ }
  }
  const batchSize = clampInt(body.batch_size ?? DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE);
  const startedAt = new Date().toISOString();

  const work = (async () => {
    try { await run(batchSize, startedAt); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[ts-base-parallel-probe] fatal: ${msg.slice(0, 300)}`);
      await logPipelineRun({ startedAt, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0, ok: false,
        error: msg.slice(0, 500), cursorBefore: 0, cursorAfter: 0,
        extra: { batch_size: batchSize, fatal: msg.slice(0, 500) } });
    }
  })();

  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er && typeof er.waitUntil === "function") er.waitUntil(work);
  else await work;

  return new Response(
    JSON.stringify({
      status: "accepted", batch_size: batchSize, started_at: startedAt,
      note: "Results appear in pipeline_runs as pipeline=topshot-base-parallel-probe within ~30s.",
    }),
    { status: 202, headers: { "Content-Type": "application/json" } },
  );
});
