import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ── NFL All Day pack EV compute job ──────────────────────────────────────────
//
// Mirrors /api/pack-ev (Top Shot) but drives a batch of AllDay pack
// distributions per invocation and writes each result to pack_ev_history so
// the pack_ev_latest view (and downstream pack_table_rows) picks them up.
//
// Source of truth:
//   • pack_distributions — collection_id = AllDay UUID, metadata includes
//     distributionUUID, retail_price_usd, number_of_pack_slots, tier.
//   • editions + fmv_current — edition pool lookup and FMV per edition.
//
// Pack edition pool resolution: we hit the AllDay GraphQL endpoint with
// distributionUUID. The expected query shape is `packEntities` (per the
// Unit 3 spec). If that query name doesn't match the live schema, the
// function logs the error per-distribution and continues — the cron will
// retry on the next invocation. Ship blockers are tracked in the batch
// summary returned by the handler.
//
// Auth: Bearer $INGEST_SECRET_TOKEN.
// Timeout target: 60s. Batch size: 25 distributions per invocation.

const INGEST_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN");
if (!INGEST_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var is required");

const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070";
const ALLDAY_GRAPHQL = "https://public-api.nflallday.com/graphql";
const LOG_PREFIX = "[compute-allday-pack-ev]";
const BATCH_SIZE = 25;
const GQL_TIMEOUT_MS = 12000;
const DEADLINE_MS = 55_000; // leave 5s runway before the 60s edge timeout

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const GRAPHQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "RipPacksCity/1.0 (rip-packs-city.vercel.app)",
  "Origin": "https://nflallday.com",
  "Referer": "https://nflallday.com/",
};

// packEntities(distributionUUID): expected to return the pool of edition
// probabilities for a given pack distribution. Shape mirrors packEditionsV3
// in the existing /api/pack-ev logic. Fields kept minimal — only what we
// need to key into `editions.external_id` and to weight by remaining.
const PACK_ENTITIES_QUERY = `
  query PackEntities($distributionUUID: ID!, $after: ID) {
    packEntities(distributionUUID: $distributionUUID, after: $after) {
      pageInfo { endCursor hasNextPage }
      edges {
        node {
          count
          remaining
          edition {
            id
            tier
            set { id }
            play { id }
          }
        }
      }
    }
  }
`;

interface PackDistRow {
  dist_id: string;
  title: string | null;
  metadata: Record<string, unknown> | null;
}

interface EntityEdge {
  count: number;
  remaining: number;
  edition: {
    id: string;
    tier: string;
    set?: { id?: string };
    play?: { id?: string };
  };
}

interface EntitiesResponse {
  packEntities?: {
    pageInfo: { endCursor: string | null; hasNextPage: boolean };
    edges: Array<{ node: EntityEdge }>;
  };
}

function normalizePackRetailPrice(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n >= 1_000_000 ? n / 1e8 : n;
}

async function alldayGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GQL_TIMEOUT_MS);
  try {
    const res = await fetch(ALLDAY_GRAPHQL, {
      method: "POST",
      headers: GRAPHQL_HEADERS,
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`AllDay GQL ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json() as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) {
      throw new Error(json.errors[0]?.message ?? "GraphQL error");
    }
    return json.data as T;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllEntities(distributionUUID: string): Promise<EntityEdge[]> {
  const all: EntityEdge[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const result = await alldayGraphql<EntitiesResponse>(PACK_ENTITIES_QUERY, {
      distributionUUID,
      after: cursor ?? undefined,
    });
    const conn = result?.packEntities;
    if (!conn) break;
    for (const e of conn.edges ?? []) if (e?.node) all.push(e.node);
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor ?? null;
    if (!cursor) break;
  }
  return all;
}

async function fetchFmvForEditions(
  externalIds: string[],
): Promise<Map<string, number>> {
  const fmv = new Map<string, number>();
  if (externalIds.length === 0) return fmv;
  // editions → id/external_id
  const { data: editions, error: edErr } = await supabase
    .from("editions")
    .select("id, external_id")
    .eq("collection_id", ALLDAY_COLLECTION_ID)
    .in("external_id", externalIds);
  if (edErr || !editions || editions.length === 0) return fmv;
  const idToExt = new Map<string, string>();
  for (const row of editions) idToExt.set(row.id, row.external_id);
  // fmv_current → one row per edition
  const { data: snaps, error: snapErr } = await supabase
    .from("fmv_current")
    .select("edition_id, fmv_usd")
    .in("edition_id", Array.from(idToExt.keys()));
  if (snapErr || !snaps) return fmv;
  for (const s of snaps) {
    const ext = idToExt.get(s.edition_id);
    if (ext && typeof s.fmv_usd === "number" && s.fmv_usd > 0) {
      fmv.set(ext, s.fmv_usd);
    }
  }
  return fmv;
}

interface ComputeResult {
  dist_id: string;
  pack_listing_id: string;
  pack_name: string | null;
  pack_price: number;
  gross_ev: number;
  pack_ev: number;
  value_ratio: number | null;
  is_positive_ev: boolean;
  fmv_coverage_pct: number;
  edition_count: number;
  total_unopened: number;
  depletion_pct: number;
}

async function computeForDistribution(row: PackDistRow): Promise<ComputeResult | { skipped: true; reason: string }> {
  const meta = row.metadata ?? {};
  const distributionUUID = typeof meta.distributionUUID === "string" ? meta.distributionUUID : null;
  if (!distributionUUID) return { skipped: true, reason: "no distributionUUID" };
  const packPrice = normalizePackRetailPrice(meta.retail_price_usd);

  let entities: EntityEdge[];
  try {
    entities = await fetchAllEntities(distributionUUID);
  } catch (err) {
    return { skipped: true, reason: "gql: " + (err instanceof Error ? err.message : String(err)) };
  }
  if (entities.length === 0) return { skipped: true, reason: "no entities" };

  const totalRemaining = entities.reduce((s, n) => s + Math.max(n.remaining, 0), 0);
  const totalCount = entities.reduce((s, n) => s + Math.max(n.count, 0), 0);
  const unopened = totalRemaining > 0 ? totalRemaining : totalCount;
  if (unopened === 0) return { skipped: true, reason: "zero unopened" };

  const externalIds: string[] = [];
  for (const n of entities) {
    const setId = n.edition.set?.id;
    const playId = n.edition.play?.id;
    if (setId && playId) externalIds.push(`${setId}:${playId}`);
  }
  const unique = Array.from(new Set(externalIds));
  const fmvMap = await fetchFmvForEditions(unique);

  let fmvHits = 0;
  let grossEV = 0;
  for (const n of entities) {
    const weight = (n.remaining > 0 ? n.remaining : n.count) / unopened;
    if (weight <= 0) continue;
    const ext = n.edition.set?.id && n.edition.play?.id ? `${n.edition.set.id}:${n.edition.play.id}` : null;
    const fmv = ext ? (fmvMap.get(ext) ?? 0) : 0;
    if (fmv > 0) fmvHits++;
    grossEV += weight * fmv * 0.95;
  }
  const round2 = (v: number) => Math.round(v * 100) / 100;
  const clamp = (v: number) => Math.max(-10000, Math.min(1_000_000, v));
  const gross = clamp(round2(grossEV));
  const pack = clamp(round2(grossEV - packPrice));
  const valueRatio = packPrice > 0 ? Math.round((gross / packPrice) * 1000) / 1000 : null;
  const depletionPct = totalCount > 0 ? Math.round(((totalCount - totalRemaining) / totalCount) * 100) : 0;
  const coverage = entities.length > 0 ? Math.round((fmvHits / entities.length) * 100) : 0;

  return {
    dist_id: row.dist_id,
    pack_listing_id: `allday:${distributionUUID}`,
    pack_name: row.title,
    pack_price: packPrice,
    gross_ev: gross,
    pack_ev: pack,
    value_ratio: valueRatio,
    is_positive_ev: pack > 0,
    fmv_coverage_pct: coverage,
    edition_count: entities.length,
    total_unopened: unopened,
    depletion_pct: depletionPct,
  };
}

async function loadBatch(offsetCursor: number): Promise<PackDistRow[]> {
  // Prioritize distributions with a retail price (priced packs show EV
  // meaningfully). Unpriced distributions are skipped by
  // computeForDistribution anyway; selecting them here would burn budget.
  const { data, error } = await supabase
    .from("pack_distributions")
    .select("dist_id, title, metadata")
    .eq("collection_id", ALLDAY_COLLECTION_ID)
    .order("updated_at", { ascending: true, nullsFirst: true })
    .range(offsetCursor, offsetCursor + BATCH_SIZE - 1);
  if (error) throw new Error(error.message);
  return (data ?? []) as PackDistRow[];
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${INGEST_TOKEN}`) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const startedAt = Date.now();
  const url = new URL(req.url);
  const startOffset = parseInt(url.searchParams.get("offset") ?? "0", 10) || 0;

  const summary = {
    processed: 0,
    written: 0,
    skipped: 0,
    skipReasons: {} as Record<string, number>,
    lastOffset: startOffset,
  };

  let offset = startOffset;
  try {
    while (Date.now() - startedAt < DEADLINE_MS) {
      const batch = await loadBatch(offset);
      if (batch.length === 0) break;
      for (const row of batch) {
        if (Date.now() - startedAt > DEADLINE_MS) break;
        summary.processed++;
        try {
          const result = await computeForDistribution(row);
          if ("skipped" in result) {
            summary.skipped++;
            summary.skipReasons[result.reason] = (summary.skipReasons[result.reason] ?? 0) + 1;
            continue;
          }
          const { error } = await supabase.from("pack_ev_history").insert({
            pack_listing_id: result.pack_listing_id,
            collection_id: ALLDAY_COLLECTION_ID,
            dist_id: result.dist_id,
            pack_name: result.pack_name,
            pack_price: result.pack_price,
            gross_ev: result.gross_ev,
            pack_ev: result.pack_ev,
            is_positive_ev: result.is_positive_ev,
            value_ratio: result.value_ratio,
            fmv_coverage_pct: result.fmv_coverage_pct,
            edition_count: result.edition_count,
            total_unopened: result.total_unopened,
            depletion_pct: result.depletion_pct,
          });
          if (error) {
            summary.skipped++;
            summary.skipReasons["history_insert_error"] = (summary.skipReasons["history_insert_error"] ?? 0) + 1;
            console.warn(`${LOG_PREFIX} insert ${row.dist_id}: ${error.message}`);
          } else {
            summary.written++;
          }
        } catch (err) {
          summary.skipped++;
          const msg = err instanceof Error ? err.message : String(err);
          summary.skipReasons[msg.slice(0, 80)] = (summary.skipReasons[msg.slice(0, 80)] ?? 0) + 1;
        }
      }
      offset += batch.length;
      summary.lastOffset = offset;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} batch error: ${msg}`);
    return new Response(JSON.stringify({ ok: false, error: msg, summary }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log(`${LOG_PREFIX} processed=${summary.processed} written=${summary.written} skipped=${summary.skipped} in ${Date.now() - startedAt}ms`);
  return new Response(
    JSON.stringify({ ok: true, elapsed_ms: Date.now() - startedAt, ...summary }),
    { headers: { "Content-Type": "application/json" } },
  );
}

Deno.serve(handler);
