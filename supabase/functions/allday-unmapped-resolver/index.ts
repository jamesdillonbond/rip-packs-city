// supabase/functions/allday-unmapped-resolver/index.ts
//
// Resolves the AllDay unmapped-sales backlog by hydrating
// nft_edition_map for nft_ids that hit the on-chain sales indexer
// before the editions seeder learned about them. Each invocation:
//
//   1. Pulls up to 50 unresolved AllDay nft_ids from the DB via
//      get_unmapped_resolver_targets (already filters out anything
//      already present in nft_edition_map, so every row is genuinely
//      unmapped).
//   2. Sends a single batched searchMomentNFTsV2(byFlowIDs:[Int]!)
//      query through the topshot-proxy /allday-consumer route to look
//      up flowSerialNumber + editionFlowID for each id.
//   3. Calls resolve_unmapped_sales_for_collection, which upserts the
//      mapping rows then immediately runs promote_unmapped_sales to
//      move resolved rows out of unmapped_sales into the canonical
//      sales table.
//
// Auth + structure mirror sales-serial-backfill (same proxy worker,
// same X-Proxy-Secret header, same INGEST_SECRET_TOKEN auth shape,
// same EdgeRuntime.waitUntil pattern). Pipeline run is logged via the
// log_pipeline_run RPC under pipeline name "allday-unmapped-resolver".
//
// Suggested cron-job.org cadence: every 20 min UTC (matches the
// listing-cache job). Do NOT wire cron from this file — Trevor
// configures the schedule in the cron-job.org dashboard.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const INGEST_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN");
if (!INGEST_TOKEN) throw new Error("INGEST_SECRET_TOKEN is required");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070";

// Trevor's instructions name this var ALLDAY_PROXY_URL; sales-serial-backfill
// uses ALLDAY_CONSUMER_PROXY_URL. Read both so a single deploy works regardless
// of which name is set in Vercel/Supabase function secrets.
const ALLDAY_PROXY_URL = Deno.env.get("ALLDAY_PROXY_URL")
  ?? Deno.env.get("ALLDAY_CONSUMER_PROXY_URL")
  ?? "https://topshot-proxy.tdillonbond.workers.dev/allday-consumer";

const TS_PROXY_SECRET = Deno.env.get("TS_PROXY_SECRET") ?? "";

const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 200;
const PROMOTE_LIMIT = 1000;
const GQL_TIMEOUT_MS = 12_000;

const ALLDAY_GQL_QUERY =
  `query($ids:[Int]!){searchMomentNFTsV2(input:{first:200, filters:{byFlowIDs:$ids}}){edges{node{flowID serialNumber editionFlowID}}}}`;

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

interface FetchOutcome {
  rows: MappingRow[];
  returnedIds: string[];
  gqlErrors: string[];
  status: number | null;
  fatal: string | null;
}

async function fetchAllDayMappings(nftIds: string[]): Promise<FetchOutcome> {
  const out: FetchOutcome = { rows: [], returnedIds: [], gqlErrors: [], status: null, fatal: null };

  // AllDay flowIDs are well within Int32 today (~10M). Defensive filter so a
  // future wraparound doesn't 422 the entire batch.
  const numericIds: number[] = [];
  for (const id of nftIds) {
    const n = Number(id);
    if (Number.isFinite(n) && n > 0 && n < 2_147_483_647) numericIds.push(n);
  }
  if (numericIds.length === 0) {
    out.fatal = "no_int_castable_ids";
    return out;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "rip-packs-city/allday-unmapped-resolver",
  };
  if (TS_PROXY_SECRET) headers["X-Proxy-Secret"] = TS_PROXY_SECRET;

  let res: Response;
  try {
    res = await fetch(ALLDAY_PROXY_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: ALLDAY_GQL_QUERY, variables: { ids: numericIds } }),
      signal: AbortSignal.timeout(GQL_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out.fatal = `fetch:${msg.slice(0, 200)}`;
    return out;
  }

  out.status = res.status;
  if (!res.ok) {
    let bodySnippet = "";
    try { bodySnippet = (await res.text()).slice(0, 300).replace(/\s+/g, " "); } catch { /* ignore */ }
    out.fatal = `http_${res.status}${bodySnippet ? `:${bodySnippet}` : ""}`;
    return out;
  }

  let json: any;
  try { json = await res.json(); }
  catch (err) {
    out.fatal = `json_parse:${err instanceof Error ? err.message.slice(0, 120) : "err"}`;
    return out;
  }

  if (Array.isArray(json?.errors) && json.errors.length > 0) {
    for (const e of json.errors) out.gqlErrors.push(String(e?.message ?? "?").slice(0, 200));
  }

  const edges = json?.data?.searchMomentNFTsV2?.edges ?? [];
  for (const edge of edges) {
    const node = edge?.node;
    if (!node) continue;
    const flowID = node.flowID != null ? String(node.flowID) : null;
    const editionFlowID = node.editionFlowID != null ? String(node.editionFlowID) : null;
    const rawSerial = node.serialNumber;
    const serial = rawSerial != null && Number.isFinite(Number(rawSerial)) && Number(rawSerial) > 0
      ? Number(rawSerial)
      : null;
    if (flowID) out.returnedIds.push(flowID);
    if (!flowID || !editionFlowID) continue;
    out.rows.push({ nft_id: flowID, edition_external_id: editionFlowID, serial_number: serial });
  }

  return out;
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

interface ResolverSummary {
  batch_requested: number;
  targets_returned: number;
  gql_status: number | null;
  gql_errors: string[];
  mappings_written: number;
  sales_promoted: number;
  sales_archived: number;
  failures_recorded: number;
  promote_raw: unknown;
  fatal: string | null;
}

async function recordResolutionFailures(
  collectionId: string,
  missingIds: string[],
  detail: string,
): Promise<number> {
  if (missingIds.length === 0) return 0;
  const calls = missingIds.map((nftId) =>
    // deno-lint-ignore no-explicit-any
    (supabase as any).rpc("record_unmapped_resolution_failure", {
      p_collection_id: collectionId,
      p_nft_id: nftId,
      p_reason: "gql_no_data",
      p_detail: detail,
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

async function runResolver(batchSize: number, startedAt: string): Promise<ResolverSummary> {
  const summary: ResolverSummary = {
    batch_requested: batchSize,
    targets_returned: 0,
    gql_status: null,
    gql_errors: [],
    mappings_written: 0,
    sales_promoted: 0,
    sales_archived: 0,
    failures_recorded: 0,
    promote_raw: null,
    fatal: null,
  };

  const { data: targetsData, error: targetsErr } = await supabase.rpc(
    "get_unmapped_resolver_targets",
    {
      p_collection_id: ALLDAY_COLLECTION_ID,
      p_limit: batchSize,
      p_offset: 0,
    },
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
  const fetchResult = await fetchAllDayMappings(nftIds);
  summary.gql_status = fetchResult.status;
  summary.gql_errors = fetchResult.gqlErrors;

  if (fetchResult.fatal) {
    summary.fatal = fetchResult.fatal;
    await logPipelineRun({
      startedAt,
      rowsFound: targets.length,
      rowsWritten: 0,
      rowsSkipped: targets.length,
      ok: false,
      error: fetchResult.fatal,
      extra: summary as unknown as Record<string, unknown>,
    });
    return summary;
  }

  const rowsJson = fetchResult.rows;

  // Dead-set detection: nft_ids that we asked GQL about but did not see in the
  // response. Skip recording on partial-error responses — gql_errors present
  // means the response is not fully trustworthy and we don't want to falsely
  // escalate retry_count on ids the API may have failed to evaluate. HTTP /
  // parse fatals already short-circuited above.
  if (summary.gql_errors.length === 0) {
    const returnedSet = new Set(fetchResult.returnedIds);
    const missing = nftIds.filter((id) => !returnedSet.has(id));
    if (missing.length > 0) {
      const detail = `batch_size_${nftIds.length}_returned_${returnedSet.size}`;
      summary.failures_recorded = await recordResolutionFailures(
        ALLDAY_COLLECTION_ID,
        missing,
        detail,
      );
    }
  }

  if (rowsJson.length === 0) {
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
      p_rows: rowsJson,
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

  // resolve_unmapped_sales_for_collection returns:
  //   { mapping_upserted: int, promote_result: { ... promote_unmapped_sales jsonb ... } }
  // promote_unmapped_sales returns whatever fields it builds — surface the raw
  // jsonb in extras and pull the common counter shapes if present.
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
    `[allday-unmapped] targets=${targets.length} mappings=${summary.mappings_written} promoted=${summary.sales_promoted} archived=${summary.sales_archived} failures_recorded=${summary.failures_recorded} gql_errors=${summary.gql_errors.length}`,
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
      status: 401,
      headers: { "Content-Type": "application/json" },
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
        startedAt,
        rowsFound: 0,
        rowsWritten: 0,
        rowsSkipped: 0,
        ok: false,
        error: msg.slice(0, 500),
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
      note: "Real results will appear in pipeline_runs as pipeline=allday-unmapped-resolver within ~20s.",
    }),
    { status: 202, headers: { "Content-Type": "application/json" } },
  );
});
