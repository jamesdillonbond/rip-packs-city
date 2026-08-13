// app/api/admin/backfill-topshot-catalog/route.ts
//
// Walks the Top Shot GQL one set at a time and hydrates every edition into
// our local `editions` table. Closes the catalog gap that drives the set
// tracker mismatch (49 complete vs Top Shot's reported 87) and fills the
// 23% thumbnail / 100% video gap on existing TopShot rows.
//
// Auth: Bearer RPC_ADMIN_TOKEN (or ?token=) — this route accepts NOTHING else,
// which is why it cannot be scheduled directly.
// Methods: GET or POST — both run the same loop.
//
// Cron: /api/cron/topshot-catalog-backfill (Vercel, daily 02:12 UTC) wraps this
// route and translates CRON_SECRET → RPC_ADMIN_TOKEN. ⚠ The header used to
// claim "daily at 4am ET (cron-job.org)"; that was STALE — measured 2026-08-13
// the pipeline had only 4 lifetime `pipeline_runs` rows, all manual, and
// commit b1018e63 independently confirmed the route was absent from
// vercel.json and every workflow. Do NOT add a vercel.json entry pointing at
// THIS path: Vercel cron sends only `Bearer $CRON_SECRET`, so it would 401 on
// every tick, and a 401 writes no pipeline_runs row — indistinguishable from
// never having been scheduled.
//
// Loop control: orders sets by updated_at ASC (least-recently-touched first),
// bounded by maxDuration - 30s, paginates 100 editions/page through
// TS_PROXY_URL. 250ms delay between set-level GQL calls. ?startAfter=<uuid>
// resumes from a specific set.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";
import { normalizePlayDescription } from "@/lib/topshot/play-description";

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
//
// `assetPathPrefix` is the authoritative GQL field for CDN media URLs.
// Shape: https://assets.nbatopshot.com/editions/{set_int}_{set_slug}_{tier_slug}/{play_uuid}/play_{play_uuid}_{set_int}_{set_slug}_{tier_slug}_capture_
// Append "Hero_2880_2880_Transparent.png" for image, "Animated_1080_1080_Black.mp4" for video.
// Synthesizing /resize/editions/{set_int}_{play_int}/... short-path URLs (the
// pre-2026-05-12 behavior) 404s on the CDN.
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
                assetPathPrefix
                set {
                  flowId
                  flowName
                  flowSeriesNumber
                }
                play {
                  flowID
                  description
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
  assetPathPrefix?: string | null;
  set?: {
    flowId?: number | string | null;
    flowName?: string | null;
    flowSeriesNumber?: number | null;
  } | null;
  play?: {
    flowID?: string | null;
    /**
     * Prose description of the play — the paragraph the Top Shot moment page
     * renders. Sample (live, 2026-08-11): "Mike James has returned to make an
     * impact at the NBA level. The Brooklyn Nets guard drives hard along the
     * baseline…". The ONLY narrative text in the catalog; without it a search
     * for "game winner" has nothing to match.
     *
     * ⚠ IT LIVES ON `Play`, NOT ON `PlayStats`. Putting it inside `stats { }`
     * makes the WHOLE query invalid — Top Shot answers HTTP 422 for an invalid
     * query, `fetchPage` returns null, and the walk silently upserts ZERO
     * editions while still reporting ok:true with one gql_call per set. That
     * regression shipped on 2026-08-11 and was caught only because
     * editions_upserted was 0 with gql_calls exactly equal to sets_processed.
     * `headline` is also on Play and is NOT ingested: its value is just the
     * player name again, not the moment page's editorial title.
     */
    description?: string | null;
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

// Image/video URLs are built off the GQL `assetPathPrefix` field — never
// synthesized from set/play integer IDs. The short-path /resize/editions/{set_int}_{play_int}/
// pattern that this function used to emit 404s on the live CDN; the
// authoritative GQL prefix is the long /editions/{set_slug}/{play_uuid}/play_..._capture_ form.
function buildThumbnailUrl(prefix: string | null | undefined): string | null {
  if (!prefix) return null;
  return `${prefix}Hero_2880_2880_Transparent.png`;
}

function buildVideoUrl(prefix: string | null | undefined): string | null {
  if (!prefix) return null;
  if (prefix.endsWith(".mp4")) return prefix;
  return `${prefix}Animated_1080_1080_Black.mp4`;
}

/**
 * Outcome of one GQL page fetch.
 *
 * ⚠ This used to be `… | null`, and that single collapsed `null` is why the
 * 2026-08-11 malformed-query bug (description selected on `PlayStats`, which
 * 422s) was invisible: "the set has no editions" and "we could not ask" are
 * opposite facts that shared one return value. The first is a result, the
 * second is a failure to obtain one. Two live runs reported sets_processed=257
 * / editions_upserted=0 / errors_count=0 and read as clean.
 *
 * The `fault` string carries the HTTP status or the GQL error message, because
 * for a malformed query the upstream's own body names the offending field and
 * is the entire diagnostic — it was being thrown away.
 */
type PageFetch =
  | { ok: true; editions: RawEdition[]; nextCursor: string | null }
  | { ok: false; fault: string };

async function fetchEditionsPage(
  setUuid: string,
  cursor: string,
): Promise<PageFetch> {
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
    if (!res.ok) {
      // The BODY is the diagnostic: Top Shot answers 422 for an invalid query
      // and names the offending field in the message.
      const body = await res.text().catch(() => "");
      return { ok: false, fault: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    const json = (await res.json()) as { data?: Resp; errors?: unknown[] };
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      const first = json.errors[0] as { message?: string } | undefined;
      return { ok: false, fault: `gql: ${String(first?.message ?? "unknown").slice(0, 200)}` };
    }
    const summary = json.data?.searchEditions?.searchSummary;
    return {
      ok: true,
      editions: summary?.data?.data ?? [],
      nextCursor: summary?.pagination?.rightCursor ?? null,
    };
  } catch (e) {
    return { ok: false, fault: e instanceof Error ? e.message.slice(0, 200) : "fetch failed" };
  }
}

/**
 * `fault` is the reason the walk stopped early, or null when it completed.
 * A set that genuinely holds no editions returns `editions: []` with
 * `fault: null` — the caller must not conflate the two.
 */
async function walkSet(
  setUuid: string,
): Promise<{ editions: RawEdition[]; gqlCalls: number; fault: string | null }> {
  const collected: RawEdition[] = [];
  const seenCursors = new Set<string>();
  let cursor = "";
  let gqlCalls = 0;
  let fault: string | null = null;
  // Hard cap at 50 pages = 5000 editions/set. No real Top Shot set is that
  // large; this is a runaway-loop guard.
  for (let page = 0; page < 50; page++) {
    if (cursor && seenCursors.has(cursor)) break;
    if (cursor) seenCursors.add(cursor);
    const result = await fetchEditionsPage(setUuid, cursor);
    gqlCalls++;
    if (!result.ok) {
      // Page 0 failing means we learned nothing about this set. A later page
      // failing means we hold a PARTIAL set, which is still a fault: upserting
      // it silently would look like a complete walk.
      fault = `page ${page}: ${result.fault}`;
      break;
    }
    const { editions, nextCursor } = result;
    collected.push(...editions);
    // Loop while cursor is truthy and not equal to the previous cursor.
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  return { editions: collected, gqlCalls, fault };
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
  description: string | null;
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

  const prefix = e.assetPathPrefix ?? null;
  const thumbnailUrl = buildThumbnailUrl(prefix);
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
    // Set unconditionally (null when absent), matching how every other field
    // in this row is treated: this route is the AUTHORITATIVE Top Shot catalog
    // walker, so a bulk upsert with the key present on some rows and missing on
    // others would be an inconsistent payload. Empty string collapses to null
    // so "has prose" stays a simple NOT NULL test.
    description: normalizePlayDescription(e.play?.description),
    updated_at: now,
  };
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();

  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  // NOTE: ?startAfter=<uuid> is technically broken because every walked set
  // gets its updated_at bumped, so the cursor uuid no longer appears in the
  // "least-recently-touched" page on the next call — passing the last walked
  // uuid usually returns "no more sets". The natural-order pattern (no
  // cursor) sweeps correctly and is how cron uses it. Left in for ad-hoc use.
  const startAfter = req.nextUrl.searchParams.get("startAfter");
  const limitSets = req.nextUrl.searchParams.get("limitSets");
  const limitSetsNum = limitSets ? Math.max(1, parseInt(limitSets, 10) || 1) : null;
  // forceRefresh=stale_thumbnails picks sets that contain editions whose
  // thumbnail_url matches one of three pre-2026-05-12 broken patterns. Targets
  // the ~8,500-row legacy backfill without disturbing the natural
  // least-recently-touched sweep used by cron.
  const forceRefresh = req.nextUrl.searchParams.get("forceRefresh");
  const staleThumbnailMode = forceRefresh === "stale_thumbnails";

  const supabase: any = supabaseAdmin;

  type SetRow = {
    id: string;
    external_id: string | null;
    name: string;
    set_id_onchain: number | null;
    cover_art_url: string | null;
    asset_path_prefix: string | null;
    updated_at: string | null;
  };

  let candidateSets: SetRow[];
  if (staleThumbnailMode) {
    // Walk sets in descending order of broken-thumbnail count. Resolves the
    // worst-affected sets first so any user-visible improvement compounds.
    const { data: brokenSetsRaw, error: brokenErr } = await supabase.rpc(
      "topshot_sets_with_stale_thumbnails",
      { p_limit: 1000 },
    );
    if (brokenErr) {
      return NextResponse.json({ error: brokenErr.message }, { status: 500 });
    }
    const ids: string[] = (brokenSetsRaw ?? []).map((r: { set_id: string }) => r.set_id);
    if (ids.length === 0) {
      return NextResponse.json({
        ok: true,
        pipeline: PIPELINE_NAME,
        mode: "stale_thumbnails",
        sets_processed: 0,
        terminated_reason: "no_stale_thumbnails",
      });
    }
    const { data: setsRaw, error: setsErr } = await supabase
      .from("sets")
      .select("id, external_id, name, set_id_onchain, cover_art_url, asset_path_prefix, updated_at")
      .in("id", ids);
    if (setsErr) {
      return NextResponse.json({ error: setsErr.message }, { status: 500 });
    }
    // Preserve RPC ordering (most-broken first) inside the JS array.
    const byId = new Map<string, SetRow>((setsRaw as SetRow[]).map((s) => [s.id, s]));
    candidateSets = ids
      .map((id) => byId.get(id))
      .filter((s): s is SetRow => !!s && !!s.external_id && UUID_RE.test(s.external_id));
  } else {
    // Pull the candidate set list. Never-catalogued sets (asset_path_prefix
    // NULL) come first so a brand-new drop's art lands on the next run; within
    // each group order least-recently-touched first. Once a set is catalogued
    // its asset_path_prefix is non-null and it falls back into the steady-state
    // updated_at ordering. Resume by skipping any set before startAfter.
    const { data: setsRaw, error: setsErr } = await supabase
      .from("sets")
      .select("id, external_id, name, set_id_onchain, cover_art_url, asset_path_prefix, updated_at")
      .eq("collection_id", COLLECTION_ID)
      .order("asset_path_prefix", { ascending: true, nullsFirst: true })
      .order("updated_at", { ascending: true, nullsFirst: true })
      .limit(1000);
    if (setsErr) {
      return NextResponse.json({ error: setsErr.message }, { status: 500 });
    }
    candidateSets = (setsRaw as SetRow[]).filter(
      (s) => s.external_id && UUID_RE.test(s.external_id),
    );
    if (startAfter) {
      const idx = candidateSets.findIndex((s) => s.id === startAfter);
      if (idx >= 0) candidateSets = candidateSets.slice(idx + 1);
    }
  }

  const timeBudgetMs = (maxDuration * 1000) - TIME_BUDGET_OVERHEAD_MS;
  let editionsUpserted = 0;
  let editionsSkipped = 0;
  let setsProcessed = 0;
  let setsWithCoverSet = 0;
  let setsFaulted = 0;
  let upsertErrors = 0;
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
    const { editions, gqlCalls: setGqlCalls, fault } = await walkSet(setUuid);
    gqlCalls += setGqlCalls;

    // Recorded even when some editions came back: a PARTIAL walk upserted
    // silently is indistinguishable from a complete one.
    if (fault) {
      setsFaulted++;
      errors.push({ set_id: setRow.id, reason: fault });
    }

    if (editions.length === 0) {
      // An empty set (rare) or a faulted walk — now told apart by `fault`
      // above, so this branch is only about not getting stuck re-walking the
      // same set every tick. The updated_at stamp is applied in BOTH cases
      // deliberately: withholding it on a fault would pin a persistently
      // broken set at the head of the least-recently-touched queue forever
      // and starve every set behind it.
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
        upsertErrors++;
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
    const sampleAssetPrefix = sample?.assetPathPrefix ?? null;
    const sampleHero = buildThumbnailUrl(sampleAssetPrefix);

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
  // `ok` deliberately does NOT redden on a single fault: Top Shot GQL is
  // intermittently flaky, and a chronically-red pipeline trains the operator
  // to skim past it — the lesson this repo already paid for with
  // ufc_fmv_stale_hours. What IS unambiguous, and is exactly the shape of the
  // 2026-08-11 malformed-query bug, is EVERY walked set faulting: that cannot
  // be upstream noise, it means we are asking a question the upstream refuses.
  // Partial faults stay fully visible in errors_count / errors_sample /
  // sets_faulted without flipping the flag.
  const totalFault = setsProcessed > 0 && setsFaulted >= setsProcessed;
  const ok = upsertErrors === 0 && !totalFault;

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
        sets_faulted: setsFaulted,
        editions_upserted: editionsUpserted,
        editions_skipped: editionsSkipped,
        gql_calls: gqlCalls,
        duration_ms: durationMs,
        last_set_id: lastSetId,
        terminated_reason: terminatedReason,
        errors_sample: errors.slice(0, 5),
        start_after: startAfter,
        mode: staleThumbnailMode ? "stale_thumbnails" : "natural",
      },
    });
  } catch {
    // Observability is best-effort.
  }

  return NextResponse.json({
    ok,
    pipeline: PIPELINE_NAME,
    mode: staleThumbnailMode ? "stale_thumbnails" : "natural",
    sets_processed: setsProcessed,
    sets_with_cover_set: setsWithCoverSet,
    sets_faulted: setsFaulted,
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
