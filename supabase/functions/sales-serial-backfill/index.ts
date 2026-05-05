// supabase/functions/sales-serial-backfill/index.ts
// Phase 2A. Re-resolve serial_number for historical sales rows that landed
// with serial_number = 0 because of the sales-indexer regression fixed in
// commit 55566e3. Every target row carries a working nft_id + edition_id
// + transaction_hash, so the original GQL operation now reads flowSerialNumber
// correctly for every moment that is still resolvable.
//
// Trigger: ad-hoc via curl (one-shot, NOT cron). Returns 202 immediately and
// processes the queue asynchronously via EdgeRuntime.waitUntil() when
// available. Re-runs are safe — update_sale_serial only updates if the
// current value is 0 and the GQL response is a valid positive integer.
//
// Auth: Authorization header must contain INGEST_SECRET_TOKEN (or pass it
// as ?token=<value>). Same pattern as special-serial-sweep.
//
// Input body (all optional):
//   { collection_id?: string, batch_size?: number }
//
// Per-collection routing:
//   TopShot → topshot-proxy worker /topshot route   (public-api.nbatopshot.com)
//   AllDay  → topshot-proxy worker /allday-consumer (nflallday.com/consumer/graphql)
// Both go through the same Cloudflare worker because both upstreams' WAF
// blocks Supabase Edge egress IPs. AllDay has two non-overlapping GraphQL
// schemas: public-api.nflallday.com/graphql (used by sniper-feed via the
// /allday route for searchMomentNFTsV2 / searchPackNFTsV2) and
// nflallday.com/consumer/graphql (used here, only place flowSerialNumber
// lives). The two routes share the same X-Proxy-Secret — single rotation
// surface. Don't conflate the schemas.

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
// New worker route added alongside /topshot and /allday — forwards to
// nflallday.com/consumer/graphql so getMintedMoment resolves from cloud egress.
// Same X-Proxy-Secret as the other routes.
const ALLDAY_CONSUMER_PROXY_URL = Deno.env.get("ALLDAY_CONSUMER_PROXY_URL")
  ?? "https://topshot-proxy.tdillonbond.workers.dev/allday-consumer";

const REQ_THROTTLE_MS = 50;     // ~20 req/s ceiling per upstream.
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1000;    // hard cap so a single invocation stays well under the edge function wall-clock budget.
const REQUEST_TIMEOUT_MS = 8_000;

const COLLECTION_IDS = {
  topshot: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  allday:  "dee28451-5d62-409e-a1ad-a83f763ac070",
} as const;

// flowSerialNumber sits directly on the MintedMoment payload. The two upstreams
// model the wrapping `data` field differently, so we need two query shapes:
//
// TopShot (public-api.nbatopshot.com): `data` is a union, requires `... on
//   MintedMoment` fragment. Mirrors app/api/sales-indexer/route.ts ~line 402.
const GQL_QUERY_TOPSHOT = `query($id:ID!){getMintedMoment(momentId:$id){data{...on MintedMoment{flowSerialNumber}}}}`;
//
// AllDay (nflallday.com/consumer/graphql): `data` is a direct MintedMoment
//   type, the union fragment is rejected with 422. Mirrors the shape used by
//   app/api/allday-wallet-search/route.ts and lib/alldayGraphql.ts callers.
const GQL_QUERY_ALLDAY = `query($id:ID!){getMintedMoment(momentId:$id){data{flowSerialNumber}}}`;

interface BackfillTarget {
  sale_id: string;
  collection_id: string;
  nft_id: string;
  edition_id: string;
  sold_at: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Endpoint {
  url: string;
  label: string;
  /** Both routes are fronted by the same Cloudflare worker and share PROXY_SECRET. */
  proxyAuth: boolean;
  /** Endpoint-specific query string; the two upstreams model `data` differently. */
  query: string;
}

function endpointFor(collectionId: string): Endpoint | null {
  if (collectionId === COLLECTION_IDS.topshot) return { url: TS_PROXY_URL, label: "topshot", proxyAuth: true, query: GQL_QUERY_TOPSHOT };
  if (collectionId === COLLECTION_IDS.allday) return { url: ALLDAY_CONSUMER_PROXY_URL, label: "allday-consumer", proxyAuth: true, query: GQL_QUERY_ALLDAY };
  return null;
}

interface FetchResult {
  serial: number | null;
  reason: "ok" | "gql_404" | "gql_null_serial" | "timeout" | "unknown";
  detail: string | null;
}

async function fetchSerial(target: BackfillTarget): Promise<FetchResult> {
  const endpoint = endpointFor(target.collection_id);
  if (!endpoint) return { serial: null, reason: "unknown", detail: `no_endpoint_for_collection_${target.collection_id}` };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "rip-packs-city/sales-serial-backfill",
  };
  if (endpoint.proxyAuth && TS_PROXY_SECRET) headers["X-Proxy-Secret"] = TS_PROXY_SECRET;

  let res: Response;
  try {
    res = await fetch(endpoint.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: endpoint.query, variables: { id: target.nft_id } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("aborted") || msg.toLowerCase().includes("timeout")) {
      return { serial: null, reason: "timeout", detail: `${endpoint.label}:${msg.slice(0, 120)}` };
    }
    return { serial: null, reason: "unknown", detail: `${endpoint.label}:${msg.slice(0, 120)}` };
  }

  if (!res.ok) {
    // Capture a snippet of the response body so GQL validation errors (422 etc)
    // don't have to be re-debugged from a 4xx code alone. Body read is fire-
    // and-forget — errors here just leave detail at the bare http code.
    let bodySnippet = "";
    try {
      const txt = await res.text();
      bodySnippet = txt.slice(0, 160).replace(/\s+/g, " ");
    } catch { /* ignore */ }
    if (res.status === 404) return { serial: null, reason: "gql_404", detail: `http_${res.status}${bodySnippet ? `:${bodySnippet}` : ""}` };
    return { serial: null, reason: "unknown", detail: `http_${res.status}${bodySnippet ? `:${bodySnippet}` : ""}` };
  }

  let json: any;
  try {
    json = await res.json();
  } catch (err) {
    return { serial: null, reason: "unknown", detail: `json_parse:${err instanceof Error ? err.message.slice(0, 80) : "err"}` };
  }

  const data = json?.data?.getMintedMoment?.data;
  // 200 OK with no MintedMoment means the moment exists on-chain but isn't in
  // the GQL index. Classify as gql_null_serial — same bucket as the case where
  // flowSerialNumber itself is null. The 24h cooldown on this reason keeps the
  // queue from spinning on permanently-missing moments.
  if (!data) return { serial: null, reason: "gql_null_serial", detail: "no_minted_moment" };

  const raw = data.flowSerialNumber;
  if (raw == null) return { serial: null, reason: "gql_null_serial", detail: null };

  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return { serial: null, reason: "gql_null_serial", detail: `raw=${String(raw).slice(0, 40)}` };
  }
  return { serial: n, reason: "ok", detail: null };
}

interface CollectionStats {
  pages: number;
  processed: number;
  resolved: number;
  noop: number;
  failed: number;
  failures_by_reason: Record<string, number>;
}

async function runCollection(collectionId: string, batchSize: number): Promise<CollectionStats> {
  // batchSize is the total cap of targets processed per invocation, NOT a page
  // size to paginate through. The cooldown logic in get_serial_backfill_targets
  // ensures re-running the function never re-touches the same target within
  // 24h, so Trevor's manual full-backfill loop just calls this repeatedly.
  const stats: CollectionStats = {
    pages: 0,
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
  stats.pages = 1;

  for (const t of targets) {
    stats.processed += 1;
    try {
      const result = await fetchSerial(t);
      if (result.reason === "ok" && result.serial != null) {
        const { data: updated, error: updErr } = await supabase.rpc("update_sale_serial", {
          p_sale_id: t.sale_id,
          p_serial_number: result.serial,
        });
        if (updErr) {
          stats.failed += 1;
          stats.failures_by_reason["unknown"] = (stats.failures_by_reason["unknown"] ?? 0) + 1;
          await supabase.rpc("record_serial_backfill_failure", {
            p_sale_id: t.sale_id,
            p_collection_id: t.collection_id,
            p_nft_id: t.nft_id,
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
          p_sale_id: t.sale_id,
          p_collection_id: t.collection_id,
          p_nft_id: t.nft_id,
          p_reason: result.reason,
          p_detail: result.detail,
        });
        if (failErr) console.log(`[backfill] failure-record err ${failErr.message.slice(0, 120)}`);
      }
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
      });
    }
    await sleep(REQ_THROTTLE_MS);
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
  if (collectionId && !endpointFor(collectionId)) {
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
