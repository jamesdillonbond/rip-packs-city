// supabase/functions/allday-unmapped-resolver/index.ts
//
// Resolves the AllDay unmapped-sales backlog by hydrating
// nft_edition_map for nft_ids that hit the on-chain sales indexer
// before the editions seeder learned about them.
//
// 2026-05-07 rewrite: AllDay's public-api.nflallday.com GraphQL only
// indexes moments held by indexed wallets, so the previous
// searchMomentNFTsV2(byFlowIDs:[Int]!) batch query failed 100% with
// gql_no_data on Flowty-marketplace nft_ids whose owner is outside
// our 245-wallet index. New approach: call Flowty's per-NFT REST
// endpoint (GET https://api2.flowty.io/nft/0xe4cf4bdc1751c65d/AllDay/{nft_id}),
// which Flowty already indexes for the marketplace UI. The response
// includes nftView.traits.traits[] with editionID + serialNumber.
//
// Each invocation:
//   1. Pulls up to N unresolved AllDay nft_ids from the DB via
//      get_unmapped_resolver_targets.
//   2. For each id, GETs Flowty's /nft/{contractAddress}/{contractName}/{id}
//      endpoint with controlled concurrency (default 8 in flight).
//      Flowty allows direct egress from Supabase edge functions; no
//      proxy worker required (same observation backs the listing-cache
//      flowty-proxy egress note).
//   3. Builds rowsJson [{nft_id, edition_external_id, serial_number}]
//      from successful responses.
//   4. Calls resolve_unmapped_sales_for_collection, which upserts the
//      mapping rows then immediately runs promote_unmapped_sales to
//      move resolved rows out of unmapped_sales into the canonical
//      sales table.
//   5. Records record_unmapped_resolution_failure for any id that
//      404'd, returned no editionID, or hit a transport error.
//
// Auth + structure preserved from the prior version: same
// INGEST_SECRET_TOKEN bearer, same EdgeRuntime.waitUntil pattern,
// same log_pipeline_run RPC under pipeline name "allday-unmapped-resolver".

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const INGEST_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN");
if (!INGEST_TOKEN) throw new Error("INGEST_SECRET_TOKEN is required");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070";
const FLOWTY_NFT_BASE =
  "https://api2.flowty.io/nft/0xe4cf4bdc1751c65d/AllDay";
const FLOWTY_HEADERS: Record<string, string> = {
  "Origin": "https://www.flowty.io",
  "User-Agent": "rip-packs-city/allday-unmapped-resolver",
};

// Bumped 50→200 on 2026-05-08 to drain the AllDay backlog faster.
// At ~8% Flowty-edition-id resolution rate, batch=50 yielded ~3.9
// mappings/run × 58 runs/day = ~227/day against a 2.8k backlog.
// batch=200 + concurrency=16 expands per-run throughput proportionally
// while staying under the 8s per-call Flowty timeout (200/16 ≈ 12.5
// in flight × ~100ms = ~1.3s wall clock for the fan-out). MAX_BATCH_SIZE
// stays at 200 — the cap is enforced by clampInt below.
const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 200;
const PROMOTE_LIMIT = 1000;
const PER_CALL_TIMEOUT_MS = 8_000;
const CONCURRENCY = 16;

interface ResolverTarget {
  collection_id: string;
  nft_id: string;
  oldest_unmapped: string;
  occurrences: number;
}

interface MappingRow {
  nft_id: string;
  edition_external_id: string;
  serial_number: number | null;
}

type FlowtyOutcome =
  | { kind: "ok"; row: MappingRow }
  | { kind: "missing"; reason: string; detail: string };

function extractTrait(traits: unknown, name: string): string | null {
  if (!Array.isArray(traits)) return null;
  for (const t of traits) {
    if (t && typeof t === "object" && (t as any).name === name) {
      const v = (t as any).value;
      if (v != null && String(v).trim() !== "") return String(v).trim();
    }
  }
  return null;
}

async function fetchOne(nftId: string): Promise<FlowtyOutcome> {
  let res: Response;
  try {
    res = await fetch(`${FLOWTY_NFT_BASE}/${encodeURIComponent(nftId)}`, {
      method: "GET",
      headers: FLOWTY_HEADERS,
      signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: "missing", reason: "flowty_fetch_error", detail: msg.slice(0, 200) };
  }

  if (res.status === 404) {
    return { kind: "missing", reason: "flowty_404", detail: `http_404` };
  }
  if (!res.ok) {
    let snippet = "";
    try { snippet = (await res.text()).slice(0, 200).replace(/\s+/g, " "); } catch { /* ignore */ }
    return { kind: "missing", reason: "flowty_http_error", detail: `http_${res.status}:${snippet}` };
  }

  let json: any;
  try { json = await res.json(); }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: "missing", reason: "flowty_json_parse", detail: msg.slice(0, 200) };
  }

  const traits = json?.nftView?.traits?.traits;
  const editionID = extractTrait(traits, "editionID");
  const serialStr = extractTrait(traits, "serialNumber");
  if (!editionID) {
    return { kind: "missing", reason: "flowty_no_edition_id", detail: `id=${nftId} flowty_id=${json?.id ?? "?"}` };
  }
  const serial = serialStr != null && Number.isFinite(Number(serialStr)) && Number(serialStr) > 0
    ? Number(serialStr)
    : null;
  return {
    kind: "ok",
    row: { nft_id: String(nftId), edition_external_id: String(editionID), serial_number: serial },
  };
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const slot = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < slot; i++) {
    workers.push((async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        results[idx] = await fn(items[idx]);
      }
    })());
  }
  await Promise.all(workers);
  return results;
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
      p_pipeline: "allday-unmapped-resolver",
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
    console.log(`[allday-unmapped] log_pipeline_run failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface FailureBucket { nft_id: string; reason: string; detail: string; }

async function recordFailures(
  collectionId: string,
  failures: FailureBucket[],
): Promise<number> {
  if (failures.length === 0) return 0;
  const calls = failures.map((f) =>
    // deno-lint-ignore no-explicit-any
    (supabase as any).rpc("record_unmapped_resolution_failure", {
      p_collection_id: collectionId,
      p_nft_id: f.nft_id,
      p_reason: f.reason,
      p_detail: f.detail,
    }).then(
      // deno-lint-ignore no-explicit-any
      (r: any) => (r?.error ? { ok: false, msg: String(r.error.message ?? "?") } : { ok: true }),
      (err: unknown) => ({ ok: false, msg: err instanceof Error ? err.message : String(err) }),
    )
  );
  const results = await Promise.all(calls);
  let recorded = 0;
  let firstErr: string | null = null;
  for (const r of results) {
    if (r.ok) recorded++;
    else if (!firstErr) firstErr = r.msg.slice(0, 200);
  }
  if (firstErr) {
    console.log(`[allday-unmapped] record_unmapped_resolution_failure errors (sample): ${firstErr}`);
  }
  return recorded;
}

interface ResolverSummary {
  batch_requested: number;
  targets_returned: number;
  flowty_ok: number;
  flowty_missing: number;
  flowty_404: number;
  flowty_no_edition_id: number;
  flowty_transport_errors: number;
  mappings_written: number;
  sales_promoted: number;
  sales_archived: number;
  failures_recorded: number;
  promote_raw: unknown;
  fatal: string | null;
}

async function runResolver(batchSize: number, startedAt: string): Promise<ResolverSummary> {
  const summary: ResolverSummary = {
    batch_requested: batchSize,
    targets_returned: 0,
    flowty_ok: 0,
    flowty_missing: 0,
    flowty_404: 0,
    flowty_no_edition_id: 0,
    flowty_transport_errors: 0,
    mappings_written: 0,
    sales_promoted: 0,
    sales_archived: 0,
    failures_recorded: 0,
    promote_raw: null,
    fatal: null,
  };

  const { data: targetsData, error: targetsErr } = await supabase.rpc(
    "get_unmapped_resolver_targets",
    { p_collection_id: ALLDAY_COLLECTION_ID, p_limit: batchSize, p_offset: 0 },
  );

  if (targetsErr) {
    summary.fatal = `get_unmapped_resolver_targets:${targetsErr.message.slice(0, 200)}`;
    await logPipelineRun({
      startedAt, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false, error: summary.fatal, extra: summary as unknown as Record<string, unknown>,
    });
    return summary;
  }

  const targets = (targetsData ?? []) as ResolverTarget[];
  summary.targets_returned = targets.length;
  if (targets.length === 0) {
    await logPipelineRun({
      startedAt, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: true, error: null, extra: summary as unknown as Record<string, unknown>,
    });
    return summary;
  }

  const nftIds = targets.map((t) => t.nft_id);
  const outcomes = await runWithConcurrency(nftIds, CONCURRENCY, fetchOne);

  const rows: MappingRow[] = [];
  const failures: FailureBucket[] = [];
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    const id = nftIds[i];
    if (o.kind === "ok") {
      rows.push(o.row);
      summary.flowty_ok++;
    } else {
      summary.flowty_missing++;
      if (o.reason === "flowty_404") summary.flowty_404++;
      else if (o.reason === "flowty_no_edition_id") summary.flowty_no_edition_id++;
      else summary.flowty_transport_errors++;
      failures.push({ nft_id: id, reason: o.reason, detail: o.detail });
    }
  }

  if (failures.length > 0) {
    summary.failures_recorded = await recordFailures(ALLDAY_COLLECTION_ID, failures);
  }

  if (rows.length === 0) {
    await logPipelineRun({
      startedAt,
      rowsFound: targets.length,
      rowsWritten: 0,
      rowsSkipped: targets.length,
      ok: true,
      error: null,
      extra: summary as unknown as Record<string, unknown>,
    });
    return summary;
  }

  const { data: resolveData, error: resolveErr } = await supabase.rpc(
    "resolve_unmapped_sales_for_collection",
    {
      p_collection_id: ALLDAY_COLLECTION_ID,
      p_rows: rows,
      p_promote_limit: PROMOTE_LIMIT,
    },
  );

  if (resolveErr) {
    summary.fatal = `resolve_unmapped_sales_for_collection:${resolveErr.message.slice(0, 200)}`;
    await logPipelineRun({
      startedAt,
      rowsFound: targets.length,
      rowsWritten: 0,
      rowsSkipped: targets.length,
      ok: false,
      error: summary.fatal,
      extra: summary as unknown as Record<string, unknown>,
    });
    return summary;
  }

  const resolveJson = (resolveData ?? {}) as Record<string, unknown>;
  summary.mappings_written = Number(resolveJson["mapping_upserted"] ?? 0) || 0;
  const promoteRaw = (resolveJson["promote_result"] ?? null) as Record<string, unknown> | null;
  summary.promote_raw = promoteRaw;
  if (promoteRaw && typeof promoteRaw === "object") {
    summary.sales_promoted =
      Number(promoteRaw["promoted"] ?? promoteRaw["sales_promoted"] ?? promoteRaw["inserted"] ?? 0) || 0;
    summary.sales_archived =
      Number(promoteRaw["archived"] ?? promoteRaw["sales_archived"] ?? promoteRaw["resolved"] ?? 0) || 0;
  }

  await logPipelineRun({
    startedAt,
    rowsFound: targets.length,
    rowsWritten: summary.mappings_written,
    rowsSkipped: Math.max(0, targets.length - summary.mappings_written),
    ok: true,
    error: null,
    extra: summary as unknown as Record<string, unknown>,
  });

  console.log(
    `[allday-unmapped] targets=${targets.length} flowty_ok=${summary.flowty_ok} mappings=${summary.mappings_written} promoted=${summary.sales_promoted} archived=${summary.sales_archived} failures=${summary.flowty_missing}(404=${summary.flowty_404} no_ed=${summary.flowty_no_edition_id} tx=${summary.flowty_transport_errors})`,
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
    try { await runResolver(batchSize, startedAt); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[allday-unmapped] fatal: ${msg.slice(0, 300)}`);
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
      collection_id: ALLDAY_COLLECTION_ID,
      batch_size: batchSize,
      started_at: startedAt,
      note: "Real results will appear in pipeline_runs as pipeline=allday-unmapped-resolver within ~10s.",
    }),
    { status: 202, headers: { "Content-Type": "application/json" } },
  );
});
