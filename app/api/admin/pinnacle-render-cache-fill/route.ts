// app/api/admin/pinnacle-render-cache-fill/route.ts
//
// Home-machine bridge for the Pinnacle render cache. assets.disneypinnacle.com
// 403s ALL datacenter egress (Vercel, Supabase edge, Cloudflare Workers — the
// worker passthrough premise was disproven 2026-07-14), but plain fetches from
// a RESIDENTIAL IP pass (verified live from Trevor's machine). So the fifth
// scheduler (Windows Task Scheduler) runs scripts/pinnacle-render-cache-fill.mjs
// every 15 minutes: it asks this route which trophy-pinned renders are missing
// from pinnacle_render_cache, fetches each via /api/public/pinnacle-image/<id>
// from the home IP, downscales, and POSTs the bytes back here. The trophy-case
// PDF (and any future server surface) reads the cache first, so ANY user's
// newly pinned Pinnacle pin gets real art within one scheduler tick — no
// manual harvest.
//
//   GET  (Bearer INGEST|CRON)             → { needed: [render_id...] }
//   GET  ?all=1                           → every referenced render (force-refresh list)
//   POST (Bearer INGEST|CRON) {render_id, b64} → validated service-role upsert
//
// Auth: INGEST_SECRET_TOKEN or CRON_SECRET (standard server-secret equivalence).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RENDER_ID_RE = /^[A-Za-z0-9-]{3,64}$/;
const THUMB_RE = /\/api\/public\/pinnacle-image\/([A-Za-z0-9-]{3,64})/;
const PIPELINE = "pinnacle-render-cache-fill";

function authed(req: NextRequest): boolean {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const ingest = process.env.INGEST_SECRET_TOKEN;
  const cron = process.env.CRON_SECRET;
  return !!bearer && ((!!ingest && bearer === ingest) || (!!cron && bearer === cron));
}

// Every render_id referenced by a trophy-pinned Pinnacle slab.
async function referencedRenderIds(): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabaseAdmin;
  const { data, error } = await sb
    .from("trophy_moments")
    .select("thumbnail_url")
    .like("thumbnail_url", "%/api/public/pinnacle-image/%")
    .limit(1000);
  if (error) throw new Error(`trophy_moments read: ${error.message}`);
  const ids = new Set<string>();
  for (const row of (data as Array<{ thumbnail_url: string | null }>) || []) {
    const m = (row.thumbnail_url || "").match(THUMB_RE);
    if (m && RENDER_ID_RE.test(m[1])) ids.add(m[1]);
  }
  return Array.from(ids);
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const all = req.nextUrl.searchParams.get("all") === "1";
    const referenced = await referencedRenderIds();
    if (all) return NextResponse.json({ needed: referenced, mode: "all" });
    if (referenced.length === 0) return NextResponse.json({ needed: [], mode: "missing" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb: any = supabaseAdmin;
    const { data: cached, error } = await sb
      .from("pinnacle_render_cache")
      .select("render_id")
      .in("render_id", referenced);
    if (error) throw new Error(`cache read: ${error.message}`);
    const have = new Set(((cached as Array<{ render_id: string }>) || []).map((r) => r.render_id));
    return NextResponse.json({ needed: referenced.filter((id) => !have.has(id)), mode: "missing" });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { render_id?: string; b64?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const renderId = (body.render_id || "").trim();
  const b64 = body.b64 || "";
  if (!RENDER_ID_RE.test(renderId) || b64.length < 100 || b64.length > 6_000_000 || !/^[A-Za-z0-9+/=]+$/.test(b64)) {
    return NextResponse.json({ error: "bad_input" }, { status: 400 });
  }
  const head = Buffer.from(b64.slice(0, 16), "base64");
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const isJpg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (!isPng && !isJpg) return NextResponse.json({ error: "not_an_image" }, { status: 400 });

  // Only accept renders a trophy slab actually references — keeps the cache
  // scoped to product need even though the caller is secret-authed.
  const referenced = await referencedRenderIds().catch(() => null);
  if (referenced && !referenced.includes(renderId)) {
    return NextResponse.json({ error: "render_not_referenced" }, { status: 422 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabaseAdmin;
  const bytes = Math.floor((b64.length * 3) / 4);
  const { error } = await sb.from("pinnacle_render_cache").upsert({
    render_id: renderId,
    mime: isPng ? "image/png" : "image/jpeg",
    b64,
    bytes,
    fetched_at: new Date().toISOString(),
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Visibility in pipeline_runs (pruned daily; ~1 row per newly pinned pin).
  try {
    await sb.from("pipeline_runs").insert({
      pipeline: PIPELINE,
      collection_slug: "disney_pinnacle",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      rows_written: 1,
      ok: true,
      extra: { render_id: renderId, bytes },
    });
  } catch {
    /* non-fatal */
  }
  return NextResponse.json({ ok: true, render_id: renderId, bytes });
}
