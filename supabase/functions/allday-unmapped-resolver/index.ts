// supabase/functions/allday-unmapped-resolver/index.ts
//
// Resolves the AllDay unmapped-sales backlog by hydrating nft_edition_map
// for nft_ids that hit the on-chain sales indexer before the editions
// seeder learned about them. Once a mapping exists, the embedded
// promote_unmapped_sales call moves the resolved sale into public.sales.
//
// 2026-05-25 rewrite — AllDay's own consumer GraphQL is now the PRIMARY
// resolver:
//
//   topshot-proxy worker /allday-consumer  ->  nflallday.com/consumer/graphql
//   searchMomentNFTsV2(input:{ filters:{ byFlowIDs:[Int]! } })
//
// whose node exposes flowID + editionFlowID + serialNumber. This is
// AllDay's authoritative index: a byFlowIDs lookup resolves any moment by
// id regardless of owner — unlike the public-api searchMomentNFTsV2
// (indexed-wallets only, which is why the 2026-05-07 version abandoned it)
// and unlike Flowty's third-party index (~60% no-editionID, and Flowty has
// shut its marketplace down).
//
// Flowty's per-NFT REST endpoint is kept ONLY as a fallback for ids the
// consumer GQL does not return, so this deploy can never resolve fewer ids
// than the prior Flowty-only version. Once pipeline_runs confirms the
// consumer-GQL leg carries the load, the Flowty fallback can be deleted.
//
// Each invocation:
//   1. Pulls up to N unresolved AllDay nft_ids via get_unmapped_resolver_targets.
//   2. PRIMARY: one batched searchMomentNFTsV2(byFlowIDs) call per <=200 ids
//      against the worker /allday-consumer route (X-Proxy-Secret auth).
//   3. FALLBACK: for ids the consumer GQL did not return, GET Flowty's
//      /nft/{contract}/AllDay/{id} per-NFT endpoint (concurrency 16).
//   4. resolve_unmapped_sales_for_collection upserts the mapping rows then
//      runs promote_unmapped_sales.
//   5. record_unmapped_resolution_failure for ids resolved by neither source.
//
// Auth + structure preserved: INGEST_SECRET_TOKEN bearer (or ?token=),
// EdgeRuntime.waitUntil, log_pipeline_run under pipeline "allday-unmapped-resolver".

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const INGEST_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN");
if (!INGEST_TOKEN) throw new Error("INGEST_SECRET_TOKEN is required");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070";

// Primary — AllDay consumer GraphQL via the topshot-proxy worker.
const ALLDAY_CONSUMER_PROXY_URL = Deno.env.get("ALLDAY_CONSUMER_PROXY_URL")
  ?? "https://topshot-proxy.tdillonbond.workers.dev/allday-consumer";
const TS_PROXY_SECRET = Deno.env.get("TS_PROXY_SECRET") ?? "";

// Fallback — Flowty per-NFT REST.
const FLOWTY_NFT_BASE = "https://api2.flowty.io/nft/0xe4cf4bdc1751c65d/AllDay";
const FLOWTY_HEADERS: Record<string, string> = {
  "Origin": "https://www.flowty.io",
  "User-Agent": "rip-packs-city/allday-unmapped-resolver",
};

const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 200;
const PROMOTE_LIMIT = 1000;
const CONSUMER_GQL_CHUNK = 200;       // byFlowIDs ids per consumer-GQL call.
const CONSUMER_GQL_TIMEOUT_MS = 12_000;
const PER_CALL_TIMEOUT_MS = 8_000;    // Flowty per-NFT call.
const CONCURRENCY = 16;               // Flowty fan-out.

// searchMomentNFTsV2 on the consumer schema: node exposes flowID (the moment
// nft_id), editionFlowID (the edition's flow id == editions.external_id for
// AllDay), and serialNumber. byFlowIDs is [Int]!.
const ALLDAY_GQL_QUERY =
  `query($ids:[Int]!){searchMomentNFTsV2(input:{first:200,filters:{byFlowIDs:$ids}}){edges{node{flowID editionFlowID serialNumber}}}}`;

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

interface FailureBucket {
  nft_id: string;
  reason: string;
  detail: string;
}

function toSerial(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── Primary — AllDay consumer GraphQL batched resolver ───────────────────────
// Returns a map nft_id -> MappingRow for every id the consumer index knows,
// plus the first GQL/transport error seen (null if every chunk succeeded).
async function resolveViaConsumerGql(
  nftIds: string[],
): Promise<{ rows: Map<string, MappingRow>; gqlError: string | null }> {
  const rows = new Map<string, MappingRow>();
  if (nftIds.length === 0) return { rows, gqlError: null };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "rip-packs-city/allday-unmapped-resolver",
  };
  if (TS_PROXY_SECRET) headers["X-Proxy-Secret"] = TS_PROXY_SECRET;

  let firstError: string | null = null;

  for (let i = 0; i < nftIds.length; i += CONSUMER_GQL_CHUNK) {
    const chunk = nftIds.slice(i, i + CONSUMER_GQL_CHUNK);
    // byFlowIDs is [Int]! — only numeric ids inside Int range are eligible.
    const numericIds: number[] = [];
    for (const id of chunk) {
      const n = Number(id);
      if (Number.isFinite(n) && n > 0 && n < 2_147_483_647) numericIds.push(n);
    }
    if (numericIds.length === 0) continue;

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
      if (!firstError) firstError = `fetch:${msg.slice(0, 160)}`;
      continue;
    }

    if (!res.ok) {
      let snippet = "";
      try { snippet = (await res.text()).slice(0, 160).replace(/\s+/g, " "); } catch { /* ignore */ }
      if (!firstError) firstError = `http_${res.status}:${snippet}`;
      continue;
    }

    let json: any;
    try { json = await res.json(); }
    catch (err) {
      if (!firstError) firstError = `json_parse:${err instanceof Error ? err.message.slice(0, 80) : "err"}`;
      continue;
    }

    if (Array.isArray(json?.errors) && json.errors.length > 0) {
      if (!firstError) {
        firstError = `gql_errors:${json.errors.map((e: any) => e?.message ?? "?").join("; ").slice(0, 160)}`;
      }
      continue;
    }

    const edges = json?.data?.searchMomentNFTsV2?.edges ?? [];
    for (const edge of edges) {
      const node = edge?.node;
      if (!node) continue;
      const flowID = node.flowID != null ? String(node.flowID) : null;
      const editionFlowID = node.editionFlowID != null ? String(node.editionFlowID).trim() : "";
      if (!flowID || editionFlowID === "") continue;
      rows.set(flowID, {
        nft_id: flowID,
        edition_external_id: editionFlowID,
        serial_number: toSerial(node.serialNumber),
      });
    }
  }

  return { rows, gqlError: firstError };
}

// ── Fallback — Flowty per-NFT REST ───────────────────────────────────────────
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

async function fetchOneFlowty(nftId: string): Promise<FlowtyOutcome> {
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
    return { kind: "missing", reason: "flowty_404", detail: "http_404" };
  }
  if (!res.ok) {
    let snippet = "";
    try { snippet = (await res.text()).slice(0, 200).replace(/\s+/g, " "); } catch { /* ignore */ }
    return { kind: "missing", reason: "flowty_http_error", detail: `http_${res.status}:${snippet}` };
  }

  let json: any;
  try { json = await res.json(); }
  catch (err) {
    return { kind: "missing", reason: "flowty_json_parse", detail: err instanceof Error ? err.message.slice(0, 200) : "err" };
  }

  const traits = json?.nftView?.traits?.traits;
  const editionID = extractTrait(traits, "editionID");
  const serialStr = extractTrait(traits, "serialNumber");
  if (!editionID) {
    return { kind: "missing", reason: "no_edition_id", detail: `flowty_id=${json?.id ?? "?"}` };
  }
  return {
    kind: "ok",
    row: { nft_id: String(nftId), edition_external_id: String(editionID), serial_number: toSerial(serialStr) },
  };
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const slot = Math.max(1, Math.min(limit, items.length));
  const workers: Promise<void>[] = [];
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

// ── pipeline_runs logging ────────────────────────────────────────────────────
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

async function recordFailures(failures: FailureBucket[]): Promise<number> {
  if (failures.length === 0) return 0;
  const calls = failures.map((f) =>
    // deno-lint-ignore no-explicit-any
    (supabase as any).rpc("record_unmapped_resolution_failure", {
      p_collection_id: ALLDAY_COLLECTION_ID,
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
  consumer_gql_ok: number;
  consumer_gql_error: string | null;
  flowty_attempted: number;
  flowty_ok: number;
  flowty_missing: number;
  mappings_written: number;
  sales_promoted: number;
  sales_archived: number;
  failures_recorded: number;
  fatal: string | null;
}

async function runResolver(batchSize: number, startedAt: string): Promise<ResolverSummary> {
  const summary: ResolverSummary = {
    batch_requested: batchSize,
    targets_returned: 0,
    consumer_gql_ok: 0,
    consumer_gql_error: null,
    flowty_attempted: 0,
    flowty_ok: 0,
    flowty_missing: 0,
    mappings_written: 0,
    sales_promoted: 0,
    sales_archived: 0,
    failures_recorded: 0,
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

  // PRIMARY — AllDay consumer GraphQL.
  const { rows: gqlRows, gqlError } = await resolveViaConsumerGql(nftIds);
  summary.consumer_gql_ok = gqlRows.size;
  summary.consumer_gql_error = gqlError;

  // FALLBACK — Flowty per-NFT for ids the consumer GQL did not return.
  const unresolved = nftIds.filter((id) => !gqlRows.has(id));
  summary.flowty_attempted = unresolved.length;
  const flowtyOutcomes = await runWithConcurrency(unresolved, CONCURRENCY, fetchOneFlowty);

  const rows: MappingRow[] = [...gqlRows.values()];
  const failures: FailureBucket[] = [];
  for (let i = 0; i < flowtyOutcomes.length; i++) {
    const o = flowtyOutcomes[i];
    const id = unresolved[i];
    if (o.kind === "ok") {
      rows.push(o.row);
      summary.flowty_ok++;
    } else {
      summary.flowty_missing++;
      failures.push({
        nft_id: id,
        reason: o.reason === "no_edition_id" ? "no_edition_id_both_sources" : o.reason,
        detail: (gqlError ? `consumer_gql:${gqlError}` : "consumer_gql:not_returned") + ` | flowty:${o.detail}`,
      });
    }
  }

  if (failures.length > 0) {
    summary.failures_recorded = await recordFailures(failures);
  }

  if (rows.length === 0) {
    await logPipelineRun({
      startedAt, rowsFound: targets.length, rowsWritten: 0, rowsSkipped: targets.length,
      ok: true, error: null, extra: summary as unknown as Record<string, unknown>,
    });
    console.log(`[allday-unmapped] targets=${targets.length} consumer_gql_ok=0 flowty_ok=0 mappings=0`);
    return summary;
  }

  const { data: resolveData, error: resolveErr } = await supabase.rpc(
    "resolve_unmapped_sales_for_collection",
    { p_collection_id: ALLDAY_COLLECTION_ID, p_rows: rows, p_promote_limit: PROMOTE_LIMIT },
  );

  if (resolveErr) {
    summary.fatal = `resolve_unmapped_sales_for_collection:${resolveErr.message.slice(0, 200)}`;
    await logPipelineRun({
      startedAt, rowsFound: targets.length, rowsWritten: 0, rowsSkipped: targets.length,
      ok: false, error: summary.fatal, extra: summary as unknown as Record<string, unknown>,
    });
    return summary;
  }

  const resolveJson = (resolveData ?? {}) as Record<string, unknown>;
  summary.mappings_written = Number(resolveJson["mapping_upserted"] ?? 0) || 0;
  const promoteRaw = (resolveJson["promote_result"] ?? null) as Record<string, unknown> | null;
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
    `[allday-unmapped] targets=${targets.length} consumer_gql_ok=${summary.consumer_gql_ok} flowty_ok=${summary.flowty_ok} mappings=${summary.mappings_written} promoted=${summary.sales_promoted} failures=${summary.flowty_missing}`,
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
      note: "Results appear in pipeline_runs as pipeline=allday-unmapped-resolver within ~10s.",
    }),
    { status: 202, headers: { "Content-Type": "application/json" } },
  );
});
