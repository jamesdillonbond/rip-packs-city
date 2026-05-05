// supabase/functions/sales-serial-backfill/index.ts
// Phase 2A. Re-resolve serial_number for historical sales rows that landed
// with serial_number = 0 because of the sales-indexer regression fixed in
// commit 55566e3. Every target row carries a working nft_id + edition_id
// + transaction_hash, so we can re-resolve via the right per-collection GQL.
//
// Trigger: ad-hoc via curl (one-shot, NOT cron). Returns 202 immediately and
// processes the queue asynchronously via EdgeRuntime.waitUntil() when
// available. Re-runs are safe — update_sale_serial only updates if the
// current value is 0 and the resolved serial is a valid positive integer.
//
// Auth: Authorization header must contain INGEST_SECRET_TOKEN (or pass it
// as ?token=<value>). Same pattern as special-serial-sweep.
//
// Input body (all optional):
//   { collection_id?: string, batch_size?: number }
//
// Per-collection paths:
//
//   TopShot → topshot-proxy worker /topshot (public-api.nbatopshot.com).
//             One request per nft_id — getMintedMoment(momentId).data is a
//             union, requires the `... on MintedMoment` fragment. 50ms
//             inter-request throttle. Mirrors app/api/sales-indexer/route.ts.
//
//   AllDay  → topshot-proxy worker /allday-consumer (nflallday.com/consumer/graphql).
//             Single batched request per invocation — searchMomentNFTsV2 with
//             byFlowIDs:[Int]! filter accepts up to N nft_ids in one call. The
//             previous getMintedMoment field was removed from this schema in a
//             prior migration (see CLAUDE.md AllDay GraphQL section); five
//             other repo callers still rely on it and silently swallow the
//             resulting 422s — separate cleanup ticket. AllDay has two
//             non-overlapping schemas; this one is /allday-consumer, not /allday.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const INGEST_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN");
if (!INGEST_TOKEN) throw new Error("INGEST_SECRET_TOKEN is required");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const TS_PROXY_URL = Deno.env.get("TS_PROXY_URL") ?? "https://topshot-proxy.tdillonbond.workers.dev/topshot";
const TS_PROXY_SECRET = Deno.env.get("TS_PROXY_SECRET") ?? "";
const ALLDAY_CONSUMER_PROXY_URL = Deno.env.get("ALLDAY_CONSUMER_PROXY_URL")
  ?? "https://topshot-proxy.tdillonbond.workers.dev/allday-consumer";

const REQ_THROTTLE_MS = 50;     // ~20 req/s ceiling on per-id calls.
const ALLDAY_GQL_TIMEOUT_MS = 12_000; // batched calls deserve a longer budget.
const TS_GQL_TIMEOUT_MS = 8_000;
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1000;

const COLLECTION_IDS = {
  topshot: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  allday:  "dee28451-5d62-409e-a1ad-a83f763ac070",
} as const;

const TS_GQL_QUERY = `query($id:ID!){getMintedMoment(momentId:$id){data{...on MintedMoment{flowSerialNumber}}}}`;
const ALLDAY_GQL_QUERY = `query($ids:[Int]!){searchMomentNFTsV2(input:{first:200, filters:{byFlowIDs:$ids}}){edges{node{flowID serialNumber}}}}`;

interface BackfillTarget {
  sale_id: string;
  collection_id: string;
  nft_id: string;
  edition_id: string;
  sold_at: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface FetchResult {
  serial: number | null;
  reason: "ok" | "gql_404" | "gql_null_serial" | "timeout" | "unknown";
  detail: string | null;
}

// ── TopShot per-id resolver ──────────────────────────────────────────────────

async function fetchSerialTopShot(target: BackfillTarget): Promise<FetchResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "rip-packs-city/sales-serial-backfill",
  };
  if (TS_PROXY_SECRET) headers["X-Proxy-Secret"] = TS_PROXY_SECRET;

  let res: Response;
  try {
    res = await fetch(TS_PROXY_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: TS_GQL_QUERY, variables: { id: target.nft_id } }),
      signal: AbortSignal.timeout(TS_GQL_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("aborted") || msg.toLowerCase().includes("timeout")) {
      return { serial: null, reason: "timeout", detail: `topshot:${msg.slice(0, 120)}` };
    }
    return { serial: null, reason: "unknown", detail: `topshot:${msg.slice(0, 120)}` };
  }

  if (!res.ok) {
    let bodySnippet = "";
    try { bodySnippet = (await res.text()).slice(0, 160).replace(/\s+/g, " "); } catch { /* ignore */ }
    if (res.status === 404) return { serial: null, reason: "gql_404", detail: `http_404${bodySnippet ? `:${bodySnippet}` : ""}` };
    return { serial: null, reason: "unknown", detail: `http_${res.status}${bodySnippet ? `:${bodySnippet}` : ""}` };
  }

  let json: any;
  try { json = await res.json(); }
  catch (err) {
    return { serial: null, reason: "unknown", detail: `json_parse:${err instanceof Error ? err.message.slice(0, 80) : "err"}` };
  }

  const data = json?.data?.getMintedMoment?.data;
  if (!data) return { serial: null, reason: "gql_null_serial", detail: "no_minted_moment" };
  const raw = data.flowSerialNumber;
  if (raw == null) return { serial: null, reason: "gql_null_serial", detail: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { serial: null, reason: "gql_null_serial", detail: `raw=${String(raw).slice(0, 40)}` };
  return { serial: n, reason: "ok", detail: null };
}

// ── AllDay batched resolver ──────────────────────────────────────────────────
//
// One GQL call per invocation. Skips targets whose nft_id won't fit Int range
// (defensive — current AllDay nft_ids are ~10M, nowhere near 2^31, but keep
// the filter so a future widening doesn't silently 422 the whole batch).

async function fetchSerialsAllDay(targets: BackfillTarget[]): Promise<Map<string, FetchResult>> {
  const out = new Map<string, FetchResult>();
  const numericIds: number[] = [];
  for (const t of targets) {
    const n = Number(t.nft_id);
    if (Number.isFinite(n) && n > 0 && n < 2_147_483_647) {
      numericIds.push(n);
    } else {
      out.set(t.nft_id, { serial: null, reason: "unknown", detail: `nft_id_out_of_int_range:${t.nft_id}` });
    }
  }
  if (numericIds.length === 0) return out;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "rip-packs-city/sales-serial-backfill",
  };
  if (TS_PROXY_SECRET) headers["X-Proxy-Secret"] = TS_PROXY_SECRET;

  let res: Response;
  try {
    res = await fetch(ALLDAY_CONSUMER_PROXY_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: ALLDAY_GQL_QUERY, variables: { ids: numericIds } }),
      signal: AbortSignal.timeout(ALLDAY_GQL_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const reason = (msg.includes("aborted") || msg.toLowerCase().includes("timeout")) ? "timeout" : "unknown";
    for (const t of targets) {
      if (!out.has(t.nft_id)) out.set(t.nft_id, { serial: null, reason, detail: `allday-batch:${msg.slice(0, 120)}` });
    }
    return out;
  }

  if (!res.ok) {
    let bodySnippet = "";
    try { bodySnippet = (await res.text()).slice(0, 200).replace(/\s+/g, " "); } catch { /* ignore */ }
    const reason = res.status === 404 ? "gql_404" : "unknown";
    const detail = `http_${res.status}${bodySnippet ? `:${bodySnippet}` : ""}`;
    for (const t of targets) {
      if (!out.has(t.nft_id)) out.set(t.nft_id, { serial: null, reason, detail });
    }
    return out;
  }

  let json: any;
  try { json = await res.json(); }
  catch (err) {
    const detail = `json_parse:${err instanceof Error ? err.message.slice(0, 80) : "err"}`;
    for (const t of targets) {
      if (!out.has(t.nft_id)) out.set(t.nft_id, { serial: null, reason: "unknown", detail });
    }
    return out;
  }

  // GQL-level errors (top-level errors[]). Apply same reason/detail to every
  // target in this batch since the failure is shared.
  if (Array.isArray(json?.errors) && json.errors.length > 0) {
    const detail = `gql_errors:${json.errors.map((e: any) => e?.message ?? "?").join("; ").slice(0, 200)}`;
    for (const t of targets) {
      if (!out.has(t.nft_id)) out.set(t.nft_id, { serial: null, reason: "unknown", detail });
    }
    return out;
  }

  // Build flowID → serial map from the response.
  const edges = json?.data?.searchMomentNFTsV2?.edges ?? [];
  const serialByFlowId = new Map<string, number>();
  for (const edge of edges) {
    const node = edge?.node;
    if (!node) continue;
    const flowID = node.flowID != null ? String(node.flowID) : null;
    const raw = node.serialNumber;
    const serial = raw != null ? Number(raw) : null;
    if (flowID && serial != null && Number.isFinite(serial) && serial > 0) {
      serialByFlowId.set(flowID, serial);
    }
  }

  for (const t of targets) {
    if (out.has(t.nft_id)) continue;
    const serial = serialByFlowId.get(t.nft_id);
    if (serial != null) {
      out.set(t.nft_id, { serial, reason: "ok", detail: null });
    } else {
      out.set(t.nft_id, { serial: null, reason: "gql_null_serial", detail: "not_in_batch_response" });
    }
  }

  return out;
}

// ── Per-target write path (shared) ───────────────────────────────────────────

interface CollectionStats {
  processed: number;
  resolved: number;
  noop: number;
  failed: number;
  failures_by_reason: Record<string, number>;
}

async function applyResult(
  target: BackfillTarget,
  result: FetchResult,
  stats: CollectionStats,
): Promise<void> {
  stats.processed += 1;
  if (result.reason === "ok" && result.serial != null) {
    const { data: updated, error: updErr } = await supabase.rpc("update_sale_serial", {
      p_sale_id: target.sale_id,
      p_serial_number: result.serial,
    });
    if (updErr) {
      stats.failed += 1;
      stats.failures_by_reason["unknown"] = (stats.failures_by_reason["unknown"] ?? 0) + 1;
      await supabase.rpc("record_serial_backfill_failure", {
        p_sale_id: target.sale_id,
        p_collection_id: target.collection_id,
        p_nft_id: target.nft_id,
        p_reason: "unknown",
        p_detail: `update_rpc:${updErr.message.slice(0, 200)}`,
      });
    } else if (updated === true) {
      stats.resolved += 1;
    } else {
      stats.noop += 1;
    }
  } else {
    stats.failed += 1;
    stats.failures_by_reason[result.reason] = (stats.failures_by_reason[result.reason] ?? 0) + 1;
    const { error: failErr } = await supabase.rpc("record_serial_backfill_failure", {
      p_sale_id: target.sale_id,
      p_collection_id: target.collection_id,
      p_nft_id: target.nft_id,
      p_reason: result.reason,
      p_detail: result.detail,
    });
    if (failErr) console.log(`[backfill] failure-record err ${failErr.message.slice(0, 120)}`);
  }
}

async function runCollection(collectionId: string, batchSize: number): Promise<CollectionStats> {
  // batchSize is the total cap of targets processed per invocation. Trevor's
  // manual full-backfill loop just calls this repeatedly; the 24h cooldown in
  // get_serial_backfill_targets ensures re-runs don't re-touch failed targets.
  const stats: CollectionStats = {
    processed: 0,
    resolved: 0,
    noop: 0,
    failed: 0,
    failures_by_reason: {},
  };

  const { data, error } = await supabase.rpc("get_serial_backfill_targets", {
    p_collection_id: collectionId,
    p_limit: batchSize,
    p_offset: 0,
  });
  if (error) {
    console.log(`[backfill] rpc err collection=${collectionId} ${error.message}`);
    return stats;
  }
  const targets = (data ?? []) as BackfillTarget[];
  if (targets.length === 0) return stats;

  if (collectionId === COLLECTION_IDS.allday) {
    // One batched GQL call for the whole batch.
    const resultMap = await fetchSerialsAllDay(targets);
    for (const t of targets) {
      const r = resultMap.get(t.nft_id) ?? { serial: null, reason: "unknown" as const, detail: "missing_from_result_map" };
      try { await applyResult(t, r, stats); }
      catch (err) {
        stats.failed += 1;
        stats.failures_by_reason["unknown"] = (stats.failures_by_reason["unknown"] ?? 0) + 1;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[backfill] write err sale=${t.sale_id} ${msg.slice(0, 200)}`);
        await supabase.rpc("record_serial_backfill_failure", {
          p_sale_id: t.sale_id,
          p_collection_id: t.collection_id,
          p_nft_id: t.nft_id,
          p_reason: "unknown",
          p_detail: msg.slice(0, 200),
        }).catch(() => { /* swallow */ });
      }
    }
  } else if (collectionId === COLLECTION_IDS.topshot) {
    // One GQL call per target with a tiny throttle.
    for (const t of targets) {
      try {
        const r = await fetchSerialTopShot(t);
        await applyResult(t, r, stats);
      } catch (err) {
        stats.failed += 1;
        stats.failures_by_reason["unknown"] = (stats.failures_by_reason["unknown"] ?? 0) + 1;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[backfill] err sale=${t.sale_id} ${msg.slice(0, 200)}`);
        await supabase.rpc("record_serial_backfill_failure", {
          p_sale_id: t.sale_id,
          p_collection_id: t.collection_id,
          p_nft_id: t.nft_id,
          p_reason: "unknown",
          p_detail: msg.slice(0, 200),
        }).catch(() => { /* swallow */ });
      }
      await sleep(REQ_THROTTLE_MS);
    }
  } else {
    console.log(`[backfill] unsupported collection=${collectionId}`);
  }

  console.log(
    `[backfill] done collection=${collectionId} processed=${stats.processed} resolved=${stats.resolved} noop=${stats.noop} failed=${stats.failed}`,
  );
  return stats;
}

async function runSweep(collectionId: string | null, batchSize: number) {
  const list = collectionId ? [collectionId] : [COLLECTION_IDS.topshot, COLLECTION_IDS.allday];
  for (const c of list) {
    try {
      await runCollection(c, batchSize);
    } catch (err) {
      console.log(`[backfill] fatal collection=${c}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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

  let body: { collection_id?: string; batch_size?: number } = {};
  if (req.method === "POST") {
    try { body = await req.json(); } catch { /* empty body is fine */ }
  }

  const collectionId = body.collection_id ?? null;
  if (collectionId && collectionId !== COLLECTION_IDS.topshot && collectionId !== COLLECTION_IDS.allday) {
    return new Response(
      JSON.stringify({
        error: `collection_id ${collectionId} is not eligible for serial backfill (only TopShot + AllDay)`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const batchSize = clampInt(body.batch_size ?? DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE);
  const startedAt = new Date().toISOString();

  const work = (async () => {
    try { await runSweep(collectionId, batchSize); }
    catch (err) { console.log(`[backfill] fatal: ${err instanceof Error ? err.message : String(err)}`); }
  })();

  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er && typeof er.waitUntil === "function") er.waitUntil(work);
  else await work;

  return new Response(
    JSON.stringify({
      status: "accepted",
      collection_id: collectionId ?? "all",
      batch_size: batchSize,
      started_at: startedAt,
    }),
    { status: 202, headers: { "Content-Type": "application/json" } },
  );
});

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
