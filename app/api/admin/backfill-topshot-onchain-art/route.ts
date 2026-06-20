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
// edition still missing a thumbnail and fills HERO->thumbnail_url +
// VIDEO->video_url from the public IPFS gateway. NULLs only — never clobbers.
//
// Auth: Bearer RPC_ADMIN_TOKEN (or ?token=). GET or POST.
// Recommended cron: daily, a few minutes AFTER topshot-catalog-backfill, so
// the GQL pass fills what it can and this mops up the genuinely-new drops.
//
// Egress note: Flow's access-node REST `/v1/scripts` is reachable from Vercel
// (the wallet-backfill cron reads on-chain IDs through it every tick — see
// lib/chains/flow/wallet-backfill-helpers.ts `fetchOnChainIds`), so no proxy
// worker is needed. The Cloudflare proxies front the GraphQL / Flowty APIs,
// which DO block Vercel egress; the Flow access node does not.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";

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
    throw new Error(`Flow script HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
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
  video_url: string | null;
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();

  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const batchParam = req.nextUrl.searchParams.get("limit");
  const batch = Math.min(
    MAX_BATCH,
    Math.max(1, batchParam ? parseInt(batchParam, 10) || DEFAULT_BATCH : DEFAULT_BATCH),
  );

  const supabase: any = supabaseAdmin;

  // Canonical int-keyed TS editions missing a thumbnail. set_id_onchain /
  // play_id_onchain are non-null only on canonical rows — the inert UUID dupes
  // have them nulled by editions_block_topshot_uuid_dupe_trg, so this naturally
  // excludes them. Newest first so fresh drops get art on the next tick.
  const { data: rowsRaw, error: selErr } = await supabase
    .from("editions")
    .select("id, external_id, set_id_onchain, play_id_onchain, video_url")
    .eq("collection_id", COLLECTION_ID)
    .is("thumbnail_url", null)
    .not("set_id_onchain", "is", null)
    .not("play_id_onchain", "is", null)
    .order("created_at", { ascending: false })
    .limit(batch);
  if (selErr) {
    return NextResponse.json({ error: selErr.message }, { status: 500 });
  }
  const rows = (rowsRaw ?? []) as NullArtRow[];

  const timeBudgetMs = maxDuration * 1000 - TIME_BUDGET_OVERHEAD_MS;
  let scanned = 0;
  let thumbsFilled = 0;
  let videosFilled = 0;
  let resolverMisses = 0;
  let terminatedReason = "no_more_editions";
  const errors: Array<{ edition: string; reason: string }> = [];

  for (const row of rows) {
    if (Date.now() - startedAt > timeBudgetMs) {
      terminatedReason = "time_budget_exceeded";
      break;
    }
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

    // Fill NULLs only. thumbnail_url is null by query; video_url may already be
    // set by the GQL pass, so only write it when currently null.
    const update: Record<string, unknown> = {};
    if (cids.HERO) update.thumbnail_url = `${IPFS_GATEWAY}${cids.HERO}`;
    if (cids.VIDEO && row.video_url == null) update.video_url = `${IPFS_GATEWAY}${cids.VIDEO}`;

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

  const durationMs = Date.now() - startedAt;
  const ok = errors.length === 0;

  try {
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
