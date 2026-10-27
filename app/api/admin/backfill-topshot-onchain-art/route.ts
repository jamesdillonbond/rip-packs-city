// app/api/admin/backfill-topshot-onchain-art/route.ts
//
// On-chain art fallback for Top Shot editions. Closes the long-standing
// new-drop gap: editions seeded via the Cadence wallet-walk get int-pair
// metadata (set_id_onchain / play_id_onchain) but NO art, and only the GQL
// `topshot-catalog-backfill` writes thumbnails — and only when the set has
// surfaced in the GQL editions catalog, which lags fresh drops.
//
// As of 2026-06-10 the `TopShotIPFSResolver` contract (0x0b2a3299cc857e29)
// exposes a public `getCIDs(setID, playID, subeditionID) -> {String: String}?`
// view returning a mediaType->CID map (HERO, VIDEO, ...). It is populated at
// admin-write time and is FRESHER than both the GQL catalog and Dapper's
// reference-app bundle. This route reads it for every canonical int-keyed TS
// edition with no art (thumbnail NULL) or either media on the legacy
// assets.nbatopshot.com/editions/ CDN path, and fills
// HERO->thumbnail_url + VIDEO->video_url from the public IPFS gateway.
// ⓘ "Legacy" is not "dead" today: re-measured 2026-10-14, 10/10 sampled legacy
// thumbnails returned 200 image/png and 7/7 legacy videos 206. The move to the
// contract-advertised IPFS CIDs (already serving 2,368 TS editions) is for
// durability, not a live outage. Writes
// only when the resolver returns a CID, so it never clobbers a working URL.
//
// Auth: Bearer RPC_ADMIN_TOKEN (or ?token=), INGEST_SECRET_TOKEN, or CRON_SECRET
// — the last so a Vercel cron can drive it (Vercel injects Bearer $CRON_SECRET).
// Mirrors backfill-pinnacle-catalog / backfill-topshot-subedition-circulation.
// GET or POST.
// Cron: driven by vercel.json (`22 */3 * * *`, ?limit=300) so the on-chain
// IPFS-resolver mop-up runs on a schedule instead of relying on an external
// cron-job.org entry. It's idempotent and never clobbers a working URL, so it
// composes fine with the GQL topshot-catalog-backfill regardless of ordering.
//
// Egress note: Flow's access-node REST `/v1/scripts` is reachable from Vercel
// (the wallet-backfill cron reads on-chain IDs through it every tick — see
// lib/chains/flow/wallet-backfill-helpers.ts `fetchOnChainIds`), so no proxy
// worker is needed. The Cloudflare proxies front the GraphQL / Flowty APIs,
// which DO block Vercel egress; the Flow access node does not.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";
import { bearerMatches } from "@/lib/auth/bearer-secret";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";
const COLLECTION_SLUG = "nba-top-shot";
const PIPELINE_NAME = "topshot-onchain-art-backfill";

// Public IPFS gateway the TopShotIPFSResolver contract advertises (and the
// gateway our edition pages + topshot_ipfs_assets rows already use).
const IPFS_GATEWAY = "https://ipfs.dapperlabs.com/ipfs/";
const FLOW_REST = "https://rest-mainnet.onflow.org/v1/scripts";

const DEFAULT_BATCH = 80;
// The fresh-drop leg (thumbnail NULL, newest first) takes at most this many of
// a run's slots; the rest walk the legacy-URL population behind a cursor.
const FRESH_LEG_MAX = 50;
const MAX_BATCH = 300;
const TIME_BUDGET_OVERHEAD_MS = 30_000;
const PER_REQUEST_TIMEOUT_MS = 20_000;
const CALL_DELAY_MS = 100;

// Verified live 2026-06-10 against rest-mainnet (set 2 / play 188 / sub 0 ->
// HERO + VIDEO matching topshot_ipfs_assets exactly). Base parallel = sub 0.
const GET_CIDS_SCRIPT = `import TopShotIPFSResolver from 0x0b2a3299cc857e29
access(all) fun main(setID: UInt32, playID: UInt32, sub: UInt32): {String: String}? {
  return TopShotIPFSResolver.getCIDs(setID: setID, playID: playID, subeditionID: sub)
}`;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// UInt32 Cadence args must be JSON-CDC with the value as a STRING (numeric
// values are rejected by the access node). Each arg is base64(JSON).
function encodeUInt32(n: number): string {
  return btoa(JSON.stringify({ type: "UInt32", value: String(n) }));
}

// Returns the mediaType->CID map for an edition, or null when the resolver has
// no entry (Optional == nil) or the read fails. Throws only on transport so the
// caller can record it; a nil result is a clean "not pinned yet".
async function fetchEditionCids(
  setId: number,
  playId: number,
  subId: number = 0,
): Promise<Record<string, string> | null> {
  const body = {
    script: btoa(GET_CIDS_SCRIPT),
    arguments: [encodeUInt32(setId), encodeUInt32(playId), encodeUInt32(subId)],
  };
  const res = await fetch(`${FLOW_REST}?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Keep the whole cause: Flow nests it (e.g. "[Error Code: 1110] computation limit exceeded") ~400 chars in.
    throw new Error(`Flow script HTTP ${res.status}: ${(await res.text()).slice(0, 2000)}`);
  }
  const raw = await res.text();
  // Response is a base64 string wrapped in JSON quotes.
  const decoded = JSON.parse(atob(raw.trim().replace(/^"|"$/g, "")));
  // Shape: { type:"Optional", value: nil | { type:"Dictionary", value:[ {key:{value},value:{value}} ] } }
  const opt = decoded?.value;
  if (!opt || !Array.isArray(opt.value)) return null;
  const map: Record<string, string> = {};
  for (const pair of opt.value) {
    const k = pair?.key?.value;
    const v = pair?.value?.value;
    if (typeof k === "string" && typeof v === "string" && v.length > 0) map[k] = v;
  }
  return Object.keys(map).length > 0 ? map : null;
}

interface NullArtRow {
  id: string;
  external_id: string | null;
  set_id_onchain: number | null;
  play_id_onchain: number | null;
  thumbnail_url: string | null;
  video_url: string | null;
}

// A media URL is replaceable when it's null or still on the legacy editions/ CDN path.
function isDeadMedia(url: string | null): boolean {
  return url == null || url.includes("assets.nbatopshot.com/editions/");
}

// Accept the admin token (Bearer or ?token=), the GitHub-Actions ingest token,
// or the Vercel-cron secret — mirrors backfill-pinnacle-catalog so the mop-up
// can be driven by a Vercel cron (which sends only Bearer CRON_SECRET). All
// three are equivalent-trust server secrets.
function authed(req: NextRequest): boolean {
  if (verifyAdminRequest(req)) return true;
  const header = req.headers.get("authorization") ?? "";
  const ingest = process.env.INGEST_SECRET_TOKEN;
  const cron = process.env.CRON_SECRET;
  if (ingest && bearerMatches(header, "INGEST_SECRET_TOKEN")) return true;
  if (cron && bearerMatches(header, "CRON_SECRET")) return true;
  return false;
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!authed(req)) return adminUnauthorizedResponse();

  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const batchParam = req.nextUrl.searchParams.get("limit");
  const batch = Math.min(
    MAX_BATCH,
    Math.max(1, batchParam ? parseInt(batchParam, 10) || DEFAULT_BATCH : DEFAULT_BATCH),
  );

  const supabase: any = supabaseAdmin;

  // Canonical int-keyed TS editions with no working art: thumbnail_url NULL, or
  // either media still on the legacy assets.nbatopshot.com/editions/ CDN path.
  // set_id_onchain / play_id_onchain are non-null only on canonical rows — the
  // inert UUID dupes have them nulled by editions_block_topshot_uuid_dupe_trg, so
  // this naturally excludes them. We only ever WRITE when getCIDs returns a CID,
  // and a working ipfs/CDN URL is never clobbered (it matches neither class).
  //
  // ⚠ TWO LEGS, because one newest-first read never progressed (measured
  // 2026-10-14): a miss writes nothing, so the 300 newest candidates — all of them
  // resolver-nil — were re-read every run (300/300 misses, rows_written 0, logged
  // `no_more_editions`) while ~9,000 OLDER legacy-URL editions, which getCIDs DOES
  // resolve (sampled at ranks 1,000 / 3,000 / 6,000 / 9,000: HERO + VIDEO), were
  // never reached. An order on an immutable key re-reads its own head forever.
  //   (A) fresh drops: thumbnail NULL, newest first, at most FRESH_LEG_MAX — the
  //       new-drop gap this route exists for, reached on the next tick;
  //   (B) the legacy-URL population, keyset-paged by id after the cursor the
  //       previous run recorded (pipeline_runs.extra.next_cursor), wrapping to
  //       the start when a page comes back short. A failed cursor read starts
  //       from the beginning: re-reading is safe, skipping is not.
  const DEAD_CDN = "*assets.nbatopshot.com/editions/*";
  const COLS = "id, external_id, set_id_onchain, play_id_onchain, thumbnail_url, video_url";

  const { data: freshRaw, error: freshErr } = await supabase
    .from("editions")
    .select(COLS)
    .eq("collection_id", COLLECTION_ID)
    .is("thumbnail_url", null)
    .not("set_id_onchain", "is", null)
    .not("play_id_onchain", "is", null)
    .order("created_at", { ascending: false })
    .limit(Math.min(FRESH_LEG_MAX, batch));
  if (freshErr) {
    return NextResponse.json({ error: freshErr.message }, { status: 500 });
  }
  const fresh = (freshRaw ?? []) as NullArtRow[];

  let cursor: string | null = null;
  let cursorReadError: string | null = null;
  try {
    const { data: prev, error: prevErr } = await supabase
      .from("pipeline_runs")
      .select("extra")
      .eq("pipeline", PIPELINE_NAME)
      .order("started_at", { ascending: false })
      .limit(1);
    if (prevErr) cursorReadError = prevErr.message;
    const c = prev?.[0]?.extra?.next_cursor;
    if (typeof c === "string" && c.length > 0) cursor = c;
  } catch (e) {
    cursorReadError = e instanceof Error ? e.message : String(e);
  }

  const legacyWant = Math.max(0, batch - fresh.length);
  let legacy: NullArtRow[] = [];
  if (legacyWant > 0) {
    let q = supabase
      .from("editions")
      .select(COLS)
      .eq("collection_id", COLLECTION_ID)
      .or(`thumbnail_url.like.${DEAD_CDN},video_url.like.${DEAD_CDN}`)
      .not("set_id_onchain", "is", null)
      .not("play_id_onchain", "is", null);
    if (cursor) q = q.gt("id", cursor);
    const { data: legacyRaw, error: legacyErr } = await q.order("id", { ascending: true }).limit(legacyWant);
    if (legacyErr) {
      return NextResponse.json({ error: legacyErr.message }, { status: 500 });
    }
    legacy = (legacyRaw ?? []) as NullArtRow[];
  }
  // A short page means the walk reached the end of the population: next run wraps.
  const lapComplete = legacy.length < legacyWant;
  const legacyIds = new Set(legacy.map((r) => r.id));
  const rowsRaw = [...fresh.filter((r) => !legacyIds.has(r.id)), ...legacy];
  const rows = (rowsRaw ?? []) as NullArtRow[];

  const timeBudgetMs = maxDuration * 1000 - TIME_BUDGET_OVERHEAD_MS;
  let scanned = 0;
  let thumbsFilled = 0;
  let videosFilled = 0;
  let resolverMisses = 0;
  let terminatedReason = lapComplete ? "lap_complete" : "batch_full";
  let lastLegacyScanned: string | null = null;
  const errors: Array<{ edition: string; reason: string }> = [];

  for (const row of rows) {
    if (Date.now() - startedAt > timeBudgetMs) {
      terminatedReason = "time_budget_exceeded";
      break;
    }
    if (legacyIds.has(row.id)) lastLegacyScanned = row.id;
    const setId = row.set_id_onchain;
    const playId = row.play_id_onchain;
    if (setId == null || playId == null) continue;
    // Subedition (parallel) rows are keyed setID:playID::subID. Resolve the
    // subedition id from the external_id so getCIDs returns THAT parallel's art
    // (Hexwave/Jukebox/... each have distinct media) — never the Standard art.
    const subId =
      row.external_id && row.external_id.includes("::")
        ? parseInt(row.external_id.split("::")[1], 10) || 0
        : 0;
    scanned++;

    let cids: Record<string, string> | null;
    try {
      cids = await fetchEditionCids(setId, playId, subId);
    } catch (e) {
      errors.push({ edition: row.external_id ?? row.id, reason: e instanceof Error ? e.message : String(e) });
      await sleep(CALL_DELAY_MS);
      continue;
    }

    if (!cids) {
      resolverMisses++;
      await sleep(CALL_DELAY_MS);
      continue;
    }

    // Fill missing/dead media only — never overwrite a working ipfs/CDN URL.
    const update: Record<string, unknown> = {};
    if (cids.HERO && isDeadMedia(row.thumbnail_url)) update.thumbnail_url = `${IPFS_GATEWAY}${cids.HERO}`;
    if (cids.VIDEO && isDeadMedia(row.video_url)) update.video_url = `${IPFS_GATEWAY}${cids.VIDEO}`;

    if (Object.keys(update).length > 0) {
      update.updated_at = new Date().toISOString();
      const { error: updErr } = await supabase.from("editions").update(update).eq("id", row.id);
      if (updErr) {
        errors.push({ edition: row.external_id ?? row.id, reason: updErr.message });
      } else {
        if (update.thumbnail_url) thumbsFilled++;
        if (update.video_url) videosFilled++;
      }
    } else {
      resolverMisses++;
    }

    await sleep(CALL_DELAY_MS);
  }

  // Where the next run's legacy leg starts: after the last row this run SCANNED
  // (a budget break resumes there), or the beginning once the lap is complete.
  const nextCursor =
    terminatedReason === "time_budget_exceeded"
      ? (lastLegacyScanned ?? cursor)
      : lapComplete
        ? null
        : (legacy.length > 0 ? legacy[legacy.length - 1].id : cursor);
  const durationMs = Date.now() - startedAt;
  const ok = errors.length === 0;

  try {
    // write-discarded: run telemetry; a failed log row cannot change what the run did, and shows up as a missing run.
    await supabase.from("pipeline_runs").insert({
      pipeline: PIPELINE_NAME,
      collection_slug: COLLECTION_SLUG,
      started_at: startedAtIso,
      finished_at: new Date().toISOString(),
      rows_found: rows.length,
      rows_written: thumbsFilled + videosFilled,
      rows_skipped: resolverMisses,
      ok,
      error: errors.length > 0 ? errors.slice(0, 3).map((e) => e.reason).join(" | ") : null,
      extra: {
        scanned,
        thumbs_filled: thumbsFilled,
        videos_filled: videosFilled,
        resolver_misses: resolverMisses,
        batch,
        duration_ms: durationMs,
        terminated_reason: terminatedReason,
        fresh_candidates: fresh.length,
        legacy_candidates: legacy.length,
        cursor,
        next_cursor: nextCursor,
        cursor_read_error: cursorReadError,
        errors_sample: errors.slice(0, 5),
      },
    });
  } catch {
    // Observability is best-effort.
  }

  return NextResponse.json({
    ok,
    pipeline: PIPELINE_NAME,
    candidates: rows.length,
    scanned,
    thumbs_filled: thumbsFilled,
    videos_filled: videosFilled,
    resolver_misses: resolverMisses,
    batch,
    duration_ms: durationMs,
    terminated_reason: terminatedReason,
    fresh_candidates: fresh.length,
    legacy_candidates: legacy.length,
    next_cursor: nextCursor,
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
