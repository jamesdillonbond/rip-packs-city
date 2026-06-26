import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// ─────────────────────────────────────────────────────────────────────────────
// NFL All Day per-moment badge ingest — DB-I/O half (the Atlas fetch CANNOT live
// here).
//
// Real, per-moment NFL All Day badges (All Day Debut / Rookie Year / Rookie Mint
// / Championship Year / Hall of Fame / Crafted Reward / Challenge Reward) live in
// the Dapper Atlas backend: POST atlas.v1.EditionService/SearchEditions
// (product:"nfl") returns a top-level `badges:[{slug,title,visible,...}]` array
// per edition. That host WAF-blocks Node/undici fetch AND Vercel egress (same
// block as the underpriced-#1s Atlas feed), so the fetch runs on a residential
// runner (curl) — scripts/ingest-allday-badges.mjs — which POSTs the resolved
// per-edition badges to THIS route for all DB I/O. The service-role key never
// leaves Vercel.
//
// Atlas edition `id` == editions.external_id for AllDay (verified 1:1 on
// player/set/tier/circulation 2026-06-26), so badges key straight on external_id
// — NO atlas_edition_map needed (unlike Top Shot). Badges land in
// badge_editions.set_play_tags (NOT play_tags: get_edition_badges_unified
// allowlists play_tags to the 9 TS badge titles, but takes set_play_tags
// unconditionally — exactly how the retired heuristic seed-allday-badges wrote
// them, so the edition page renders all 7 badge types with no DB-function change).
//
// Replaces the set-name heuristic in lib/allday-badges.ts (badges vary per-moment
// within a set, so a set-name rule smears one guess across moments that differ).
//
// Runner protocol (scripts/ingest-allday-badges.mjs):
//   POST { rows:[{ external_id, player_name, set_name, tier, parallel_name,
//                  series_number, parallel_id, badges:[{slug,title}],
//                  has_rookie_mint, circulation_count, burned, locked, owned,
//                  hidden_in_packs, low_ask, highest_offer, avg_sale_price }] }
//        -> upsert badge_editions (chunked, onConflict external_id,collection_id)
//   POST { final:true, startedAt, ok, error, stats } -> log pipeline_runs
//
// Auth: Bearer INGEST_SECRET_TOKEN (or CRON_SECRET). Method: POST.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PIPELINE_NAME = "allday-badge-ingest";
const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070";
const UPSERT_CHUNK = 200;

type RunnerRow = {
  external_id?: string | number | null;
  player_name?: string | null;
  set_name?: string | null;
  tier?: string | null;
  parallel_name?: string | null;
  series_number?: number | null;
  parallel_id?: number | null;
  badges?: Array<{ slug?: string | null; title?: string | null }> | null;
  has_rookie_mint?: boolean | null;
  circulation_count?: number | null;
  burned?: number | null;
  locked?: number | null;
  owned?: number | null;
  hidden_in_packs?: number | null;
  low_ask?: number | null;
  highest_offer?: number | null;
  avg_sale_price?: number | null;
};

function authed(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  if (process.env.INGEST_SECRET_TOKEN && auth === `Bearer ${process.env.INGEST_SECRET_TOKEN}`) return true;
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  return false;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Build the canonical badge_editions row from a compact runner payload. Mirrors
// the shape the retired seed-allday-badges route wrote (known-valid), with the
// heuristic set_play_tags swapped for the real Atlas badges + real circulation.
function buildBadgeRow(r: RunnerRow) {
  const extId = r.external_id != null ? String(r.external_id) : "";
  if (!extId) return null;

  const badges = (r.badges ?? [])
    .map((b) => ({ slug: (b?.slug ?? "").trim(), title: (b?.title ?? "").trim() }))
    .filter((b) => b.slug && b.title);
  const setPlayTags = badges.map((b) => ({ id: b.slug, title: b.title }));

  const circulation = num(r.circulation_count);
  const burned = num(r.burned);
  const owned = num(r.owned);
  const locked = num(r.locked);

  return {
    id: extId,
    external_id: extId,
    collection_id: ALLDAY_COLLECTION_ID,
    set_name: r.set_name ?? null,
    player_name: r.player_name ?? null,
    tier: r.tier ?? null,
    series_number: r.series_number ?? null,
    badge_score: setPlayTags.length,
    play_tags: [] as Array<{ id: string; title: string }>,
    set_play_tags: setPlayTags,
    is_three_star_rookie: false,
    has_rookie_mint: r.has_rookie_mint === true || badges.some((b) => b.slug === "rookie-mint"),
    parallel_id: r.parallel_id ?? 0,
    parallel_name: r.parallel_name ?? "Standard",
    low_ask: r.low_ask ?? null,
    highest_offer: r.highest_offer ?? null,
    avg_sale_price: r.avg_sale_price ?? null,
    circulation_count: circulation,
    effective_supply: null as number | null,
    burned,
    locked,
    owned,
    hidden_in_packs: r.hidden_in_packs ?? null,
    burn_rate_pct: circulation > 0 ? parseFloat(((burned / circulation) * 100).toFixed(1)) : 0,
    lock_rate_pct: owned > 0 ? parseFloat(((locked / owned) * 100).toFixed(1)) : 0,
    flow_retired: false,
    asset_path_prefix: `https://media.nflallday.com/editions/${extId}/media/`,
    updated_at: new Date().toISOString(),
  };
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const rawRows = Array.isArray(body.rows) ? (body.rows as RunnerRow[]) : [];
  const rows = rawRows.map(buildBadgeRow).filter((r): r is NonNullable<typeof r> => r !== null);

  let upserted = 0;
  let upsertErrors = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const { error } = await (supabaseAdmin as any)
      .from("badge_editions")
      .upsert(chunk, { onConflict: "external_id,collection_id" });
    if (error) {
      console.log(`[${PIPELINE_NAME}] upsert chunk ${i} error: ${error.message}`);
      upsertErrors++;
    } else {
      upserted += chunk.length;
    }
  }

  // Terminal POST — log one pipeline_runs row with the runner's cumulative stats.
  if (body.final) {
    const stats = (body.stats as Record<string, unknown>) ?? {};
    try {
      await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: (body.startedAt as string) ?? new Date().toISOString(),
        p_rows_found: num(stats.editions_fetched),
        p_rows_written: num(stats.rows_upserted),
        p_rows_skipped: num(stats.editions_skipped),
        p_ok: body.ok !== false && upsertErrors === 0,
        p_error: (body.error as string) ?? (upsertErrors > 0 ? "upsert_errors" : null),
        p_collection_slug: "nfl_all_day",
        p_extra: { ...stats, upsert_errors: upsertErrors },
      });
    } catch (e) {
      console.log(`[${PIPELINE_NAME}] log_pipeline_run err: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return NextResponse.json({ ok: upsertErrors === 0, upserted, upsertErrors }, { status: 200 });
}
