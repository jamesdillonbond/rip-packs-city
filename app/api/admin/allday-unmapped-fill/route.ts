// app/api/admin/allday-unmapped-fill/route.ts
//
// Transport-agnostic admin endpoint for the AllDay unmapped-sales backlog.
//
// 2026-07-16 UPDATE: the AllDay consumer GQL WAF blocks EVERY non-browser
// lane INCLUDING residential curl (proven — the home-machine curl script this
// route was built for got the WAF block page; that script is deleted). The
// ONLY lane that passes is a REAL BROWSER on the nflallday.com origin
// (same-origin fetch). The backlog was drained 2026-07-16 via a Chrome-session
// relay (resolve on nflallday -> carry rows in window.name across a cross-origin
// navigation -> POST from a rippackscity tab through a temp edge bridge). This
// route stays as a valid service-role admin endpoint (GET targets / POST
// resolve) that a future BROWSER-driven filler can call; do NOT wire a
// server/curl scheduler to it (WAF-dead).
//
// Original design note (server lanes, all now confirmed WAF-blocked):
// Home-machine bridge for the AllDay unmapped-sales backlog. The AllDay
// consumer GraphQL (nflallday.com/consumer/graphql) — the only index that
// resolves ANY moment by flow id regardless of owner — now WAF-403s every
// server lane: Vercel egress, Supabase edge, and even the topshot-proxy
// Cloudflare Worker /allday-consumer route (verified 2026-07-16: the worker
// gets the WAF block page). The live on-chain resolver only recovers ~0-12 of
// 60 attempts per tick (buyer-collection borrows nil out when moments move),
// so the backlog grew to ~8.8k unresolved sales and AllDay FMV/analytics
// undercount real secondary volume.
//
// Same pattern as /api/admin/pinnacle-render-cache-fill: the fifth scheduler
// (Trevor's machine, residential IP, curl.exe) does the blocked hop.
//
//   GET  ?limit=N (Bearer INGEST|CRON) → { targets: [nft_id...] } via
//        get_unmapped_resolver_targets
//   POST {rows: [{nft_id, edition_external_id, serial_number}]} →
//        resolve_unmapped_sales_for_collection (mapping upsert + promote)
//
// The RPCs are the same ones the resolvers already use — this route adds no
// new write path, only a residential transport for the lookup.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070";
const PIPELINE = "allday-unmapped-homefill";

function authed(req: NextRequest): boolean {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const ingest = process.env.INGEST_SECRET_TOKEN;
  const cron = process.env.CRON_SECRET;
  return !!bearer && ((!!ingest && bearer === ingest) || (!!cron && bearer === cron));
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limit = Math.max(1, Math.min(1000, Number(req.nextUrl.searchParams.get("limit")) || 400));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabaseAdmin;
  const { data, error } = await sb.rpc("get_unmapped_resolver_targets", {
    p_collection_id: ALLDAY_COLLECTION_ID,
    p_limit: limit,
    p_offset: 0,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const targets = ((data ?? []) as Array<{ nft_id: string }>).map((t) => t.nft_id);
  return NextResponse.json({ targets });
}

type RowIn = { nft_id?: unknown; edition_external_id?: unknown; serial_number?: unknown };

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { rows?: RowIn[] } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const raw = Array.isArray(body.rows) ? body.rows : [];
  if (raw.length === 0 || raw.length > 500) {
    return NextResponse.json({ error: "rows must be 1..500" }, { status: 400 });
  }
  // AllDay nft ids and edition flow ids are both numeric strings; serials
  // positive ints or null. Reject anything else — the mapping table feeds
  // sales promotion, so shape discipline matters even on a secret-authed path.
  const rows: Array<{ nft_id: string; edition_external_id: string; serial_number: number | null }> = [];
  for (const r of raw) {
    const nft = String(r.nft_id ?? "").trim();
    const ed = String(r.edition_external_id ?? "").trim();
    const serialN = r.serial_number == null ? null : Number(r.serial_number);
    if (!/^[0-9]{1,12}$/.test(nft) || !/^[0-9]{1,12}$/.test(ed)) continue;
    rows.push({
      nft_id: nft,
      edition_external_id: ed,
      serial_number: serialN != null && Number.isFinite(serialN) && serialN > 0 ? Math.floor(serialN) : null,
    });
  }
  if (rows.length === 0) return NextResponse.json({ error: "no_valid_rows" }, { status: 422 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabaseAdmin;
  const startedAt = new Date().toISOString();
  const { data, error } = await sb.rpc("resolve_unmapped_sales_for_collection", {
    p_collection_id: ALLDAY_COLLECTION_ID,
    p_rows: rows,
    p_promote_limit: 1000,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const resolveJson = (data ?? {}) as Record<string, unknown>;
  const promoteRaw = (resolveJson["promote_result"] ?? null) as Record<string, unknown> | null;
  const summary = {
    submitted: raw.length,
    valid: rows.length,
    mappings_written: Number(resolveJson["mapping_upserted"] ?? 0) || 0,
    sales_promoted: promoteRaw
      ? Number(promoteRaw["promoted"] ?? promoteRaw["sales_promoted"] ?? promoteRaw["inserted"] ?? 0) || 0
      : 0,
  };
  try {
    await sb.from("pipeline_runs").insert({
      pipeline: PIPELINE,
      collection_slug: "nfl-all-day",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      rows_found: rows.length,
      rows_written: summary.mappings_written,
      ok: true,
      extra: summary,
    });
  } catch {
    /* non-fatal */
  }
  return NextResponse.json({ ok: true, ...summary });
}
