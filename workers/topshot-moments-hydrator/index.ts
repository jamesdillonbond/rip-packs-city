// workers/topshot-moments-hydrator/index.ts
//
// Hydrates the public.moments table with metadata for pulled Top Shot
// moments. Reads v_moments_needing_hydration (pack_pull rows in
// moment_acquisitions that have no matching moments row yet), calls Top
// Shot public-api GraphQL via the topshot-proxy worker to fetch
// (flowSerialNumber, play.id+flowID, set.id+flowId) for each nft_id,
// resolves the corresponding editions row by (set_id_onchain,
// play_id_onchain), and upserts into moments keyed on nft_id.
//
// Auth:    POST /         Bearer INGEST_SECRET_TOKEN
// Health:  GET  /health   unauthenticated; returns {ok: true}
//
// GraphQL strategy (verified against existing repo callers — NOT
// hallucinated). Three production callers establish the shape:
//   * app/api/sales-indexer/route.ts:402 — proves
//     `getMintedMoment(momentId: ID!) { data { ... on MintedMoment { ... } } }`
//     and the `... on Play { id }` / `... on Set { id flowSeriesNumber }`
//     fragment pattern.
//   * lib/editions-hydrate.ts:78-94 — proves `set.flowId` (lowercase d)
//     and `play.flowID` (uppercase D) are valid fields on the public-api
//     Play / Set types. These are the on-chain integer IDs (returned as
//     strings) needed to match editions.{set_id_onchain, play_id_onchain}.
//   * supabase/functions/sales-serial-backfill/index.ts:61 — proves the
//     topshot-proxy `/topshot` route + X-Proxy-Secret header path works
//     for getMintedMoment from a non-Vercel egress (Cloudflare/Supabase).
//
// The spec asks for 6 parallel GraphQL calls each carrying 50 ids — and
// `getMintedMoment` takes a single id per call. We therefore use
// GraphQL aliases to fan 50 single-id lookups into one POST body per
// chunk. Standard GraphQL feature, no schema extension required.
//
// Response shape (always 200, even on per-chunk failure):
//   {
//     ok: boolean,                       // false iff anything errored
//     candidates_read: int,              // rows returned by v_moments_needing_hydration
//     fetched_from_graphql: int,         // moments with a non-null GQL data block
//     editions_resolved: int,            // moments whose (set,play) found an editions row
//     moments_upserted: int,             // rows the moments upsert actually wrote
//     edition_resolution_failures: int,  // GQL-fetched but no editions row matched
//     graphql_failures: int,             // GQL returned null data for an nft_id
//     duration_ms: int,
//     errors?: [{ source, message }],
//   }

import { createClient, SupabaseClient } from "@supabase/supabase-js";

interface Env {
  INGEST_SECRET_TOKEN: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  // Service binding to the topshot-proxy worker. Worker-to-worker fetch over
  // the public *.workers.dev URL hits Cloudflare error 1042; the binding
  // routes internally and bypasses the edge. See wrangler.toml [[services]].
  TOPSHOT_PROXY: Fetcher;
  TS_PROXY_SECRET: string;
}

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";
const TOPSHOT_COLLECTION_SLUG = "nba_top_shot";
const CANDIDATES_PER_RUN = 300;
const CHUNK_SIZE = 50;
const NUM_CHUNKS = CANDIDATES_PER_RUN / CHUNK_SIZE; // 6
const GQL_TIMEOUT_MS = 15_000;

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

function jsonError(status: number, error: string, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error, ...extra }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function healthOk(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      worker: "topshot-moments-hydrator",
      candidates_per_run: CANDIDATES_PER_RUN,
      chunk_size: CHUNK_SIZE,
      collection_id: TOPSHOT_COLLECTION_ID,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate read
// ─────────────────────────────────────────────────────────────────────────────

interface Candidate {
  nft_id: string;
  owner_address: string | null;
  source_pack_rip_id: string | null;
}

async function readCandidates(sb: SupabaseClient): Promise<Candidate[]> {
  const { data, error } = await sb
    .from("v_moments_needing_hydration")
    .select("nft_id, owner_address, source_pack_rip_id, acquired_date")
    .eq("collection_id", TOPSHOT_COLLECTION_ID)
    .order("acquired_date", { ascending: false })
    .limit(CANDIDATES_PER_RUN);
  if (error) throw new Error(`v_moments_needing_hydration select: ${error.message}`);
  const rows = (data ?? []) as Array<{
    nft_id: string;
    owner_address: string | null;
    source_pack_rip_id: string | null;
  }>;
  return rows.map((r) => ({
    nft_id: r.nft_id,
    owner_address: r.owner_address,
    source_pack_rip_id: r.source_pack_rip_id,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Top Shot GraphQL — aliased getMintedMoment, 50 per request
// ─────────────────────────────────────────────────────────────────────────────

interface GqlMoment {
  nft_id: string;
  flowSerialNumber: number | null;
  set_id_onchain: number | null;
  play_id_onchain: number | null;
  owner_address: string | null;
}

function buildAliasedQuery(count: number): string {
  // One alias per id. `... on MintedMoment` mirrors sales-indexer; the
  // `... on Play` / `... on Set` fragments mirror the same pattern. Each
  // aliased lookup pulls the four fields we need: serial, set.flowId,
  // play.flowID. We do NOT request owner here — getMintedMoment doesn't
  // surface a stable owner field across all schema versions; we fall back
  // to the view's owner_address (which came from the on-chain Deposit
  // event captured by pack-events-ingest).
  const varDecls: string[] = [];
  const aliases: string[] = [];
  for (let i = 0; i < count; i++) {
    varDecls.push(`$id${i}: ID!`);
    aliases.push(
      `m${i}: getMintedMoment(momentId: $id${i}) {
        data {
          ... on MintedMoment {
            flowSerialNumber
            play { ... on Play { flowID } }
            set { ... on Set { flowId } }
          }
        }
      }`,
    );
  }
  return `query Hydrate(${varDecls.join(", ")}) {\n${aliases.join("\n")}\n}`;
}

function parseIntOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

async function fetchChunk(
  env: Env,
  chunk: Candidate[],
): Promise<{ moments: GqlMoment[]; errorMsg: string | null }> {
  if (chunk.length === 0) return { moments: [], errorMsg: null };

  const query = buildAliasedQuery(chunk.length);
  const variables: Record<string, string> = {};
  for (let i = 0; i < chunk.length; i++) variables[`id${i}`] = chunk[i].nft_id;

  let res: Response;
  try {
    // Service binding fetch. The hostname in the Request URL is ignored —
    // Cloudflare routes via the TOPSHOT_PROXY binding, not the URL. The path
    // ("/topshot") still matters because the proxy uses it to pick the
    // upstream from UPSTREAM_MAP. X-Proxy-Secret is still validated by the
    // proxy on incoming requests.
    res = await env.TOPSHOT_PROXY.fetch(
      new Request("https://internal/topshot", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Proxy-Secret": env.TS_PROXY_SECRET,
          "User-Agent": "topshot-moments-hydrator/0.1",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(GQL_TIMEOUT_MS),
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { moments: [], errorMsg: `gql fetch: ${msg.slice(0, 200)}` };
  }

  if (!res.ok) {
    let body = "";
    try { body = (await res.text()).slice(0, 200).replace(/\s+/g, " "); } catch { /* ignore */ }
    return { moments: [], errorMsg: `gql HTTP ${res.status}: ${body}` };
  }

  let json: { data?: Record<string, { data?: { flowSerialNumber?: unknown; play?: { flowID?: unknown } | null; set?: { flowId?: unknown } | null } | null }>; errors?: unknown[] };
  try {
    json = await res.json();
  } catch (err) {
    return { moments: [], errorMsg: `gql json parse: ${err instanceof Error ? err.message.slice(0, 120) : "err"}` };
  }

  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const detail = json.errors
      .map((e) => (typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : "?"))
      .join("; ")
      .slice(0, 300);
    return { moments: [], errorMsg: `gql errors: ${detail}` };
  }

  const moments: GqlMoment[] = [];
  for (let i = 0; i < chunk.length; i++) {
    const node = json.data?.[`m${i}`]?.data ?? null;
    if (!node) {
      moments.push({
        nft_id: chunk[i].nft_id,
        flowSerialNumber: null,
        set_id_onchain: null,
        play_id_onchain: null,
        owner_address: chunk[i].owner_address,
      });
      continue;
    }
    moments.push({
      nft_id: chunk[i].nft_id,
      flowSerialNumber: parseIntOrNull(node.flowSerialNumber),
      set_id_onchain: parseIntOrNull(node.set?.flowId),
      play_id_onchain: parseIntOrNull(node.play?.flowID),
      owner_address: chunk[i].owner_address,
    });
  }
  return { moments, errorMsg: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Edition resolution — one batched select against editions
// ─────────────────────────────────────────────────────────────────────────────

interface EditionRow {
  id: string;
  set_id_onchain: number;
  play_id_onchain: number;
}

async function resolveEditions(
  sb: SupabaseClient,
  pairs: Array<{ set_id_onchain: number; play_id_onchain: number }>,
): Promise<Map<string, string>> {
  // Map key: `${set_id_onchain}:${play_id_onchain}` → edition uuid.
  const out = new Map<string, string>();
  if (pairs.length === 0) return out;

  // Dedup pairs first — the same edition can back many moments in this batch.
  const uniqByKey = new Map<string, { set_id_onchain: number; play_id_onchain: number }>();
  for (const p of pairs) uniqByKey.set(`${p.set_id_onchain}:${p.play_id_onchain}`, p);
  const uniq = [...uniqByKey.values()];

  // PostgREST .or() with one `and(set_id_onchain.eq.X,play_id_onchain.eq.Y)`
  // term per pair — same pattern as pack-events-ingest's placeholder delete.
  // Bounded by CANDIDATES_PER_RUN distinct editions = at most 300 OR-terms,
  // typical run hits the same handful of editions (1-20 per pack format).
  const orFilter = uniq
    .map((p) => `and(set_id_onchain.eq.${p.set_id_onchain},play_id_onchain.eq.${p.play_id_onchain})`)
    .join(",");

  const { data, error } = await sb
    .from("editions")
    .select("id, set_id_onchain, play_id_onchain")
    .eq("collection_id", TOPSHOT_COLLECTION_ID)
    .or(orFilter);
  if (error) throw new Error(`editions select (${uniq.length} pairs): ${error.message}`);

  for (const row of (data ?? []) as EditionRow[]) {
    out.set(`${row.set_id_onchain}:${row.play_id_onchain}`, row.id);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Moments upsert
// ─────────────────────────────────────────────────────────────────────────────

interface MomentRow {
  nft_id: string;
  collection_id: string;
  edition_id: string;
  serial_number: number;
  owner_address: string | null;
  is_listed: boolean;
  collection: string;
}

async function upsertMoments(sb: SupabaseClient, rows: MomentRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  // ON CONFLICT (nft_id) — moments_nft_id_key is the unique constraint per
  // spec. updated_at is maintained by a row-level trigger on the moments
  // table; we don't set it here.
  const { data, error } = await sb
    .from("moments")
    .upsert(rows, { onConflict: "nft_id" })
    .select("id");
  if (error) throw new Error(`moments upsert (${rows.length} rows): ${error.message}`);
  return data?.length ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entrypoint
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const startedMs = Date.now();
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
        return healthOk();
      }
      if (request.method !== "POST" || url.pathname !== "/") {
        return jsonError(405, "method_or_path_not_allowed", {
          hint: "POST / with Bearer INGEST_SECRET_TOKEN; GET /health for liveness",
        });
      }

      const auth = request.headers.get("Authorization") ?? "";
      const expected = `Bearer ${env.INGEST_SECRET_TOKEN}`;
      if (!env.INGEST_SECRET_TOKEN || auth !== expected) {
        return jsonError(401, "unauthorized");
      }
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        return jsonError(500, "supabase_env_missing");
      }
      if (!env.TOPSHOT_PROXY || !env.TS_PROXY_SECRET) {
        return jsonError(500, "ts_proxy_env_missing");
      }

      const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const errors: Array<{ source: string; message: string }> = [];

      // ── 1. Read candidates ────────────────────────────────────────────
      let candidates: Candidate[] = [];
      try {
        candidates = await readCandidates(sb);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[topshot-moments-hydrator] candidate read fatal: ${msg}`);
        return new Response(
          JSON.stringify({
            ok: false,
            candidates_read: 0,
            fetched_from_graphql: 0,
            editions_resolved: 0,
            moments_upserted: 0,
            edition_resolution_failures: 0,
            graphql_failures: 0,
            duration_ms: Date.now() - startedMs,
            errors: [{ source: "candidate_read", message: msg }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (candidates.length === 0) {
        return new Response(
          JSON.stringify({
            ok: true,
            candidates_read: 0,
            fetched_from_graphql: 0,
            editions_resolved: 0,
            moments_upserted: 0,
            edition_resolution_failures: 0,
            graphql_failures: 0,
            duration_ms: Date.now() - startedMs,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // ── 2. Chunk into NUM_CHUNKS groups of CHUNK_SIZE, fetch in parallel ─
      const chunks: Candidate[][] = [];
      for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
        chunks.push(candidates.slice(i, i + CHUNK_SIZE));
      }
      // Cap concurrency at NUM_CHUNKS even if candidates < CANDIDATES_PER_RUN
      // (no-op when candidates fill the budget). Keeps subrequest count
      // bounded if the view's "needs hydration" pool is huge.
      while (chunks.length > NUM_CHUNKS) chunks.pop();

      const chunkResults = await Promise.all(chunks.map((c) => fetchChunk(env, c)));
      const allMoments: GqlMoment[] = [];
      for (const r of chunkResults) {
        if (r.errorMsg) errors.push({ source: "graphql", message: r.errorMsg });
        for (const m of r.moments) allMoments.push(m);
      }

      const resolvable = allMoments.filter(
        (m) =>
          m.flowSerialNumber !== null &&
          m.flowSerialNumber > 0 &&
          m.set_id_onchain !== null &&
          m.play_id_onchain !== null,
      );
      const graphqlFailures = allMoments.length - resolvable.length;
      const fetchedFromGraphql = resolvable.length;

      // ── 3. Resolve editions in one batched select ─────────────────────
      let editionMap = new Map<string, string>();
      if (resolvable.length > 0) {
        try {
          editionMap = await resolveEditions(
            sb,
            resolvable.map((m) => ({
              set_id_onchain: m.set_id_onchain as number,
              play_id_onchain: m.play_id_onchain as number,
            })),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`[topshot-moments-hydrator] editions resolve error: ${msg}`);
          errors.push({ source: "editions", message: msg });
        }
      }

      // ── 4. Build moment rows; skip rows whose edition didn't resolve ──
      const momentRows: MomentRow[] = [];
      let editionResolutionFailures = 0;
      for (const m of resolvable) {
        const key = `${m.set_id_onchain}:${m.play_id_onchain}`;
        const editionId = editionMap.get(key);
        if (!editionId) {
          editionResolutionFailures++;
          errors.push({
            source: "edition_resolution",
            message: `no editions row for nft_id=${m.nft_id} set_id_onchain=${m.set_id_onchain} play_id_onchain=${m.play_id_onchain}`,
          });
          continue;
        }
        momentRows.push({
          nft_id: m.nft_id,
          collection_id: TOPSHOT_COLLECTION_ID,
          edition_id: editionId,
          serial_number: m.flowSerialNumber as number,
          owner_address: m.owner_address,
          is_listed: false,
          collection: TOPSHOT_COLLECTION_SLUG,
        });
      }
      const editionsResolved = momentRows.length;

      // ── 5. Upsert into moments ────────────────────────────────────────
      let momentsUpserted = 0;
      if (momentRows.length > 0) {
        try {
          momentsUpserted = await upsertMoments(sb, momentRows);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`[topshot-moments-hydrator] moments upsert error: ${msg}`);
          errors.push({ source: "moments_upsert", message: msg });
        }
      }

      return new Response(
        JSON.stringify({
          ok: errors.length === 0,
          candidates_read: candidates.length,
          fetched_from_graphql: fetchedFromGraphql,
          editions_resolved: editionsResolved,
          moments_upserted: momentsUpserted,
          edition_resolution_failures: editionResolutionFailures,
          graphql_failures: graphqlFailures,
          duration_ms: Date.now() - startedMs,
          ...(errors.length > 0 ? { errors } : {}),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    } catch (err) {
      // Fatal pre-processing error — still return 200 so cron-job.org
      // keeps retrying without flagging the job.
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[topshot-moments-hydrator] fatal: ${msg}`);
      return new Response(
        JSON.stringify({
          ok: false,
          candidates_read: 0,
          fetched_from_graphql: 0,
          editions_resolved: 0,
          moments_upserted: 0,
          edition_resolution_failures: 0,
          graphql_failures: 0,
          duration_ms: Date.now() - startedMs,
          errors: [{ source: "pre_processing", message: msg }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
  },
};
