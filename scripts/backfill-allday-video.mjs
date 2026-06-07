// scripts/backfill-allday-video.mjs
//
// One-off bulk backfill of editions.video_url for NFL All Day (0 -> ~6,191).
// AllDay thumbnails are 6,191/6,191 but video_url was never populated, so the
// hover-to-play tile (gated to TS + AllDay in EditionsGridPaginated/TileMedia)
// silently no-ops for AllDay. This closes that gap.
//
// Source: NFL All Day consumer GraphQL via the topshot-proxy worker
//   /allday-consumer route (X-Proxy-Secret auth) — Cloudflare WAF blocks
//   direct Vercel/Supabase egress, the worker carries browser headers.
//
// Verified schema (2026-06-07):
//   searchEditions(input:{ first:40, filters:{ byEditionFlowIDs:[Int!] } }){
//     edges{ node{ flowID assetURLs{ videoSquare } } } }
//   - flowID == editions.external_id for AllDay
//   - assetURLs.videoSquare is the 1080x1080 square animation .mp4 (the right
//     analog to TS's Animated_1080_1080 hover video; raw https URL, same style
//     editions.video_url already stores for Top Shot)
//   - the endpoint hard-caps at 40 edges/page, so chunk the ids at 40
//   - Cloudflare intermittently serves a JS challenge ("Just a moment...") to
//     the worker's egress IP; retry the chunk a few times until JSON comes back
//
// Idempotent (NULL-only): only writes editions.video_url where it IS NULL.
// Logs a pipeline_runs row (pipeline = 'allday-video-backfill').
//
// Run from repo root:  node scripts/backfill-allday-video.mjs
// (reads SUPABASE + TS_PROXY creds from .env.local)

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

// ---- env -------------------------------------------------------------------
function parseEnvLocal() {
  const out = {};
  let raw = "";
  try {
    raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  } catch {
    throw new Error("Could not read .env.local from repo root");
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const env = parseEnvLocal();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const PROXY_URL = (env.TS_PROXY_URL || "").replace(/\/+$/, "");
const PROXY_SECRET = env.TS_PROXY_SECRET;

if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("Missing Supabase creds in .env.local");
if (!PROXY_URL || !PROXY_SECRET) throw new Error("Missing TS_PROXY_URL/TS_PROXY_SECRET in .env.local");

const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070";
const CONSUMER_GQL = `${PROXY_URL}/allday-consumer`;
const CHUNK = 40;
const INT_MAX = 2147483647;
const WRITE_CONCURRENCY = 25;

const GQL = `query($ids:[Int!]){ searchEditions(input:{ first:40, filters:{ byEditionFlowIDs:$ids } }){ edges{ node{ flowID assetURLs{ videoSquare } } } } }`;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fetch the NULL-video edition external_ids (range-paginate past PostgREST 1000 cap)
async function fetchNullVideoEditionIds() {
  const ids = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("editions")
      .select("external_id")
      .eq("collection_id", ALLDAY_COLLECTION_ID)
      .is("video_url", null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`select editions failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      const n = Number(row.external_id);
      if (Number.isInteger(n) && n > 0 && n < INT_MAX) ids.push(n);
    }
    if (data.length < PAGE) break;
  }
  return ids;
}

// ---- one GQL chunk with CF-challenge retry; returns Map<flowID, videoSquare>
async function fetchVideosForChunk(ids) {
  const body = JSON.stringify({ query: GQL, variables: { ids } });
  for (let attempt = 1; attempt <= 10; attempt++) {
    let text;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(CONSUMER_GQL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Proxy-Secret": PROXY_SECRET },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(t);
      text = await res.text();
    } catch (e) {
      await sleep(400 * attempt);
      continue;
    }
    if (text.includes("Just a moment") || text.startsWith("<!DOCTYPE")) {
      await sleep(400 * attempt); // Cloudflare challenge — back off + retry
      continue;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      await sleep(400 * attempt);
      continue;
    }
    if (json.errors?.length) {
      throw new Error(`GQL error: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    const map = new Map();
    for (const edge of json?.data?.searchEditions?.edges ?? []) {
      const node = edge?.node;
      const flowID = node?.flowID;
      const url = node?.assetURLs?.videoSquare;
      if (flowID != null && typeof url === "string" && url.startsWith("http")) {
        map.set(Number(flowID), url);
      }
    }
    return map;
  }
  throw new Error("chunk failed after 10 CF-challenge retries");
}

// ---- run a list of async thunks with a concurrency cap
async function runPool(items, worker, concurrency) {
  let i = 0;
  let ok = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      try {
        await worker(items[idx]);
        ok++;
      } catch (e) {
        console.error(`  write failed for ${items[idx]?.id}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next));
  return ok;
}

async function main() {
  const startedAt = new Date();
  console.log("[allday-video-backfill] fetching NULL-video AllDay editions...");
  const ids = await fetchNullVideoEditionIds();
  console.log(`  ${ids.length} editions to resolve`);

  // 1) gather videos via GQL
  const resolved = new Map(); // flowID -> url
  let missing = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const map = await fetchVideosForChunk(chunk);
    for (const id of chunk) {
      if (map.has(id)) resolved.set(id, map.get(id));
      else missing++;
    }
    if ((i / CHUNK) % 10 === 0) {
      console.log(`  GQL ${Math.min(i + CHUNK, ids.length)}/${ids.length} (resolved ${resolved.size}, no-video ${missing})`);
    }
    await sleep(120); // be gentle on the worker / CF
  }
  console.log(`  GQL done: resolved ${resolved.size}, no-video ${missing}`);

  // 2) write (NULL-only guard) with concurrency
  const writes = [...resolved.entries()].map(([flowID, url]) => ({ id: String(flowID), url }));
  console.log(`[allday-video-backfill] writing ${writes.length} video_url rows...`);
  const written = await runPool(
    writes,
    async ({ id, url }) => {
      const { error } = await supabase
        .from("editions")
        .update({ video_url: url })
        .eq("collection_id", ALLDAY_COLLECTION_ID)
        .eq("external_id", id)
        .is("video_url", null);
      if (error) throw new Error(error.message);
    },
    WRITE_CONCURRENCY
  );
  console.log(`  wrote ${written} rows`);

  // 3) log pipeline_runs
  const finishedAt = new Date();
  const { error: logErr } = await supabase.from("pipeline_runs").insert({
    pipeline: "allday-video-backfill",
    collection_slug: "nfl_all_day",
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt - startedAt,
    rows_found: ids.length,
    rows_written: written,
    rows_skipped: missing,
    ok: true,
    extra: { source: "consumer_gql_searchEditions.assetURLs.videoSquare", run: "bulk_script" },
  });
  if (logErr) console.error(`  pipeline_runs log failed: ${logErr.message}`);

  console.log(`[allday-video-backfill] DONE in ${((finishedAt - startedAt) / 1000).toFixed(1)}s — found ${ids.length}, wrote ${written}, no-video ${missing}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
