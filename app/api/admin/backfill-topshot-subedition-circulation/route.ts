// app/api/admin/backfill-topshot-subedition-circulation/route.ts
//
// Authoritative per-parallel circulation for the 1,374 subedition ("::")
// Top Shot editions cataloged by Stage B (979d06f). Stage B seeded each
// parallel's circulation_count from the MAX OBSERVED SERIAL — a documented
// FLOOR, because on-chain `getNumberMintedPerSubedition` lives on the
// resource-bound SubeditionAdmin (no public contract view) and our subedition
// resolver only saw the traded/held subset of mints.
//
// The authoritative gross mint of each parallel is exposed by the Top Shot
// GraphQL `searchEditions` feed: every parallel of a (set, play) comes back as
// its OWN Edition row carrying `parallelID` (== on-chain subeditionID) and that
// parallel's `circulationCount`. This route walks the 49 sets that host "::"
// editions through the topshot-proxy (Cloudflare blocks Vercel egress to
// public-api.nbatopshot.com, so the GQL MUST go through TS_PROXY_URL — that
// secret lives in Vercel and is used automatically by a DEPLOYED route).
//
// Update rule (monotone, never breaks perfect-serial detection):
//   circulation_count := GREATEST(gqlCirculationCount, current_floor)
// i.e. raise the floor toward the true gross mint, never shrink below an
// already-observed serial (a gross mint can never be < max serial seen; if GQL
// `circulationCount` is reported net-of-burn it could read lower, so GREATEST
// keeps the denominator honest for #N/N "perfect serial" logic). Only "::" rows
// are touched — Standard rows already carry the catalog's gross circulation.
//
// Auth: Bearer RPC_ADMIN_TOKEN (or ?token=). GET or POST.
// ?probe=1   — walk only the first set and return the raw (play, parallelID,
//              circulationCount) observations WITHOUT writing, so the GQL shape
//              can be confirmed on the first production call before a full run.
// ?limitSets=N — cap sets processed this tick (default: all, time-budget bound).
//
// Recommended: run ad-hoc to completion (49 sets ~ a couple of minutes), then
// a low-cadence cron (weekly) to pick up newly-cataloged parallels.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";
const COLLECTION_SLUG = "nba-top-shot";
const PIPELINE_NAME = "topshot-subedition-circulation-backfill";

const TS_PROXY_URL_DEFAULT = "https://public-api.nbatopshot.com/graphql";
const PAGE_LIMIT = 100;
const SET_DELAY_MS = 250;
const TIME_BUDGET_OVERHEAD_MS = 30_000;
const PER_REQUEST_TIMEOUT_MS = 12_000;

// Same allowlisted SearchEditions shape the catalog backfill uses (proven by
// the daily topshot-catalog-backfill cron), with `parallelID`/`parallelName`
// added so each per-parallel Edition row is distinguishable. The double `data`
// wrapper inside `... on Editions { data { ... on Edition } }` is required by
// the schema.
const SEARCH_EDITIONS_QUERY = `
  query SubeditionCirculationBackfill($input: SearchEditionsInput!) {
    searchEditions(input: $input) {
      searchSummary {
        pagination { rightCursor }
        data {
          ... on Editions {
            data {
              ... on Edition {
                parallelID
                parallelName
                circulationCount
                set { flowId }
                play { flowID }
              }
            }
          }
        }
      }
    }
  }
`;

interface RawEdition {
  parallelID?: number | null;
  parallelName?: string | null;
  circulationCount?: number | null;
  set?: { flowId?: number | string | null } | null;
  play?: { flowID?: string | number | null } | null;
}

function tsProxyUrl(): string {
  return process.env.TS_PROXY_URL || TS_PROXY_URL_DEFAULT;
}

function tsProxyHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "rip-packs-city/topshot-subedition-circulation-backfill",
  };
  if (process.env.TS_PROXY_SECRET) {
    h["X-Proxy-Secret"] = process.env.TS_PROXY_SECRET;
  }
  return h;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchEditionsPage(
  setUuid: string,
  cursor: string,
): Promise<{ editions: RawEdition[]; nextCursor: string | null } | null> {
  type Resp = {
    searchEditions?: {
      searchSummary?: {
        pagination?: { rightCursor?: string | null };
        data?: { data?: RawEdition[] } | null;
      } | null;
    } | null;
  };
  const body = {
    query: SEARCH_EDITIONS_QUERY,
    operationName: "SubeditionCirculationBackfill",
    variables: {
      input: {
        filters: { bySetIDs: [setUuid] },
        searchInput: { pagination: { cursor, direction: "RIGHT", limit: PAGE_LIMIT } },
      },
    },
  };
  try {
    const res = await fetch(tsProxyUrl(), {
      method: "POST",
      headers: tsProxyHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Resp; errors?: unknown[] };
    if (Array.isArray(json.errors) && json.errors.length > 0) return null;
    const summary = json.data?.searchEditions?.searchSummary;
    return {
      editions: summary?.data?.data ?? [],
      nextCursor: summary?.pagination?.rightCursor ?? null,
    };
  } catch {
    return null;
  }
}

async function walkSet(setUuid: string): Promise<{ editions: RawEdition[]; gqlCalls: number }> {
  const collected: RawEdition[] = [];
  const seenCursors = new Set<string>();
  let cursor = "";
  let gqlCalls = 0;
  for (let page = 0; page < 50; page++) {
    if (cursor && seenCursors.has(cursor)) break;
    if (cursor) seenCursors.add(cursor);
    const result = await fetchEditionsPage(setUuid, cursor);
    gqlCalls++;
    if (!result) break;
    collected.push(...result.editions);
    if (!result.nextCursor || result.nextCursor === cursor) break;
    cursor = result.nextCursor;
  }
  return { editions: collected, gqlCalls };
}

// Build the on-chain triple key set.flowId:play.flowID:parallelID → circulation.
function tripleKey(setFlow: number, playFlow: number, parallelId: number): string {
  return `${setFlow}:${playFlow}:${parallelId}`;
}

interface ParallelEditionRow {
  id: string;
  external_id: string;
  set_id_onchain: number | null;
  play_id_onchain: number | null;
  subedition_id: number | null;
  circulation_count: number | null;
  set_uuid: string;
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();

  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const probe = req.nextUrl.searchParams.get("probe") === "1";
  const limitSetsParam = req.nextUrl.searchParams.get("limitSets");
  const limitSets = limitSetsParam ? Math.max(1, parseInt(limitSetsParam, 10) || 1) : null;

  const supabase: any = supabaseAdmin;

  // Pull every "::" parallel edition with its on-chain triple + parent set UUID.
  const { data: rowsRaw, error: selErr } = await supabase
    .from("editions")
    .select("id, external_id, set_id_onchain, play_id_onchain, subedition_id, circulation_count, sets!inner(external_id)")
    .eq("collection_id", COLLECTION_ID)
    .like("external_id", "%::%")
    .not("set_id_onchain", "is", null)
    .not("play_id_onchain", "is", null);
  if (selErr) {
    return NextResponse.json({ error: selErr.message }, { status: 500 });
  }
  const parallels: ParallelEditionRow[] = (rowsRaw ?? []).map((r: any) => ({
    id: r.id,
    external_id: r.external_id,
    set_id_onchain: r.set_id_onchain,
    play_id_onchain: r.play_id_onchain,
    subedition_id: r.subedition_id,
    circulation_count: r.circulation_count,
    set_uuid: r.sets?.external_id,
  })).filter((r: ParallelEditionRow) => r.set_uuid);

  // Distinct set UUIDs to walk, in stable order.
  const setUuids = Array.from(new Set(parallels.map((p) => p.set_uuid))).sort();
  const setsToWalk = limitSets ? setUuids.slice(0, limitSets) : setUuids;

  const timeBudgetMs = maxDuration * 1000 - TIME_BUDGET_OVERHEAD_MS;
  let setsWalked = 0;
  let gqlCalls = 0;
  let editionsReturned = 0;
  let parallelRowsSeen = 0; // GQL rows with parallelID > 0
  let matched = 0;
  let updated = 0;
  let terminatedReason = "complete";
  const errors: Array<{ set: string; reason: string }> = [];
  const probeObservations: Array<{ set_flow: any; play_flow: any; parallel_id: any; circ: any }> = [];
  // gqlCirc keyed by set:play:parallel
  const gqlCirc = new Map<string, number>();

  for (const setUuid of setsToWalk) {
    if (!probe && Date.now() - startedAt > timeBudgetMs) {
      terminatedReason = "time_budget_exceeded";
      break;
    }
    const { editions, gqlCalls: c } = await walkSet(setUuid);
    gqlCalls += c;
    setsWalked++;
    editionsReturned += editions.length;

    for (const e of editions) {
      const pid = Number(e.parallelID ?? 0);
      const circ = e.circulationCount == null ? null : Number(e.circulationCount);
      const setFlow = e.set?.flowId == null ? null : parseInt(String(e.set.flowId), 10);
      const playFlow = e.play?.flowID == null ? null : parseInt(String(e.play.flowID), 10);
      if (pid > 0) parallelRowsSeen++;
      if (probe) {
        probeObservations.push({ set_flow: setFlow, play_flow: playFlow, parallel_id: pid, circ });
      }
      if (pid > 0 && circ != null && circ > 0 && setFlow != null && playFlow != null) {
        gqlCirc.set(tripleKey(setFlow, playFlow, pid), circ);
      }
    }
    await sleep(SET_DELAY_MS);
  }

  if (probe) {
    return NextResponse.json({
      ok: true,
      pipeline: PIPELINE_NAME,
      mode: "probe",
      sets_walked: setsWalked,
      gql_calls: gqlCalls,
      editions_returned: editionsReturned,
      parallel_rows_seen: parallelRowsSeen,
      distinct_parallel_ids: Array.from(new Set(probeObservations.map((o) => o.parallel_id))).sort(),
      observations_sample: probeObservations.slice(0, 40),
      note:
        parallelRowsSeen === 0
          ? "searchEditions bySetIDs returned NO parallelID>0 rows for this set — switch to the per-(set,play) flat query."
          : "parallelID>0 rows present — full run will match by set:play:parallel triple.",
    });
  }

  // Apply circulation updates: raise the floor toward true gross mint.
  for (const p of parallels) {
    if (Date.now() - startedAt > timeBudgetMs) {
      terminatedReason = "time_budget_exceeded";
      break;
    }
    if (p.set_id_onchain == null || p.play_id_onchain == null || p.subedition_id == null) continue;
    const key = tripleKey(p.set_id_onchain, p.play_id_onchain, p.subedition_id);
    const gqlVal = gqlCirc.get(key);
    if (gqlVal == null) continue;
    matched++;
    const floor = p.circulation_count ?? 0;
    const next = Math.max(gqlVal, floor);
    if (next !== floor) {
      const { error: updErr } = await supabase
        .from("editions")
        .update({ circulation_count: next, updated_at: new Date().toISOString() })
        .eq("id", p.id);
      if (updErr) {
        errors.push({ set: p.external_id, reason: updErr.message });
      } else {
        updated++;
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  const ok = errors.length === 0;

  try {
    await supabase.from("pipeline_runs").insert({
      pipeline: PIPELINE_NAME,
      collection_slug: COLLECTION_SLUG,
      started_at: startedAtIso,
      finished_at: new Date().toISOString(),
      rows_found: parallels.length,
      rows_written: updated,
      rows_skipped: matched - updated,
      ok,
      error: errors.length > 0 ? errors.slice(0, 3).map((e) => e.reason).join(" | ") : null,
      extra: {
        sets_walked: setsWalked,
        gql_calls: gqlCalls,
        editions_returned: editionsReturned,
        parallel_rows_seen: parallelRowsSeen,
        gql_triples: gqlCirc.size,
        matched,
        updated,
        duration_ms: durationMs,
        terminated_reason: terminatedReason,
        errors_sample: errors.slice(0, 5),
      },
    });
  } catch {
    // Observability is best-effort.
  }

  return NextResponse.json({
    ok,
    pipeline: PIPELINE_NAME,
    sets_walked: setsWalked,
    gql_calls: gqlCalls,
    editions_returned: editionsReturned,
    parallel_rows_seen: parallelRowsSeen,
    gql_triples: gqlCirc.size,
    matched,
    updated,
    duration_ms: durationMs,
    terminated_reason: terminatedReason,
    errors_count: errors.length,
    errors_sample: errors.slice(0, 5),
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
