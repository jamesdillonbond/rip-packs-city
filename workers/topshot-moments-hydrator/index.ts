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
//     moments_written: int,              // rows inserted by replace_topshot_moments_batch
//     edition_resolution_failures: int,  // GQL-fetched but no editions row matched
//     graphql_failures: int,             // GQL returned null data for an nft_id
//     duration_ms: int,
//     errors?: [{ source, message }],
//   }
//
// Write path — dual-constraint conflict handling:
//   The moments table has TWO unique constraints:
//     (a) moments_nft_id_key                  on (nft_id)
//     (b) moments_edition_id_serial_number_key on (edition_id, serial_number)
//   A concurrent writer (likely the wallet_moments_cache hydrator) races us
//   for both surfaces — verified queries showed 1,276 pack-pull candidates
//   already in moments under the matching nft_id AND some (edition_id,
//   serial_number) pairs claimed by other nft_ids. The previous
//   `upsert({onConflict:'nft_id'})` only handled surface (a) and threw a
//   23505 on surface (b). We now call the server-side RPC
//   replace_topshot_moments_batch which atomically DELETEs by both lenses
//   and INSERTs our verified rows (pack-pull provenance + fresh GraphQL =
//   ground truth, so winning the race is correct).

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  type Candidate,
  type GqlMoment,
  buildAliasedQuery,
  extractPartialErrorMsg,
  parseMoments,
  isResolvable,
  editionKey,
  buildEditionOrFilter,
  computeOk,
} from "./parse";

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

// A chunk result carries three signals:
//   moments     — one entry per id (nulls for ids upstream couldn't resolve)
//   errorMsg    — telemetry string (partial gql-field errors OR a hard failure)
//   hardFailure — true only when the WHOLE fetch failed (HTTP non-200, network
//                 throw, or JSON parse): no usable data came back. Partial
//                 gql-field errors (a burned/retired moment nulling its own
//                 alias) are NOT hard failures — the other aliases still return
//                 data and must not be thrown away with it.
async function fetchChunk(
  env: Env,
  chunk: Candidate[],
): Promise<{ moments: GqlMoment[]; errorMsg: string | null; hardFailure: boolean }> {
  if (chunk.length === 0) return { moments: [], errorMsg: null, hardFailure: false };

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
    return { moments: [], errorMsg: `gql fetch: ${msg.slice(0, 200)}`, hardFailure: true };
  }

  if (!res.ok) {
    let body = "";
    try { body = (await res.text()).slice(0, 200).replace(/\s+/g, " "); } catch { /* ignore */ }
    return { moments: [], errorMsg: `gql HTTP ${res.status}: ${body}`, hardFailure: true };
  }

  let json: { data?: Record<string, { data?: { flowSerialNumber?: unknown; play?: { flowID?: unknown } | null; set?: { flowId?: unknown } | null } | null }>; errors?: unknown[] };
  try {
    json = await res.json();
  } catch (err) {
    return { moments: [], errorMsg: `gql json parse: ${err instanceof Error ? err.message.slice(0, 120) : "err"}`, hardFailure: true };
  }

  // Partial gql-field errors: aliased getMintedMoment lookups return per-alias.
  // If one id is a burned/retired/unknown moment, GraphQL nulls ONLY that alias
  // in json.data and adds one entry to json.errors — the other 49 aliases still
  // return valid data. The previous code discarded the ENTIRE chunk here, so a
  // single bad id wasted 49 good lookups and let permanently-unresolvable ids at
  // the head of v_moments_needing_hydration starve the whole queue (the observed
  // ok=false / fetched_from_graphql:0 runs). We now record the errors for
  // telemetry (extractPartialErrorMsg) but STILL parse json.data (parseMoments);
  // unresolved aliases fall through and are counted as graphql_failures, not lost.
  const partialErrMsg = extractPartialErrorMsg(json);
  const moments = parseMoments(chunk, json);
  return { moments, errorMsg: partialErrMsg, hardFailure: false };
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

  // PostgREST .or() with one `and(set_id_onchain.eq.X,play_id_onchain.eq.Y)`
  // term per DISTINCT pair — same pattern as pack-events-ingest's placeholder
  // delete. Bounded by CANDIDATES_PER_RUN distinct editions = at most 300
  // OR-terms; typical run hits the same handful of editions (1-20 per format).
  const orFilter = buildEditionOrFilter(pairs);

  const { data, error } = await sb
    .from("editions")
    .select("id, set_id_onchain, play_id_onchain")
    .eq("collection_id", TOPSHOT_COLLECTION_ID)
    .or(orFilter);
  if (error) throw new Error(`editions select: ${error.message}`);

  for (const row of (data ?? []) as EditionRow[]) {
    out.set(editionKey(row.set_id_onchain, row.play_id_onchain), row.id);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Moments write — server-side dual-constraint replace via RPC
// ─────────────────────────────────────────────────────────────────────────────

// Payload row shape sent to replace_topshot_moments_batch. The RPC owns
// collection_id (constant = TOPSHOT_COLLECTION_ID) and any other column
// defaults (is_listed, collection slug) so they don't need to ride on the
// JSON; keeps the payload tight and the constants pinned in one place.
interface MomentPayloadRow {
  nft_id: string;
  edition_id: string;
  serial_number: number;
  owner_address: string | null;
}

// RPC `replace_topshot_moments_batch(payload jsonb) RETURNS int` is LIVE in
// production (SECURITY DEFINER, search_path = public,pg_temp; execute granted to
// service_role only, revoked from public/anon). Given a JSON array of
// { nft_id, edition_id, serial_number, owner_address } rows it deletes any
// moments row colliding on the canonical nft_id key OR on the
// (edition_id, serial_number) pair, then upserts the batch — all inside one
// txn keyed on collection_id = 95f28a17-… (nba_top_shot). The current
// definition also carries two hardenings beyond the original delete-then-insert
// sketch:
//   - P8 GUARD: a `redirected` CTE rewrites edition_id to its base edition when
//     a `::`-parallel serial exceeds that printing's circulation_count, so an
//     over-circulation serial lands on the base edition instead of a phantom
//     parallel. The redirect happens BEFORE dedupe so post-redirect
//     (base, serial) collisions collapse cleanly instead of tripping the
//     INSERT … ON CONFLICT "cannot affect row a second time" error.
//   - DEDUPE: rows are de-duplicated on both the (edition_id, serial_number)
//     conflict target (tiebreak: largest nft_id = most recently minted) and on
//     nft_id, so the same NFT id can't appear twice in one batch.
// If the RPC is ever missing/renamed the call surfaces a Postgres error, which
// the worker reports via the `moments_write` error source — observable failure
// rather than a silent drop.
interface ReplaceMomentsResult {
  count: number;
  // RPC returned a Postgres-level error (function missing, permissions,
  // CHECK constraint, etc.). Caller pushes to errors[] under "moments_write".
  error?: string;
  // RPC returned a value that didn't coerce to a finite number. Should not
  // happen with the current `RETURNS int` contract but kept as a one-shot
  // shape probe so any future RETURNS-signature drift is observable rather
  // than silently producing count=0.
  unexpectedShape?: string;
}

async function replaceMomentsBatch(sb: SupabaseClient, rows: MomentPayloadRow[]): Promise<ReplaceMomentsResult> {
  if (rows.length === 0) return { count: 0 };
  const { data, error } = await sb.rpc("replace_topshot_moments_batch", { payload: rows });
  if (error) return { count: 0, error: error.message };
  // RPC is `RETURNS int` — supabase-js exposes the scalar directly on `data`
  // (no array wrap, no jsonb wrap). Number(null) is 0, Number(undefined) is
  // NaN, Number("123") is 123 — so NaN is the only ambiguous bucket we need
  // to log.
  const count = Number(data);
  if (Number.isNaN(count)) {
    let shape: string;
    try {
      shape = JSON.stringify(data).slice(0, 200);
    } catch {
      shape = `typeof=${typeof data}`;
    }
    return { count: 0, unexpectedShape: `rpc returned non-numeric: ${shape}` };
  }
  return { count };
}

// ─────────────────────────────────────────────────────────────────────────────
// pipeline_runs telemetry (2026-05-17). Single row per invocation written at
// the end with fire-and-forget semantics. The watchlist keys on
// pipeline='topshot-moments-hydrator'.
// ─────────────────────────────────────────────────────────────────────────────

const PIPELINE = "topshot-moments-hydrator";

async function logPipelineRun(
  sb: SupabaseClient,
  args: {
    startedAtIso: string;
    rowsFound: number;
    rowsWritten: number;
    rowsSkipped: number;
    ok: boolean;
    error: string | null;
    extra: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const { error } = await sb.rpc("log_pipeline_run", {
      p_pipeline: PIPELINE,
      p_started_at: args.startedAtIso,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error,
      p_collection_slug: "nba_top_shot",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: args.extra,
    });
    if (error) {
      console.log(`[${PIPELINE}] log_pipeline_run err: ${error.message}`);
    }
  } catch (err) {
    console.log(
      `[${PIPELINE}] log_pipeline_run threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
      const startedAtIso = new Date(startedMs).toISOString();

      const errors: Array<{ source: string; message: string }> = [];

      // ── 1. Read candidates ────────────────────────────────────────────
      let candidates: Candidate[] = [];
      try {
        candidates = await readCandidates(sb);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[topshot-moments-hydrator] candidate read fatal: ${msg}`);
        await logPipelineRun(sb, {
          startedAtIso,
          rowsFound: 0,
          rowsWritten: 0,
          rowsSkipped: 0,
          ok: false,
          error: `candidate_read: ${msg}`.slice(0, 500),
          extra: {
            candidates_per_run: CANDIDATES_PER_RUN,
            duration_ms: Date.now() - startedMs,
          },
        });
        return new Response(
          JSON.stringify({
            ok: false,
            candidates_read: 0,
            fetched_from_graphql: 0,
            editions_resolved: 0,
            moments_written: 0,
            edition_resolution_failures: 0,
            graphql_failures: 0,
            duration_ms: Date.now() - startedMs,
            errors: [{ source: "candidate_read", message: msg }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (candidates.length === 0) {
        const durationMs = Date.now() - startedMs;
        await logPipelineRun(sb, {
          startedAtIso,
          rowsFound: 0,
          rowsWritten: 0,
          rowsSkipped: 0,
          ok: true,
          error: null,
          extra: {
            candidates_per_run: CANDIDATES_PER_RUN,
            message: "no_candidates",
            duration_ms: durationMs,
          },
        });
        return new Response(
          JSON.stringify({
            ok: true,
            candidates_read: 0,
            fetched_from_graphql: 0,
            editions_resolved: 0,
            moments_written: 0,
            edition_resolution_failures: 0,
            graphql_failures: 0,
            duration_ms: durationMs,
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
      let hardChunkFailures = 0;
      for (const r of chunkResults) {
        if (r.hardFailure) hardChunkFailures++;
        if (r.errorMsg) errors.push({ source: "graphql", message: r.errorMsg });
        for (const m of r.moments) allMoments.push(m);
      }

      const resolvable = allMoments.filter(isResolvable);
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

      // ── 4. Build moment payload rows; skip rows whose edition didn't resolve ──
      //
      // Self-healing fallback: when the editions table has no row for a
      // (set_id_onchain, play_id_onchain) pair the catalog backfill hasn't
      // reached yet, call the SECDEF service_role RPC
      // ensure_topshot_edition_stub which atomically creates a minimal stub
      // edition row inheriting tier/series/set_name from the parent set and
      // returns the resolved uuid (or NULL when the parent set is unknown
      // too — a real catalog gap that needs human intervention).
      //
      // We dedupe RPC calls by pair key in stubResolutionCache because the
      // same (set, play) can back multiple moments in a single batch (300
      // candidates frequently span only 10-20 distinct editions).
      const momentRows: MomentPayloadRow[] = [];
      let editionResolutionFailures = 0;
      let stubsCreated = 0;
      const stubResolutionCache = new Map<string, string | null>();
      for (const m of resolvable) {
        const key = editionKey(m.set_id_onchain as number, m.play_id_onchain as number);
        let editionId = editionMap.get(key);
        if (!editionId) {
          let stubResult: string | null;
          if (stubResolutionCache.has(key)) {
            stubResult = stubResolutionCache.get(key) ?? null;
          } else {
            try {
              const { data, error } = await sb.rpc("ensure_topshot_edition_stub", {
                p_set_id_onchain: m.set_id_onchain,
                p_play_id_onchain: m.play_id_onchain,
              });
              if (error) {
                stubResult = null;
                errors.push({
                  source: "ensure_topshot_edition_stub",
                  message: `pair=${key} nft_id=${m.nft_id}: ${error.message}`.slice(0, 300),
                });
              } else {
                stubResult = typeof data === "string" && data.length > 0 ? data : null;
                if (stubResult !== null) stubsCreated++;
              }
            } catch (err) {
              stubResult = null;
              const msg = err instanceof Error ? err.message : String(err);
              errors.push({
                source: "ensure_topshot_edition_stub",
                message: `pair=${key} nft_id=${m.nft_id}: ${msg}`.slice(0, 300),
              });
            }
            stubResolutionCache.set(key, stubResult);
          }
          if (stubResult === null) {
            editionResolutionFailures++;
            errors.push({
              source: "catalog_gap",
              message: `parent set unknown for nft_id=${m.nft_id} set_id_onchain=${m.set_id_onchain} play_id_onchain=${m.play_id_onchain}`,
            });
            continue;
          }
          editionId = stubResult;
        }
        momentRows.push({
          nft_id: m.nft_id,
          edition_id: editionId,
          serial_number: m.flowSerialNumber as number,
          owner_address: m.owner_address,
        });
      }
      const editionsResolved = momentRows.length;

      // ── 5. Server-side dual-constraint replace ────────────────────────
      let momentsWritten = 0;
      if (momentRows.length > 0) {
        try {
          const result = await replaceMomentsBatch(sb, momentRows);
          momentsWritten = result.count;
          if (result.error) {
            console.log(`[topshot-moments-hydrator] moments write error: ${result.error}`);
            errors.push({ source: "moments_write", message: result.error });
          }
          if (result.unexpectedShape) {
            console.log(`[topshot-moments-hydrator] ${result.unexpectedShape}`);
            errors.push({ source: "moments_write_shape", message: result.unexpectedShape });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`[topshot-moments-hydrator] moments write throw: ${msg}`);
          errors.push({ source: "moments_write", message: msg });
        }
      }

      // ok-flag policy: a burned/retired/unknown moment nulling its own alias is
      // normal upstream degradation (partial gql-field errors), NOT a worker
      // failure — it must not flag the pipeline red every 10 min just because the
      // permanent tail of unresolvable ids sits at the queue head. Likewise
      // edition_resolution_failures are normal catalog drift. Only a HARD chunk
      // failure (HTTP/network/JSON parse — no data came back at all) or a write
      // that produced 0 rows when we DID have resolvable rows flips ok=false.
      // resolvable.length===0 (nothing this run could be resolved) is honest
      // degraded operation, surfaced via the telemetry fields, not a failure.
      const ok = computeOk(hardChunkFailures, momentsWritten, resolvable.length);

      const durationMs = Date.now() - startedMs;
      await logPipelineRun(sb, {
        startedAtIso,
        rowsFound: candidates.length,
        rowsWritten: momentsWritten,
        rowsSkipped: editionResolutionFailures + graphqlFailures,
        ok,
        error: errors.length > 0
          ? errors.map((e) => `${e.source}: ${e.message}`).join(" | ").slice(0, 500)
          : null,
        extra: {
          candidates_per_run: CANDIDATES_PER_RUN,
          chunk_size: CHUNK_SIZE,
          fetched_from_graphql: fetchedFromGraphql,
          editions_resolved: editionsResolved,
          edition_resolution_failures: editionResolutionFailures,
          graphql_failures: graphqlFailures,
          hard_chunk_failures: hardChunkFailures,
          stubs_created: stubsCreated,
          duration_ms: durationMs,
          errors: errors.length > 0 ? errors.slice(0, 5) : undefined,
        },
      });

      return new Response(
        JSON.stringify({
          ok,
          candidates_read: candidates.length,
          fetched_from_graphql: fetchedFromGraphql,
          editions_resolved: editionsResolved,
          moments_written: momentsWritten,
          edition_resolution_failures: editionResolutionFailures,
          graphql_failures: graphqlFailures,
          hard_chunk_failures: hardChunkFailures,
          stubs_created: stubsCreated,
          duration_ms: durationMs,
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
          moments_written: 0,
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
