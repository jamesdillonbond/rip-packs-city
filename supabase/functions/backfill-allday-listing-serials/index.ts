// supabase/functions/backfill-allday-listing-serials/index.ts
//
// Item 2 of handoff-2026-06-18-allday-deal-link-serial.md — populates
// public.allday_moment_serials with the serial number of each AllDay
// floor-listing moment, so cross_collection_deals_board's AllDay leg can carry
// low_ask_serial (and the deal-alert formatter renders "#<serial>").
//
// The serial is NOT in any existing table — `moments` is Top-Shot-only, and
// wmc/sales are null for these listed-but-untracked moments. It only lives in
// AllDay's consumer GraphQL, reachable solely from inside Supabase (the
// X-Proxy-Secret lives in Supabase env):
//
//   topshot-proxy worker /allday-consumer  ->  nflallday.com/consumer/graphql
//   searchMomentNFTsV2(input:{ first:40, filters:{ byFlowIDs:[Int]! } })
//     -> edges{ node{ flowID editionFlowID serialNumber } }
//
// This is the exact query the deployed allday-unmapped-resolver already uses;
// serialNumber on this node is confirmed (the resolver parses it). The
// consumer endpoint hard-caps results at 40 edges/page regardless of `first:`,
// so byFlowIDs is chunked at 40 (documented gotcha; it bit the resolver).
//
// Each invocation:
//   1. get_allday_listing_serial_targets(limit, board_only, stale_hours) ->
//      distinct floor nft_ids missing/stale in allday_moment_serials.
//   2. Batched searchMomentNFTsV2(byFlowIDs) of 40 ids each, sequential with a
//      small inter-chunk delay + one 429/5xx backoff retry (shared topshot
//      proxy — be a good citizen).
//   3. Upsert (nft_id, serial_number, edition_flow_id, fetched_at=now()) into
//      allday_moment_serials ON CONFLICT (nft_id) DO UPDATE.
//   4. log_pipeline_run under pipeline "allday-listing-serial-backfill".
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

const ALLDAY_CONSUMER_PROXY_URL = Deno.env.get("ALLDAY_CONSUMER_PROXY_URL")
  ?? "https://topshot-proxy.tdillonbond.workers.dev/allday-consumer";
const TS_PROXY_SECRET = Deno.env.get("TS_PROXY_SECRET") ?? "";

const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 2000;
const CONSUMER_GQL_CHUNK = 40;          // consumer searchMomentNFTsV2 caps at 40
const CONSUMER_GQL_TIMEOUT_MS = 12_000;
const INTER_CHUNK_DELAY_MS = 250;       // gentle pacing for the shared proxy
const RETRY_BACKOFF_MS = 1_500;         // one retry on 429 / 5xx

const ALLDAY_GQL_QUERY =
  `query($ids:[Int]!){searchMomentNFTsV2(input:{first:40,filters:{byFlowIDs:$ids}}){edges{node{flowID editionFlowID serialNumber}}}}`;

interface SerialRow {
  nft_id: string;
  serial_number: number | null;
  edition_flow_id: string | null;
  fetched_at: string;
}

function toSerial(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// One consumer-GQL chunk call. Returns parsed nodes plus the first error seen
// (null on success). Retries once on a 429 / 5xx after a short backoff.
async function fetchChunk(
  numericIds: number[],
  fetchedAt: string,
): Promise<{ rows: SerialRow[]; error: string | null }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "rip-packs-city/backfill-allday-listing-serials",
  };
  if (TS_PROXY_SECRET) headers["X-Proxy-Secret"] = TS_PROXY_SECRET;

  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(ALLDAY_CONSUMER_PROXY_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ query: ALLDAY_GQL_QUERY, variables: { ids: numericIds } }),
        signal: AbortSignal.timeout(CONSUMER_GQL_TIMEOUT_MS),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === 0) { await sleep(RETRY_BACKOFF_MS); continue; }
      return { rows: [], error: `fetch:${msg.slice(0, 160)}` };
    }

    if (res.status === 429 || res.status >= 500) {
      let snippet = "";
      try { snippet = (await res.text()).slice(0, 120).replace(/\s+/g, " "); } catch { /* ignore */ }
      if (attempt === 0) { await sleep(RETRY_BACKOFF_MS); continue; }
      return { rows: [], error: `http_${res.status}:${snippet}` };
    }
    if (!res.ok) {
      let snippet = "";
      try { snippet = (await res.text()).slice(0, 160).replace(/\s+/g, " "); } catch { /* ignore */ }
      return { rows: [], error: `http_${res.status}:${snippet}` };
    }

    let json: any;
    try { json = await res.json(); }
    catch (err) {
      return { rows: [], error: `json_parse:${err instanceof Error ? err.message.slice(0, 80) : "err"}` };
    }

    if (Array.isArray(json?.errors) && json.errors.length > 0) {
      return { rows: [], error: `gql_errors:${json.errors.map((e: any) => e?.message ?? "?").join("; ").slice(0, 160)}` };
    }

    const edges = json?.data?.searchMomentNFTsV2?.edges ?? [];
    const rows: SerialRow[] = [];
    for (const edge of edges) {
      const node = edge?.node;
      if (!node) continue;
      const flowID = node.flowID != null ? String(node.flowID) : null;
      if (!flowID) continue;
      const editionFlowID = node.editionFlowID != null ? String(node.editionFlowID).trim() : "";
      rows.push({
        nft_id: flowID,
        serial_number: toSerial(node.serialNumber),
        edition_flow_id: editionFlowID === "" ? null : editionFlowID,
        fetched_at: fetchedAt,
      });
    }
    return { rows, error: null };
  }
  return { rows: [], error: "unreachable" };
}

interface Summary {
  batch_requested: number;
  board_only: boolean;
  stale_hours: number;
  targets_returned: number;
  serials_resolved: number;
  rows_upserted: number;
  chunks: number;
  chunk_errors: number;
  first_chunk_error: string | null;
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
      p_pipeline: "allday-listing-serial-backfill",
      p_started_at: args.startedAt,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error ?? null,
      p_collection_slug: "nfl-all-day",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: args.extra,
    });
  } catch (err) {
    console.log(`[allday-serial] log_pipeline_run failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function run(
  batchSize: number,
  boardOnly: boolean,
  staleHours: number,
  startedAt: string,
): Promise<Summary> {
  const summary: Summary = {
    batch_requested: batchSize,
    board_only: boardOnly,
    stale_hours: staleHours,
    targets_returned: 0,
    serials_resolved: 0,
    rows_upserted: 0,
    chunks: 0,
    chunk_errors: 0,
    first_chunk_error: null,
    fatal: null,
  };

  const { data: targetsData, error: targetsErr } = await supabase.rpc(
    "get_allday_listing_serial_targets",
    { p_limit: batchSize, p_board_only: boardOnly, p_stale_hours: staleHours },
  );
  if (targetsErr) {
    summary.fatal = `get_allday_listing_serial_targets:${targetsErr.message.slice(0, 200)}`;
    await logPipelineRun({
      startedAt, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false, error: summary.fatal, extra: summary as unknown as Record<string, unknown>,
    });
    return summary;
  }

  const nftIds = ((targetsData ?? []) as { nft_id: string }[]).map((t) => t.nft_id);
  summary.targets_returned = nftIds.length;
  if (nftIds.length === 0) {
    await logPipelineRun({
      startedAt, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: true, error: null, extra: summary as unknown as Record<string, unknown>,
    });
    return summary;
  }

  const fetchedAt = new Date().toISOString();
  const allRows: SerialRow[] = [];

  for (let i = 0; i < nftIds.length; i += CONSUMER_GQL_CHUNK) {
    const chunk = nftIds.slice(i, i + CONSUMER_GQL_CHUNK);
    const numericIds: number[] = [];
    for (const id of chunk) {
      const n = Number(id);
      if (Number.isFinite(n) && n > 0 && n < 2_147_483_647) numericIds.push(n);
    }
    if (numericIds.length === 0) continue;

    summary.chunks++;
    const { rows, error } = await fetchChunk(numericIds, fetchedAt);
    if (error) {
      summary.chunk_errors++;
      if (!summary.first_chunk_error) summary.first_chunk_error = error;
    }
    allRows.push(...rows);
    if (i + CONSUMER_GQL_CHUNK < nftIds.length) await sleep(INTER_CHUNK_DELAY_MS);
  }

  summary.serials_resolved = allRows.length;

  if (allRows.length > 0) {
    const { error: upsertErr, count } = await supabase
      .from("allday_moment_serials")
      .upsert(allRows, { onConflict: "nft_id", count: "exact" });
    if (upsertErr) {
      summary.fatal = `upsert:${upsertErr.message.slice(0, 200)}`;
      await logPipelineRun({
        startedAt, rowsFound: nftIds.length, rowsWritten: 0, rowsSkipped: nftIds.length,
        ok: false, error: summary.fatal, extra: summary as unknown as Record<string, unknown>,
      });
      return summary;
    }
    summary.rows_upserted = count ?? allRows.length;
  }

  await logPipelineRun({
    startedAt,
    rowsFound: nftIds.length,
    rowsWritten: summary.rows_upserted,
    rowsSkipped: Math.max(0, nftIds.length - summary.serials_resolved),
    // A handful of unreturned ids per run is normal (retired/relisted); only a
    // total wipe-out (every chunk errored) is a real failure.
    ok: summary.chunk_errors === 0 || summary.serials_resolved > 0,
    error: summary.first_chunk_error,
    extra: summary as unknown as Record<string, unknown>,
  });

  console.log(
    `[allday-serial] targets=${summary.targets_returned} resolved=${summary.serials_resolved} upserted=${summary.rows_upserted} chunks=${summary.chunks} chunk_errors=${summary.chunk_errors}`,
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

  let body: { batch_size?: number; board_only?: boolean; stale_hours?: number } = {};
  if (req.method === "POST") {
    try { body = await req.json(); } catch { /* empty body is fine */ }
  }

  const batchSize = clampInt(body.batch_size ?? DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE);
  const boardOnly = body.board_only ?? true;
  const staleHours = clampInt(body.stale_hours ?? 24, 1, 24 * 30);
  const startedAt = new Date().toISOString();

  const work = (async () => {
    try { await run(batchSize, boardOnly, staleHours, startedAt); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[allday-serial] fatal: ${msg.slice(0, 300)}`);
      await logPipelineRun({
        startedAt, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: false, error: msg.slice(0, 500),
        extra: { batch_size: batchSize, board_only: boardOnly, fatal: msg.slice(0, 500) },
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
      board_only: boardOnly,
      stale_hours: staleHours,
      started_at: startedAt,
      note: "Results appear in pipeline_runs as pipeline=allday-listing-serial-backfill within ~10s.",
    }),
    { status: 202, headers: { "Content-Type": "application/json" } },
  );
});
