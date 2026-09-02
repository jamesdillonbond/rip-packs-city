// app/api/admin/backfill-topshot-subedition-circulation/route.ts
//
// Authoritative per-parallel circulation for the 1,374 subedition ("::")
// Top Shot editions cataloged by Stage B (979d06f). Stage B seeded each
// parallel's circulation_count from the MAX OBSERVED SERIAL — a documented
// FLOOR, because on-chain `getNumberMintedPerSubedition` lives on the
// resource-bound SubeditionAdmin (no public contract view, verified against the
// live TopShot source) and our subedition resolver only saw the traded/held
// subset of mints.
//
// The authoritative gross mint of each parallel is exposed by the Top Shot
// GraphQL `searchMarketplaceEditions` feed: every parallel of a (set, play)
// comes back as its OWN MarketplaceEdition row carrying `parallelID` (== on-chain
// subeditionID) and that parallel's `circulationCount`. This is the same
// full-catalog cursored sweep `badge-sync` uses (proven to return parallelID),
// driven through the topshot-proxy (Cloudflare blocks Vercel egress to
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
// Auth: Bearer RPC_ADMIN_TOKEN (admin UI / cron-job.org) OR Bearer
// INGEST_SECRET_TOKEN (GitHub Actions) OR Bearer CRON_SECRET (Vercel cron — see
// the vercel.json entry that drives this daily). Or ?token=<RPC_ADMIN_TOKEN>.
// GET or POST.
// ?probe=1   — sweep WITHOUT writing and return the raw (parallelID,
//              circulationCount) distribution so the GQL shape can be confirmed.
// ?maxPages=N — cap pages walked this tick (default: budget-bound).

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
const PAGE_DELAY_MS = 150;
const TIME_BUDGET_OVERHEAD_MS = 35_000;
const PER_REQUEST_TIMEOUT_MS = 12_000;
const MAX_PAGES_HARD = 400; // ~40k editions; catalog is ~15.5k — runaway guard.

// Same full-catalog cursored shape badge-sync's CATALOG_QUERY uses (proven to
// return parallelID + per-parallel circulationCount via the proxy). filters:{}
// returns every edition incl. all parallels; EDITION_CREATED_AT_DESC puts the
// recent subedition drops first so the matches land early.
const CATALOG_QUERY = `
  query SubeditionCirculationSweep(
    $searchInput: BaseSearchInput = {pagination: {direction: RIGHT, limit: 100, cursor: ""}}
  ) {
    searchMarketplaceEditions(input: {
      filters: {}
      sortBy: EDITION_CREATED_AT_DESC
      searchInput: $searchInput
    }) {
      data {
        searchSummary {
          pagination { rightCursor }
          data {
            data {
              ... on MarketplaceEdition {
                parallelID
                circulationCount
                lowAsk
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
  circulationCount?: number | null;
  lowAsk?: number | null;
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
  if (process.env.TS_PROXY_SECRET) h["X-Proxy-Secret"] = process.env.TS_PROXY_SECRET;
  return h;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ⚠ RETURNS THE REASON, NOT JUST `null` (2026-09-02). Every failure path here used
// to collapse to a bare `null` — a non-OK status, a GraphQL `errors` array and a
// thrown exception were indistinguishable — and the caller turned all three into
// `terminated_reason: "gql_fault"` with `errors_sample: []`. So an operator reading
// a failed run could not tell an upstream outage from a broken credential from a
// timeout, which is the whole point of logging it. The reason is now carried out
// and recorded verbatim (truncated) in `extra.gql_fault_reason`.
type PageFault = { fault: string }
type PageOk = { editions: RawEdition[]; nextCursor: string | null }

function isFault(r: PageOk | PageFault): r is PageFault {
  return (r as PageFault).fault !== undefined
}

async function fetchPage(cursor: string): Promise<PageOk | PageFault> {
  const body = {
    query: CATALOG_QUERY,
    operationName: "SubeditionCirculationSweep",
    variables: { searchInput: { pagination: { direction: "RIGHT", limit: PAGE_LIMIT, cursor } } },
  };
  try {
    const res = await fetch(tsProxyUrl(), {
      method: "POST",
      headers: tsProxyHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // The body matters as much as the status: a Cloudflare 530 says "origin is
      // down" only in its body, and that is the signature rpc_ops_snapshot's
      // failure buckets classify on.
      const text = await res.text().catch(() => "");
      return { fault: `Top Shot GraphQL failed with ${res.status}. Response body: ${text.slice(0, 200)}` };
    }
    const json = (await res.json()) as any;
    if (Array.isArray(json?.errors) && json.errors.length > 0) {
      return { fault: `graphql errors: ${JSON.stringify(json.errors).slice(0, 200)}` };
    }
    const summary = json?.data?.searchMarketplaceEditions?.data?.searchSummary;
    const editions: RawEdition[] = summary?.data?.data ?? [];
    const nextCursor: string | null = summary?.pagination?.rightCursor ?? null;
    return { editions, nextCursor };
  } catch (e) {
    return { fault: `fetch threw: ${e instanceof Error ? e.message : String(e)}`.slice(0, 220) };
  }
}

// KEY on (play, parallelID) — NOT (set, play, parallelID). searchMarketplace-
// Editions returns set.flowId = 0 on subedition rows (verified live), but
// play.flowID + parallelID are correct, and (play_id_onchain, subedition_id) is
// unique across our :: editions (0 collisions), so the pair resolves the right
// row unambiguously.
function pairKey(playFlow: number, parallelId: number): string {
  return `${playFlow}:${parallelId}`;
}

// Accept the Trevor-only admin token, the pipeline INGEST token, or the Vercel
// cron CRON_SECRET (the vercel.json cron driving this). Mirrors the multi-auth
// on the ingest/backfill surfaces.
function authed(req: NextRequest): boolean {
  if (verifyAdminRequest(req)) return true;
  const hdr = req.headers.get("authorization") ?? "";
  const ingest = process.env.INGEST_SECRET_TOKEN;
  const cron = process.env.CRON_SECRET;
  if (ingest && hdr === `Bearer ${ingest}`) return true;
  if (cron && hdr === `Bearer ${cron}`) return true;
  return false;
}

interface ParallelRow {
  id: string;
  external_id: string;
  set_id_onchain: number | null;
  play_id_onchain: number | null;
  subedition_id: number | null;
  circulation_count: number | null;
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!authed(req)) return adminUnauthorizedResponse();

  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const probe = req.nextUrl.searchParams.get("probe") === "1";
  const maxPagesParam = req.nextUrl.searchParams.get("maxPages");
  const maxPages = Math.min(
    MAX_PAGES_HARD,
    maxPagesParam ? Math.max(1, parseInt(maxPagesParam, 10) || MAX_PAGES_HARD) : MAX_PAGES_HARD,
  );

  const supabase: any = supabaseAdmin;

  // Every "::" parallel edition + its on-chain triple. Paginated past the
  // PostgREST 1000-row cap (there are ~1,374). The needed-triple set lets the
  // sweep early-exit once all parallels are resolved.
  const rowsRaw: any[] = [];
  for (let from = 0; from < 5000; from += 1000) {
    const { data: chunk, error: selErr } = await supabase
      .from("editions")
      .select("id, external_id, set_id_onchain, play_id_onchain, subedition_id, circulation_count")
      .eq("collection_id", COLLECTION_ID)
      .like("external_id", "%::%")
      .not("set_id_onchain", "is", null)
      .not("play_id_onchain", "is", null)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 });
    if (!chunk || chunk.length === 0) break;
    rowsRaw.push(...chunk);
    if (chunk.length < 1000) break;
  }

  const parallels: ParallelRow[] = (rowsRaw ?? []).filter(
    (r: ParallelRow) => r.subedition_id != null,
  );
  const needed = new Set(parallels.map((p) => pairKey(p.play_id_onchain!, p.subedition_id!)));

  const timeBudgetMs = maxDuration * 1000 - TIME_BUDGET_OVERHEAD_MS;
  // value = circ, or null when the GQL gave conflicting circs for the same
  // (play, parallel) across sets (ambiguous → skip, keep the floor).
  const gqlCirc = new Map<string, number | null>();
  // Lowest per-parallel marketplace ask (USD), keyed like gqlCirc on (play, parallelID).
  const gqlAsk = new Map<string, number>();
  let cursor = "";
  const seenCursors = new Set<string>();
  let pages = 0;
  let gqlEditionsSeen = 0;
  let parallelRowsSeen = 0;
  let terminatedReason = "catalog_exhausted";
  // null when no page faulted. Never "" — an empty string and "we did not fault"
  // are different facts and must not share a rendering.
  let gqlFaultReason: string | null = null;
  const probeDistinctParallels = new Set<number>();
  const probeSamples: Array<{ set: any; play: any; pid: number; circ: any }> = [];

  for (pages = 0; pages < maxPages; pages++) {
    if (Date.now() - startedAt > timeBudgetMs) {
      terminatedReason = "time_budget_exceeded";
      break;
    }
    if (cursor && seenCursors.has(cursor)) {
      terminatedReason = "cursor_loop";
      break;
    }
    if (cursor) seenCursors.add(cursor);
    const result = await fetchPage(cursor);
    if (isFault(result)) {
      terminatedReason = "gql_fault";
      gqlFaultReason = result.fault;
      break;
    }
    const { editions, nextCursor } = result;
    gqlEditionsSeen += editions.length;

    for (const e of editions) {
      const pid = Number(e.parallelID ?? 0);
      const circ = e.circulationCount == null ? null : Number(e.circulationCount);
      const setFlow = e.set?.flowId == null ? null : parseInt(String(e.set.flowId), 10);
      const playFlow = e.play?.flowID == null ? null : parseInt(String(e.play.flowID), 10);
      if (pid > 0) {
        parallelRowsSeen++;
        probeDistinctParallels.add(pid);
        if (probeSamples.length < 40) probeSamples.push({ set: setFlow, play: playFlow, pid, circ });
      }
      if (pid > 0 && circ != null && circ > 0 && playFlow != null) {
        const k = pairKey(playFlow, pid);
        if (!gqlCirc.has(k)) gqlCirc.set(k, circ);
        else {
          const prev = gqlCirc.get(k);
          if (prev != null && prev !== circ) gqlCirc.set(k, null); // ambiguous across sets
        }
      }
      const askVal = e.lowAsk == null ? null : Number(e.lowAsk);
      if (pid > 0 && playFlow != null && askVal != null && askVal > 0) {
        const ak = pairKey(playFlow, pid);
        const prevA = gqlAsk.get(ak);
        if (prevA == null || askVal < prevA) gqlAsk.set(ak, askVal); // lowest ask across sets
      }
    }

    // Early exit once every needed parallel triple has a GQL circulation.
    if (!probe) {
      let allMatched = true;
      for (const k of needed) {
        if (!gqlCirc.has(k)) {
          allMatched = false;
          break;
        }
      }
      if (allMatched && needed.size > 0) {
        terminatedReason = "all_parallels_matched";
        pages++;
        break;
      }
    }

    if (!nextCursor || nextCursor === cursor) {
      terminatedReason = "catalog_exhausted";
      pages++;
      break;
    }
    cursor = nextCursor;
    await sleep(PAGE_DELAY_MS);
  }

  if (probe) {
    return NextResponse.json({
      ok: true,
      pipeline: PIPELINE_NAME,
      mode: "probe",
      pages,
      gql_editions_seen: gqlEditionsSeen,
      parallel_rows_seen: parallelRowsSeen,
      distinct_parallel_ids: Array.from(probeDistinctParallels).sort((a, b) => a - b),
      gql_triples: gqlCirc.size,
      needed_triples: needed.size,
      samples: probeSamples,
      note:
        parallelRowsSeen === 0
          ? "searchMarketplaceEditions returned NO parallelID>0 rows in the pages walked."
          : "parallelID>0 rows present — full run will GREATEST-update matched :: editions.",
    });
  }

  // Apply: raise circulation_count toward the true gross mint on matched rows.
  let matched = 0;
  let updated = 0;
  const errors: Array<{ ext: string; reason: string }> = [];
  for (const p of parallels) {
    const key = pairKey(p.play_id_onchain!, p.subedition_id!);
    const gqlVal = gqlCirc.get(key);
    if (gqlVal == null) continue; // absent or ambiguous-across-sets
    matched++;
    const floor = p.circulation_count ?? 0;
    const next = Math.max(gqlVal, floor);
    if (next !== floor) {
      const { error: updErr } = await supabase
        .from("editions")
        .update({ circulation_count: next, updated_at: new Date().toISOString() })
        .eq("id", p.id);
      if (updErr) errors.push({ ext: p.external_id, reason: updErr.message });
      else updated++;
    }
  }

  // Per-parallel ASK capture (parallel ASK-floor, step 1): upsert each matched ::
  // edition's lowest marketplace ask so fmv-recalc Step 5e can floor the STALE
  // parallels ASK_ONLY (low_ask*0.90). Secondary to circulation — ask-write errors
  // are recorded but do NOT fail the run (the circ apply above owns `ok`).
  let askUpserts = 0;
  const askErrors: string[] = [];
  const askRowsOut: Array<{ external_id: string; parallel_id: number; low_ask: number; observed_circ: number | null; updated_at: string }> = [];
  for (const p of parallels) {
    const ak = pairKey(p.play_id_onchain!, p.subedition_id!);
    const askVal = gqlAsk.get(ak);
    if (askVal == null || !(askVal > 0)) continue;
    const cv = gqlCirc.get(ak);
    askRowsOut.push({
      external_id: p.external_id,
      parallel_id: p.subedition_id!,
      low_ask: askVal,
      observed_circ: cv == null ? null : cv,
      updated_at: new Date().toISOString(),
    });
  }
  for (let i = 0; i < askRowsOut.length; i += 500) {
    const chunk = askRowsOut.slice(i, i + 500);
    const { error: askErr } = await supabase
      .from("topshot_parallel_asks")
      .upsert(chunk, { onConflict: "external_id" });
    if (askErr) askErrors.push(askErr.message);
    else askUpserts += chunk.length;
  }

  const durationMs = Date.now() - startedAt;

  // ⚠ A RUN THAT READ NOTHING IS NOT A SUCCESS (2026-09-02).
  //
  // `ok` used to be `errors.length === 0`, and `errors` holds per-edition WRITE
  // failures — a different thing entirely from the upstream READ failing. So when
  // Top Shot GraphQL was down the very first page faulted, the loop broke
  // immediately, nothing was read or written, and the run logged `ok: true` with
  // `errors_sample: []`. Measured: that is EVERY daily run in the retained window
  // (`pages: 0`, `gql_editions_seen: 0`, `rows_found` ~3,822, `rows_written` 0),
  // and because `ok` was true it appeared in no failure bucket and could not trip
  // `check_pipelines_running_but_not_succeeding`, which requires ok_runs = 0.
  //
  // ⛔ SCOPED TO A TOTAL READ FAILURE ON PURPOSE. A fault on page 5 after four
  // pages of data is a PARTIAL SWEEP THAT COMMITTED — productive, not stalled —
  // and the repo's own rule is that such a run stays green. Only `pages === 0`
  // AND nothing seen is unambiguously a failed run.
  const readNothing = terminatedReason === "gql_fault" && pages === 0 && gqlEditionsSeen === 0;
  const ok = errors.length === 0 && !readNothing;

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
      // The upstream fault leads, because when it is present it is the reason the
      // run did nothing; per-edition write errors follow it.
      error:
        [readNothing ? gqlFaultReason : null, errors.slice(0, 3).map((e) => e.reason).join(" | ") || null]
          .filter(Boolean)
          .join(" | ") || null,
      extra: {
        pages,
        gql_editions_seen: gqlEditionsSeen,
        parallel_rows_seen: parallelRowsSeen,
        gql_triples: gqlCirc.size,
        needed_triples: needed.size,
        matched,
        updated,
        ask_upserts: askUpserts,
        ask_errors: askErrors.slice(0, 3),
        duration_ms: durationMs,
        terminated_reason: terminatedReason,
        // null when no page faulted. `terminated_reason: "gql_fault"` with no
        // reason beside it was the defect: a count of zero and no error field
        // cannot distinguish "nothing to do" from "could not look".
        gql_fault_reason: gqlFaultReason,
        errors_sample: errors.slice(0, 5),
        // Diagnostic (matched=0 on first run): compare the GQL parallel triples
        // against what our :: editions expect, to find the keying mismatch.
        gql_parallel_sample: probeSamples.slice(0, 25),
        needed_sample: parallels.slice(0, 15).map((p) => ({
          ext: p.external_id,
          key: pairKey(p.play_id_onchain!, p.subedition_id!),
        })),
        distinct_gql_parallel_ids: Array.from(probeDistinctParallels).sort((a, b) => a - b).slice(0, 40),
      },
    });
  } catch {
    // best-effort observability
  }

  return NextResponse.json({
    ok,
    pipeline: PIPELINE_NAME,
    pages,
    gql_editions_seen: gqlEditionsSeen,
    parallel_rows_seen: parallelRowsSeen,
    gql_triples: gqlCirc.size,
    needed_triples: needed.size,
    matched,
    updated,
    ask_upserts: askUpserts,
    duration_ms: durationMs,
    terminated_reason: terminatedReason,
    // Mirrors the pipeline_runs `extra` field. The HTTP body is what an operator
    // sees on a manual run, and it carried `terminated_reason: "gql_fault"` with
    // nothing to say WHICH fault — the same silence, one layer out.
    gql_fault_reason: gqlFaultReason,
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
