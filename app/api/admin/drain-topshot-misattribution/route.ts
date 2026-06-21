// app/api/admin/drain-topshot-misattribution/route.ts
//
// On-chain drain for the platform-wide TopShot sales mis-attribution
// (docs/scoping-2026-06-20-26-edition-misattribution.md). The self-healing
// remap (remap_misattributed_topshot_sales, wired into the guard refresh) can
// only fix sales whose moment is still in a tracked wallet (wmc). The residual
// — sales on UUID-dupe editions + colliding serials on guard editions + the
// ambiguous-reverted set — are held by UNTRACKED wallets, so DB has no on-chain
// truth for them. This route resolves each remaining nft's true (setID, playID,
// serial) directly from TopShot GraphQL getMintedMoment (via topshot-proxy —
// Cloudflare blocks Vercel egress to public-api.nbatopshot.com, so TS_PROXY_URL
// + X-Proxy-Secret are required and are injected automatically on a DEPLOYED
// route), writes the authoritative map (topshot_misattrib_onchain_map), and —
// with ?rekey=1 — re-keys sales + moments via remap_topshot_from_onchain_map()
// (reversible: before-state captured in audit_topshot_*_drain_remap_20260621).
//
// Field casing (verified live): set.flowId (number), play.flowID (string),
// flowSerialNumber. Same shape the moments hydrator uses against getMintedMoment.
//
// Auth: Bearer RPC_ADMIN_TOKEN (admin/cron-job.org) OR Bearer INGEST_SECRET_TOKEN
// (GitHub Actions) OR Bearer CRON_SECRET (Vercel cron — which WAITS for the full
// maxDuration, unlike cron-job.org's 30s cap). Or ?token=<RPC_ADMIN_TOKEN>.
// Query params:
//   ?limit=N    cap targets resolved this tick (default CANDIDATES_PER_RUN)
//   ?rekey=1    after resolution, run remap_topshot_from_onchain_map()
//   ?probe=1    resolve WITHOUT writing the map; return a sample (shape check)

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const COLLECTION_SLUG = "nba-top-shot";
const PIPELINE_NAME = "topshot-misattrib-drain";
const TS_PROXY_URL_DEFAULT = "https://public-api.nbatopshot.com/graphql";

const CANDIDATES_PER_RUN = 1200; // resolvable within the 300s budget at CHUNK_SIZE/150ms
const CHUNK_SIZE = 40; // aliased getMintedMoment lookups per POST
const PER_REQUEST_TIMEOUT_MS = 15_000;
const CHUNK_DELAY_MS = 150;
const TIME_BUDGET_OVERHEAD_MS = 40_000;

function tsProxyUrl(): string {
  return process.env.TS_PROXY_URL || TS_PROXY_URL_DEFAULT;
}
function tsProxyHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "rip-packs-city/topshot-misattrib-drain",
  };
  if (process.env.TS_PROXY_SECRET) h["X-Proxy-Secret"] = process.env.TS_PROXY_SECRET;
  return h;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function authed(req: NextRequest): boolean {
  if (verifyAdminRequest(req)) return true;
  const hdr = req.headers.get("authorization") ?? "";
  const ingest = process.env.INGEST_SECRET_TOKEN;
  const cron = process.env.CRON_SECRET;
  if (ingest && hdr === `Bearer ${ingest}`) return true;
  if (cron && hdr === `Bearer ${cron}`) return true;
  return false;
}

function buildAliasedQuery(count: number): string {
  const varDecls: string[] = [];
  const aliases: string[] = [];
  for (let i = 0; i < count; i++) {
    varDecls.push(`$id${i}: ID!`);
    aliases.push(
      `m${i}: getMintedMoment(momentId: $id${i}) { data { ... on MintedMoment { flowSerialNumber play { ... on Play { flowID } } set { ... on Set { flowId } } } } }`,
    );
  }
  return `query Drain(${varDecls.join(", ")}) {\n${aliases.join("\n")}\n}`;
}

interface Resolved {
  nft_id: string;
  set_id_onchain: number;
  play_id_onchain: number;
  serial_number: number | null;
}

function parseIntOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

async function fetchChunk(ids: string[]): Promise<{ resolved: Resolved[]; failed: number; errorMsg: string | null }> {
  if (ids.length === 0) return { resolved: [], failed: 0, errorMsg: null };
  const query = buildAliasedQuery(ids.length);
  const variables: Record<string, string> = {};
  for (let i = 0; i < ids.length; i++) variables[`id${i}`] = ids[i];

  let res: Response;
  try {
    res = await fetch(tsProxyUrl(), {
      method: "POST",
      headers: tsProxyHeaders(),
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { resolved: [], failed: ids.length, errorMsg: `fetch: ${err instanceof Error ? err.message.slice(0, 120) : "err"}` };
  }
  if (!res.ok) return { resolved: [], failed: ids.length, errorMsg: `HTTP ${res.status}` };

  let json: any;
  try {
    json = await res.json();
  } catch {
    return { resolved: [], failed: ids.length, errorMsg: "json parse" };
  }
  if (Array.isArray(json?.errors) && json.errors.length > 0) {
    return { resolved: [], failed: ids.length, errorMsg: `gql: ${String(json.errors[0]?.message ?? "?").slice(0, 120)}` };
  }

  const resolved: Resolved[] = [];
  let failed = 0;
  for (let i = 0; i < ids.length; i++) {
    const node = json?.data?.[`m${i}`]?.data ?? null;
    const setN = parseIntOrNull(node?.set?.flowId);
    const playN = parseIntOrNull(node?.play?.flowID);
    if (node && setN != null && playN != null) {
      resolved.push({ nft_id: ids[i], set_id_onchain: setN, play_id_onchain: playN, serial_number: parseIntOrNull(node.flowSerialNumber) });
    } else {
      failed++;
    }
  }
  return { resolved, failed, errorMsg: null };
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!authed(req)) return adminUnauthorizedResponse();

  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const sb: any = supabaseAdmin;
  const probe = req.nextUrl.searchParams.get("probe") === "1";
  const doRekey = req.nextUrl.searchParams.get("rekey") === "1";
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = Math.max(1, Math.min(CANDIDATES_PER_RUN, limitParam ? parseInt(limitParam, 10) || CANDIDATES_PER_RUN : CANDIDATES_PER_RUN));

  // 1. Read unresolved targets (sales on UUID editions / colliding serials / ambiguous-reverted).
  const { data: targetRows, error: tErr } = await sb.rpc("topshot_misattrib_drain_targets", { p_limit: limit });
  if (tErr) return NextResponse.json({ error: `targets: ${tErr.message}` }, { status: 500 });
  const targets: string[] = (targetRows ?? []).map((r: any) => String(r.nft_id));

  if (targets.length === 0) {
    return NextResponse.json({ ok: true, pipeline: PIPELINE_NAME, targets: 0, note: "no unresolved targets" });
  }

  // 2. Resolve each via getMintedMoment (aliased chunks), within the time budget.
  const timeBudgetMs = maxDuration * 1000 - TIME_BUDGET_OVERHEAD_MS;
  const resolved: Resolved[] = [];
  let gqlFailed = 0;
  let chunks = 0;
  let terminated = "targets_exhausted";
  const errs: string[] = [];
  for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
    if (Date.now() - startedAt > timeBudgetMs) {
      terminated = "time_budget_exceeded";
      break;
    }
    const r = await fetchChunk(targets.slice(i, i + CHUNK_SIZE));
    chunks++;
    resolved.push(...r.resolved);
    gqlFailed += r.failed;
    if (r.errorMsg && errs.length < 5) errs.push(r.errorMsg);
    if (i + CHUNK_SIZE < targets.length) await sleep(CHUNK_DELAY_MS);
  }

  if (probe) {
    return NextResponse.json({
      ok: true,
      pipeline: PIPELINE_NAME,
      mode: "probe",
      targets: targets.length,
      resolved: resolved.length,
      gql_failed: gqlFailed,
      samples: resolved.slice(0, 20),
    });
  }

  // 3. Upsert the authoritative on-chain map.
  let written = 0;
  const upsertErrs: string[] = [];
  for (let i = 0; i < resolved.length; i += 500) {
    const batch = resolved.slice(i, i + 500).map((r) => ({
      nft_id: r.nft_id,
      set_id_onchain: r.set_id_onchain,
      play_id_onchain: r.play_id_onchain,
      serial_number: r.serial_number,
      resolved_at: new Date().toISOString(),
    }));
    const { error: upErr } = await sb.from("topshot_misattrib_onchain_map").upsert(batch, { onConflict: "nft_id" });
    if (upErr) upsertErrs.push(upErr.message);
    else written += batch.length;
  }

  // 4. Optionally re-key sales + moments from the (now-larger) authoritative map.
  let rekey: any = null;
  if (doRekey) {
    const { data: rk, error: rkErr } = await sb.rpc("remap_topshot_from_onchain_map");
    if (rkErr) errs.push(`rekey: ${rkErr.message}`);
    else rekey = rk;
  }

  const durationMs = Date.now() - startedAt;
  const ok = upsertErrs.length === 0 && errs.length === 0;

  try {
    await sb.from("pipeline_runs").insert({
      pipeline: PIPELINE_NAME,
      collection_slug: COLLECTION_SLUG,
      started_at: startedAtIso,
      finished_at: new Date().toISOString(),
      rows_found: targets.length,
      rows_written: written,
      rows_skipped: gqlFailed,
      ok,
      error: [...upsertErrs, ...errs].slice(0, 3).join(" | ") || null,
      extra: {
        chunks,
        resolved: resolved.length,
        gql_failed: gqlFailed,
        map_written: written,
        terminated_reason: terminated,
        rekey,
        errors_sample: [...upsertErrs, ...errs].slice(0, 5),
        duration_ms: durationMs,
      },
    });
  } catch {
    /* best-effort */
  }

  return NextResponse.json({
    ok,
    pipeline: PIPELINE_NAME,
    targets: targets.length,
    resolved: resolved.length,
    gql_failed: gqlFailed,
    map_written: written,
    rekey,
    terminated_reason: terminated,
    duration_ms: durationMs,
    ...(upsertErrs.length || errs.length ? { errors: [...upsertErrs, ...errs].slice(0, 5) } : {}),
  });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}
export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}
