// supabase/functions/backfill-topshot-subeditions/index.ts
//
// Phase 1 Stage B (2026-06-20) — resolves each TopShot moment's on-chain
// SubEdition (parallel) id and records it in public.topshot_moment_subeditions.
// This is the foundation for splitting the ~741 conflated setID:playID editions
// into one row per parallel (catalog + remap happen DOWNSTREAM, strictly after
// this table is fully resolved — never a half-mapped state).
//
//   The subedition is NOT in MomentData (only setID/playID/serialNumber). It
//   lives in a separate SubeditionAdmin resource, read via the contract-level
//   view TopShot.getMomentsSubedition(nftID): UInt32?. nil/0 = Standard, >0 =
//   a named parallel (Jukebox 20, Hexwave 19, ... see getAllSubeditions).
//
//   Efficiency: getMomentsSubedition is a contract-level pure map lookup, so a
//   single Cadence script loops over an ARRAY of nft_ids and returns the whole
//   {nft_id: subeditionID} dictionary — hundreds of moments per call. ~247K
//   pending nfts drain in a handful of runs (vs the per-account borrow the
//   sibling AllDay serial backfill needs). Reads hit rest-mainnet.onflow.org
//   directly (proven reachable from Supabase edge functions).
//
// Each invocation:
//   1. get_topshot_subedition_targets(limit) -> text[] of pending nft_ids.
//   2. Resolve them in chunks via the batched getMomentsSubedition script
//      (bounded concurrency + retry). Any id absent from the returned dict =
//      Standard (0) — getMomentsSubedition returns nil for never-subedition'd
//      moments, which is normal, not an error.
//   3. Upsert {nft_id, subedition_id, resolved_at} (chunked) ON CONFLICT nft_id.
//   4. log_pipeline_run under pipeline "topshot-subedition-backfill".
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

const DEFAULT_BATCH_SIZE = 20_000;
const MAX_BATCH_SIZE = 50_000;
const CHUNK = 400;               // nft_ids per on-chain script call (pure map reads, cheap)
const CONCURRENCY = 8;
const SCRIPT_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 800;
const SOFT_BUDGET_MS = 130_000;  // stop dispatching with headroom for upsert + log
const UPSERT_CHUNK = 1000;

// Batched contract-level read — loops the array and returns {nftID: subeditionID}.
// subeditionID 0 is returned explicitly for some moments; nil (absent from the
// dict) for moments never added to a subedition — both mean Standard.
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

interface SubRow {
  nft_id: string;
  subedition_id: number;
  resolved_at: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
  const body = {
    script: btoa(SUBEDITION_SCRIPT),
    arguments: [btoa(JSON.stringify(arg))],
  };
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

// Resolve one chunk with bounded retry. On success EVERY id in the chunk is
// resolved (present in dict -> its value; absent -> Standard 0). Throws only on
// a total script/transport failure for the chunk (caller records + skips it).
async function resolveChunk(ids: string[], resolvedAt: string): Promise<SubRow[]> {
  let lastErr: string | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const dict = await runScript(ids);
      return ids.map((nft_id) => ({
        nft_id,
        subedition_id: dict[nft_id] ?? 0,
        resolved_at: resolvedAt,
      }));
    } catch (err) {
      lastErr = err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
      if (attempt < MAX_RETRIES) await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }
  throw new Error(lastErr ?? "chunk_failed");
}

interface Summary {
  batch_requested: number;
  targets_returned: number;
  rows_resolved: number;
  rows_upserted: number;
  subedition_nonzero: number;
  chunk_errors: number;
  first_chunk_error: string | null;
  budget_stopped: boolean;
  fatal: string | null;
}

async function logPipelineRun(args: {
  startedAt: string;
  rowsFound: number;
  rowsWritten: number;
  rowsSkipped: number;
  ok: boolean;
  error?: string | null;
  extra: Record<string, unknown>;
}): Promise<void> {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabase as any).rpc("log_pipeline_run", {
      p_pipeline: "topshot-subedition-backfill",
      p_started_at: args.startedAt,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error ?? null,
      p_collection_slug: "nba-top-shot",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: args.extra,
    });
  } catch (err) {
    console.log(`[ts-subedition] log_pipeline_run failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function run(batchSize: number, startedAt: string): Promise<Summary> {
  const t0 = Date.now();
  const summary: Summary = {
    batch_requested: batchSize,
    targets_returned: 0,
    rows_resolved: 0,
    rows_upserted: 0,
    subedition_nonzero: 0,
    chunk_errors: 0,
    first_chunk_error: null,
    budget_stopped: false,
    fatal: null,
  };

  const { data: targetsData, error: targetsErr } = await supabase.rpc(
    "get_topshot_subedition_targets",
    { p_limit: batchSize },
  );
  if (targetsErr) {
    summary.fatal = `get_topshot_subedition_targets:${targetsErr.message.slice(0, 200)}`;
    await logPipelineRun({
      startedAt, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false, error: summary.fatal, extra: summary as unknown as Record<string, unknown>,
    });
    return summary;
  }

  const targets = ((targetsData ?? []) as string[]).filter(Boolean);
  summary.targets_returned = targets.length;
  if (targets.length === 0) {
    await logPipelineRun({
      startedAt, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: true, error: null, extra: summary as unknown as Record<string, unknown>,
    });
    return summary;
  }

  // Build the list of chunks, then resolve with a bounded-concurrency pool.
  const chunks: string[][] = [];
  for (let i = 0; i < targets.length; i += CHUNK) chunks.push(targets.slice(i, i + CHUNK));
  const resolvedAt = new Date().toISOString();
  const allRows: SubRow[] = [];

  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      if (Date.now() - t0 > SOFT_BUDGET_MS) { summary.budget_stopped = true; return; }
      const idx = cursor++;
      if (idx >= chunks.length) return;
      try {
        const rows = await resolveChunk(chunks[idx], resolvedAt);
        for (const r of rows) allRows.push(r);
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

  summary.rows_resolved = allRows.length;
  summary.subedition_nonzero = allRows.filter((r) => r.subedition_id > 0).length;

  // Chunked apply via UPDATE-only RPC. (A PostgREST upsert would attempt an
  // INSERT with a null base_external_id and trip its NOT NULL constraint — all
  // rows are pre-seeded, so we only ever UPDATE.)
  for (let i = 0; i < allRows.length; i += UPSERT_CHUNK) {
    const slice = allRows.slice(i, i + UPSERT_CHUNK);
    const { data: applied, error: upErr } = await supabase.rpc("apply_topshot_subeditions", {
      p_nft_ids: slice.map((r) => r.nft_id),
      p_sub_ids: slice.map((r) => r.subedition_id),
    });
    if (upErr) {
      summary.fatal = `apply:${upErr.message.slice(0, 200)}`;
      await logPipelineRun({
        startedAt, rowsFound: targets.length, rowsWritten: summary.rows_upserted,
        rowsSkipped: targets.length - summary.rows_upserted,
        ok: false, error: summary.fatal, extra: summary as unknown as Record<string, unknown>,
      });
      return summary;
    }
    summary.rows_upserted += typeof applied === "number" ? applied : slice.length;
  }

  await logPipelineRun({
    startedAt,
    rowsFound: targets.length,
    rowsWritten: summary.rows_upserted,
    rowsSkipped: Math.max(0, targets.length - summary.rows_resolved),
    // Only a wholesale failure (every chunk errored, nothing resolved) is a real fail.
    ok: summary.rows_resolved > 0 || summary.chunk_errors === 0,
    error: summary.first_chunk_error,
    extra: summary as unknown as Record<string, unknown>,
  });

  console.log(
    `[ts-subedition] targets=${summary.targets_returned} resolved=${summary.rows_resolved} nonzero=${summary.subedition_nonzero} upserted=${summary.rows_upserted} chunk_errors=${summary.chunk_errors} budget_stopped=${summary.budget_stopped}`,
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
      console.log(`[ts-subedition] fatal: ${msg.slice(0, 300)}`);
      await logPipelineRun({
        startedAt, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: false, error: msg.slice(0, 500),
        extra: { batch_size: batchSize, fatal: msg.slice(0, 500) },
      });
    }
  })();

  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er && typeof er.waitUntil === "function") er.waitUntil(work);
  else await work;

  return new Response(
    JSON.stringify({
      status: "accepted",
      batch_size: batchSize,
      started_at: startedAt,
      note: "Results appear in pipeline_runs as pipeline=topshot-subedition-backfill within ~30s.",
    }),
    { status: 202, headers: { "Content-Type": "application/json" } },
  );
});
