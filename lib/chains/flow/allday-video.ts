// lib/chains/flow/allday-video.ts
//
// Freshness-tail helper for editions.video_url on NFL All Day.
//
// The one-off bulk fill (scripts/backfill-allday-video.mjs, 2026-06-07) loaded
// ~6,176 of 6,191 AllDay editions. This helper keeps it current: any NEW AllDay
// edition created since the last sweep gets its video_url filled on the next
// cron tick it rides. Folded into the allday-fmv-populate cron (which already
// carries the topshot-proxy worker plumbing).
//
// Source: NFL All Day consumer GraphQL via the topshot-proxy /allday-consumer
// worker route (X-Proxy-Secret auth; Cloudflare WAF blocks direct egress and
// the worker adds the browser headers that flip the schema to the full view).
//
//   searchEditions(input:{ first:40, filters:{ byEditionFlowIDs:[Int!] } }){
//     edges{ node{ flowID assetURLs{ videoSquare } } } }
//   - flowID == editions.external_id for AllDay
//   - assetURLs.videoSquare is the 1080x1080 square animation .mp4 (the analog
//     to the TS Animated_1080_1080 hover video; raw https URL)
//   - endpoint hard-caps at 40 edges/page -> chunk ids at 40
//
// NULL-only writes (idempotent). Default scope is editions created in the last
// `recentDays` so the permanent handful of genuinely video-less editions are
// not re-fetched on every tick.

import { supabaseAdmin } from "@/lib/supabase"

const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const INT_MAX = 2147483647
const CHUNK = 40

const SEARCH_EDITIONS_VIDEO_GQL =
  `query($ids:[Int!]){ searchEditions(input:{ first:40, filters:{ byEditionFlowIDs:$ids } }){ edges{ node{ flowID assetURLs{ videoSquare } } } } }`

function consumerUrl(): string | null {
  const base = (process.env.TS_PROXY_URL ?? "").replace(/\/+$/, "")
  if (!base) return null
  return `${base}/allday-consumer`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function fetchChunk(
  ids: number[],
  url: string,
  secret: string
): Promise<Map<number, string>> {
  const body = JSON.stringify({ query: SEARCH_EDITIONS_VIDEO_GQL, variables: { ids } })
  for (let attempt = 1; attempt <= 5; attempt++) {
    let text = ""
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Proxy-Secret": secret },
        body,
        signal: AbortSignal.timeout(12000),
      })
      text = await res.text()
    } catch {
      await sleep(300 * attempt)
      continue
    }
    // Cloudflare JS challenge — back off and retry
    if (text.includes("Just a moment") || text.startsWith("<!DOCTYPE")) {
      await sleep(300 * attempt)
      continue
    }
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      await sleep(300 * attempt)
      continue
    }
    if (json?.errors?.length) {
      throw new Error(`allday consumer GQL: ${json.errors.map((e: any) => e?.message).join("; ")}`)
    }
    const out = new Map<number, string>()
    for (const edge of json?.data?.searchEditions?.edges ?? []) {
      const node = edge?.node
      const flowID = node?.flowID
      const videoUrl = node?.assetURLs?.videoSquare
      if (flowID != null && typeof videoUrl === "string" && videoUrl.startsWith("http")) {
        out.set(Number(flowID), videoUrl)
      }
    }
    return out
  }
  throw new Error("allday consumer GQL: chunk failed after 5 CF-challenge retries")
}

export interface AllDayVideoBackfillResult {
  found: number
  written: number
  noVideo: number
  skippedReason?: string
}

/**
 * Fill editions.video_url for AllDay editions that are missing it.
 *
 * @param limit       max editions to attempt this call (keeps the cron tick bounded)
 * @param recentDays  when >0, only consider editions created within this many days
 *                    (freshness mode — skips the permanent video-less tail).
 *                    Pass 0 for a full backlog pass (manual re-runs).
 */
export async function backfillAllDayEditionVideos(
  limit = 80,
  recentDays = 45
): Promise<AllDayVideoBackfillResult> {
  const url = consumerUrl()
  const secret = process.env.TS_PROXY_SECRET ?? ""
  if (!url || !secret) {
    return { found: 0, written: 0, noVideo: 0, skippedReason: "no_proxy_config" }
  }

  const startedAtIso = new Date().toISOString()

  let q = supabaseAdmin
    .from("editions")
    .select("external_id")
    .eq("collection_id", ALLDAY_COLLECTION_ID)
    .is("video_url", null)
    .limit(limit)
  if (recentDays > 0) {
    const since = new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000).toISOString()
    q = q.gte("created_at", since)
  }

  const { data, error } = await q
  if (error) return { found: 0, written: 0, noVideo: 0, skippedReason: `select:${error.message}` }
  const rows = data ?? []
  if (rows.length === 0) return { found: 0, written: 0, noVideo: 0 }

  const ids: number[] = []
  for (const r of rows) {
    const n = Number((r as any).external_id)
    if (Number.isInteger(n) && n > 0 && n < INT_MAX) ids.push(n)
  }

  // gather videos
  const resolved = new Map<number, string>()
  for (let i = 0; i < ids.length; i += CHUNK) {
    const map = await fetchChunk(ids.slice(i, i + CHUNK), url, secret)
    for (const [k, v] of map) resolved.set(k, v)
  }

  // NULL-only writes
  let written = 0
  for (const [flowID, videoUrl] of resolved) {
    const { error: upErr } = await supabaseAdmin
      .from("editions")
      .update({ video_url: videoUrl })
      .eq("collection_id", ALLDAY_COLLECTION_ID)
      .eq("external_id", String(flowID))
      .is("video_url", null)
    if (!upErr) written++
  }
  const noVideo = ids.length - resolved.size

  // observability — only log when there was real work to do
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: "allday-video-backfill",
      p_started_at: startedAtIso,
      p_rows_found: ids.length,
      p_rows_written: written,
      p_rows_skipped: noVideo,
      p_ok: true,
      p_error: null,
      p_collection_slug: "nfl_all_day",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: {
        source: "consumer_gql_searchEditions.assetURLs.videoSquare",
        run: "freshness_tail",
        recent_days: recentDays,
      },
    })
  } catch {
    /* logging is best-effort */
  }

  return { found: ids.length, written, noVideo }
}
