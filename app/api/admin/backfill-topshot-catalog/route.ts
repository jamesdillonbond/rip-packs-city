// app/api/admin/backfill-topshot-catalog/route.ts
//
// Walks the Top Shot GQL one set at a time and hydrates every edition into
// our local `editions` table. Closes the catalog gap that drives the set
// tracker mismatch (49 complete vs Top Shot's reported 87) and fills the
// 23% thumbnail / 100% video gap on existing TopShot rows.
//
// Auth: Bearer RPC_ADMIN_TOKEN (or ?token=).
// Methods: GET or POST — both run the same loop.
// Cron: daily at 4am ET (cron-job.org).
//
// Loop control: orders sets by updated_at ASC (least-recently-touched first),
// bounded by maxDuration - 30s, paginates 100 editions/page through
// TS_PROXY_URL. 250ms delay between set-level GQL calls. ?startAfter=<uuid>
// resumes from a specific set.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";
const COLLECTION_SLUG = "nba-top-shot";
const PIPELINE_NAME = "topshot-catalog-backfill";

const TS_PROXY_URL_DEFAULT = "https://public-api.nbatopshot.com/graphql";
const PAGE_LIMIT = 100;
const SET_DELAY_MS = 250;
const TIME_BUDGET_OVERHEAD_MS = 30_000;
const PER_REQUEST_TIMEOUT_MS = 12_000;

// UUID-shape filter — sets table has 231 UUID rows, 1 int row, 2 set: slugs
// and 45 auto_* rows that are mis-categorized AllDay sets. Only UUID-format
// IDs are valid arguments to bySetIDs in the TopShot GQL.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Allowlisted SearchEditionBackfill operation. No Edition.id / Edition.flowID
// fields exist in this schema — only set.flowId and play.flowID. The double
// `data` wrapper inside `... on Editions { data { ... on Edition } }` is
// intentional and required by the schema.
const SEARCH_EDITIONS_QUERY = `
  query SearchEditionBackfill($input: SearchEditionsInput!) {
    searchEditions(input: $input) {
      searchSummary {
        pagination { rightCursor }
        data {
          ... on Editions {
            data {
              ... on Edition {
                tier
                circulationCount
                set {
                  flowId
                  flowName
                  flowSeriesNumber
                }
                play {
                  flowID
                  stats {
                    playerName
                    teamAtMoment
                    teamAtMomentNbaId
                    playCategory
                    playType
                    dateOfMoment
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface RawEdition {
  tier?: string | null;
  circulationCount?: number | null;
  set?: {
    flowId?: number | string | null;
    flowName?: string | null;
    flowSeriesNumber?: number | null;
  } | null;
  play?: {
    flowID?: string | null;
    stats?: {
      playerName?: string | null;
      teamAtMoment?: string | null;
      teamAtMomentNbaId?: string | number | null;
      playCategory?: string | null;
      playType?: string | null;
      dateOfMoment?: string | null;
    } | null;
  } | null;
}

function tsProxyUrl(): string {
  return process.env.TS_PROXY_URL || TS_PROXY_URL_DEFAULT;
}

function tsProxyHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "rip-packs-city/topshot-catalog-backfill",
  };
  if (process.env.TS_PROXY_SECRET) {
    h["X-Proxy-Secret"] = process.env.TS_PROXY_SECRET;
  }
  return h;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeTier(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = String(raw).toUpperCase().replace(/^MOMENT_TIER_/, "");
  if (t.includes("ULTIMATE")) return "ULTIMATE";
  if (t.includes("LEGENDARY")) return "LEGENDARY";
  if (t.includes("RARE")) return "RARE";
  if (t.includes("FANDOM")) return "FANDOM";
  if (t.includes("COMMON")) return "COMMON";
  return null;
}

// Mirrors getImageUrl() in components/MomentMedia.tsx — converts an
// editions/{flowId}_{flowID}/ prefix into the resize Hero image URL.
function buildThumbnailUrl(
  setFlowId: string | number | null | undefined,
  playFlowID: string | null | undefined,
): string | null {
  if (setFlowId == null || !playFlowID) return null;
  return `https://assets.nbatopshot.com/resize/editions/${setFlowId}_${playFlowID}/Hero_2880_2880_Transparent.png?format=webp&quality=80&width=600`;
}

function buildAssetPathPrefix(
  setFlowId: string | number | null | undefined,
  playFlowID: string | null | undefined,
): string | null {
  if (setFlowId == null || !playFlowID) return null;
  return `https://assets.nbatopshot.com/editions/${setFlowId}_${playFlowID}/`;
}

function buildVideoUrl(prefix: string | null | undefined): string | null {
  if (!prefix) return null;
  if (prefix.endsWith(".mp4")) return prefix;
  return `${prefix}Animated_1080_1080_Black.mp4`;
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
    operationName: "SearchEditionBackfill",
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

async function walkSet(
  setUuid: string,
): Promise<{ editions: RawEdition[]; gqlCalls: number }> {
  const collected: RawEdition[] = [];
  const seenCursors = new Set<string>();
  let cursor = "";
  let gqlCalls = 0;
  // Hard cap at 50 pages = 5000 editions/set. No real Top Shot set is that
  // large; this is a runaway-loop guard.
  for (let page = 0; page < 50; page++) {
    if (cursor && seenCursors.has(cursor)) break;
    if (cursor) seenCursors.add(cursor);
    const result = await fetchEditionsPage(setUuid, cursor);
    gqlCalls++;
    if (!result) break;
    const { editions, nextCursor } = result;
    collected.push(...editions);
    // Loop while cursor is truthy and not equal to the previous cursor.
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  return { editions: collected, gqlCalls };
}

interface EditionUpsertRow {
  external_id: string;
  collection_id: string;
  collection: string;
  set_id: string | null;
  name: string | null;
  player_name: string | null;
  set_name: string | null;
  team_name: string | null;
  tier: string | null;
  series: number | null;
  circulation_count: number | null;
  set_id_onchain: number | null;
  play_id_onchain: number | null;
  thumbnail_url: string | null;
  video_url: string | null;
  play_type: string | null;
  play_category: string | null;
  game_date: string | null;
  updated_at: string;
}

function buildEditionRow(
  e: RawEdition,
  localSetId: string,
  now: string,
): EditionUpsertRow | null {
  const setFlowIdRaw = e.set?.flowId ?? null;
  const playFlowID = e.play?.flowID ?? null;
  if (setFlowIdRaw == null || !playFlowID) return null;

  // External_id is the integer-pair key (set.flowId:play.flowID), matching
  // wallet_moments_cache.edition_key — not UUIDs. Aligns the catalog backfill
  // with the rest of the platform's int-format expectations.
  const externalId = `${setFlowIdRaw}:${playFlowID}`;

  const setFlowIdNum = Number.isFinite(Number(setFlowIdRaw))
    ? parseInt(String(setFlowIdRaw), 10)
    : null;
  const playFlowIDNum = Number.isFinite(Number(playFlowID))
    ? parseInt(String(playFlowID), 10)
    : null;

  const playerName = e.play?.stats?.playerName?.trim() ?? null;
  const setName = e.set?.flowName?.trim() ?? null;
  const name = playerName && setName ? `${playerName} — ${setName}` : playerName ?? setName;

  const prefix = buildAssetPathPrefix(setFlowIdRaw, playFlowID);
  const thumbnailUrl = buildThumbnailUrl(setFlowIdRaw, playFlowID);
  const videoUrl = buildVideoUrl(prefix);

  const dateOfMoment = e.play?.stats?.dateOfMoment ?? null;
  const dateSlice = dateOfMoment ? String(dateOfMoment).slice(0, 10) : null;
  const gameDate = dateSlice && /^\d{4}-\d{2}-\d{2}$/.test(dateSlice) ? dateSlice : null;

  return {
    external_id: externalId,
    collection_id: COLLECTION_ID,
    collection: "nba_top_shot",
    set_id: localSetId,
    name,
    player_name: playerName,
    set_name: setName,
    team_name: e.play?.stats?.teamAtMoment ?? null,
    tier: normalizeTier(e.tier),
    series: e.set?.flowSeriesNumber ?? null,
    circulation_count: e.circulationCount ?? null,
    set_id_onchain: setFlowIdNum,
    play_id_onchain: playFlowIDNum,
    thumbnail_url: thumbnailUrl,
    video_url: videoUrl,
    play_type: e.play?.stats?.playType ?? null,
    play_category: e.play?.stats?.playCategory ?? null,
    game_date: gameDate,
    updated_at: now,
  };
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();

  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const startAfter = req.nextUrl.searchParams.get("startAfter");
  const limitSets = req.nextUrl.searchParams.get("limitSets");
  const limitSetsNum = limitSets ? Math.max(1, parseInt(limitSets, 10) || 1) : null;

  // Pull the candidate set list. Order least-recently-touched first; resume
  // by skipping any set whose id sorts before startAfter when provided.
  const supabase: any = supabaseAdmin;
  const { data: setsRaw, error: setsErr } = await supabase
    .from("sets")
    .select("id, external_id, name, set_id_onchain, cover_art_url, asset_path_prefix, updated_at")
    .eq("collection_id", COLLECTION_ID)
    .order("updated_at", { ascending: true, nullsFirst: true })
    .limit(1000);
  if (setsErr) {
    return NextResponse.json({ error: setsErr.message }, { status: 500 });
  }

  type SetRow = {
    id: string;
    external_id: string | null;
    name: string;
    set_id_onchain: number | null;
    cover_art_url: string | null;
    asset_path_prefix: string | null;
    updated_at: string | null;
  };
  let candidateSets = (setsRaw as SetRow[]).filter(
    (s) => s.external_id && UUID_RE.test(s.external_id),
  );
  if (startAfter) {
    const idx = candidateSets.findIndex((s) => s.id === startAfter);
    if (idx >= 0) candidateSets = candidateSets.slice(idx + 1);
  }

  const timeBudgetMs = (maxDuration * 1000) - TIME_BUDGET_OVERHEAD_MS;
  let editionsUpserted = 0;
  let editionsSkipped = 0;
  let setsProcessed = 0;
  let setsWithCoverSet = 0;
  let gqlCalls = 0;
  let lastSetId: string | null = null;
  let terminatedReason: string = "no_more_sets";

  const errors: Array<{ set_id: string; reason: string }> = [];

  for (const setRow of candidateSets) {
    if (limitSetsNum != null && setsProcessed >= limitSetsNum) {
      terminatedReason = "limit_sets_reached";
      break;
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed > timeBudgetMs) {
      terminatedReason = "time_budget_exceeded";
      break;
    }

    const setUuid = setRow.external_id as string;
    const { editions, gqlCalls: setGqlCalls } = await walkSet(setUuid);
    gqlCalls += setGqlCalls;

    if (editions.length === 0) {
      // Either an empty set (rare) or a GQL fault. Mark processed and move on
      // so we don't get stuck re-walking it every tick.
      setsProcessed++;
      lastSetId = setRow.id;
      await supabase
        .from("sets")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", setRow.id);
      await sleep(SET_DELAY_MS);
      continue;
    }

    const now = new Date().toISOString();
    const rows: EditionUpsertRow[] = [];
    for (const e of editions) {
      const row = buildEditionRow(e, setRow.id, now);
      if (row) rows.push(row);
      else editionsSkipped++;
    }

    if (rows.length > 0) {
      const { error: upsertErr, count } = await supabase
        .from("editions")
        .upsert(rows, { onConflict: "external_id,collection_id", count: "exact" });
      if (upsertErr) {
        errors.push({ set_id: setRow.id, reason: upsertErr.message });
      } else {
        editionsUpserted += count ?? rows.length;
      }
    }

    // Parent-set update: stamp set_id_onchain (always, since the on-chain id
    // is canonical and shouldn't drift), cover_art_url + asset_path_prefix
    // only when missing so we don't churn a hand-set value.
    const sample = editions[0];
    const sampleSetFlowId = sample?.set?.flowId ?? null;
    const sampleAssetPrefix = buildAssetPathPrefix(sampleSetFlowId, sample?.play?.flowID);
    const sampleHero = buildThumbnailUrl(sampleSetFlowId, sample?.play?.flowID);

    const setUpdate: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (sampleSetFlowId != null && Number.isFinite(Number(sampleSetFlowId))) {
      setUpdate.set_id_onchain = parseInt(String(sampleSetFlowId), 10);
    }
    let coverChanged = false;
    if (!setRow.cover_art_url && sampleHero) {
      setUpdate.cover_art_url = sampleHero;
      coverChanged = true;
    }
    if (!setRow.asset_path_prefix && sampleAssetPrefix) {
      setUpdate.asset_path_prefix = sampleAssetPrefix;
    }
    await supabase.from("sets").update(setUpdate).eq("id", setRow.id);
    if (coverChanged) setsWithCoverSet++;

    setsProcessed++;
    lastSetId = setRow.id;
    await sleep(SET_DELAY_MS);
  }

  const durationMs = Date.now() - startedAt;
  const finishedAt = new Date().toISOString();
  const ok = errors.length === 0;

  try {
    await supabase.from("pipeline_runs").insert({
      pipeline: PIPELINE_NAME,
      collection_slug: COLLECTION_SLUG,
      started_at: startedAtIso,
      finished_at: finishedAt,
      rows_found: setsProcessed,
      rows_written: editionsUpserted,
      rows_skipped: editionsSkipped,
      ok,
      error: errors.length > 0 ? errors.slice(0, 3).map((e) => e.reason).join(" | ") : null,
      extra: {
        sets_processed: setsProcessed,
        sets_with_cover_set: setsWithCoverSet,
        editions_upserted: editionsUpserted,
        editions_skipped: editionsSkipped,
        gql_calls: gqlCalls,
        duration_ms: durationMs,
        last_set_id: lastSetId,
        terminated_reason: terminatedReason,
        errors_sample: errors.slice(0, 5),
        start_after: startAfter,
      },
    });
  } catch {
    // Observability is best-effort.
  }

  return NextResponse.json({
    ok,
    pipeline: PIPELINE_NAME,
    sets_processed: setsProcessed,
    sets_with_cover_set: setsWithCoverSet,
    editions_upserted: editionsUpserted,
    editions_skipped: editionsSkipped,
    gql_calls: gqlCalls,
    duration_ms: durationMs,
    last_set_id: lastSetId,
    terminated_reason: terminatedReason,
    errors_count: errors.length,
    errors_sample: errors.slice(0, 5),
    resume_hint: lastSetId
      ? `?startAfter=${lastSetId}`
      : null,
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
