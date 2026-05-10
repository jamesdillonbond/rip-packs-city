// supabase/functions/topshot-stub-resolver/index.ts
//
// TS stub-edition auto-resolver. Pulls a batch of UUID-skeleton TopShot
// editions (player_name / set_name / tier all NULL) via the
// get_topshot_stub_targets RPC, queries the topshot-proxy worker for
// each (set_id_onchain, play_id_onchain) pair, parses the GraphQL
// response, then writes the resolved metadata back through the
// upsert_topshot_edition_metadata RPC.
//
// Why this exists (R2): compute-topshot-pack-ev seeds 4-66 fully-NULL
// UUID skeleton edition rows per run and the editions-hydrate-at-insert
// path doesn't always pick them up before the next pack-ev tick. Without
// a periodic resolver these rows accumulate and the dashboard ends up
// with hundreds of "missing player_name" TS editions over time.
//
// Schema quirk: TopShot's public GQL exposes `set.flowId` with a
// lowercase 'd' but `play.flowID` with an uppercase 'D'. Both come back
// as strings (sometimes integers); we coerce to int when storing.
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — service-role client
//   TS_PROXY_URL                            — Cloudflare Worker URL
//   TS_PROXY_SECRET                         — X-Proxy-Secret header
//   INGEST_SECRET_TOKEN                     — Bearer auth on the function
//
// Deploy with `verify_jwt = false` so cron-job.org can hit it with a
// shared-secret Bearer header instead of a Supabase user JWT.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var required")

const TS_PROXY_URL = Deno.env.get("TS_PROXY_URL") ?? "https://topshot-proxy.tdillonbond.workers.dev"
const TS_PROXY_SECRET = Deno.env.get("TS_PROXY_SECRET") ?? ""
if (!TS_PROXY_SECRET) {
  console.log("[topshot-stub-resolver] WARN: TS_PROXY_SECRET not set — Cloudflare may reject ~50% of requests")
}

const BATCH_LIMIT = 50
const PER_REQUEST_TIMEOUT_MS = 10_000
const MAX_BATCH_DURATION_MS = 110_000

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
)

// Minimal SearchEditions query — same allowlisted shape as
// lib/editions-hydrate.ts uses, sliced down to just the fields we need
// to populate upsert_topshot_edition_metadata.
const SEARCH_EDITION_QUERY = `
  query SearchEditionBackfill($input: SearchEditionsInput!) {
    searchEditions(input: $input) {
      searchSummary {
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
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`

interface StubTarget {
  edition_id: string
  external_id: string
  play_id_onchain: number | string | null
  set_id_onchain: number | string | null
  has_player_name: boolean
  has_set_name: boolean
  has_tier: boolean
}

interface ResolvedMeta {
  playerName: string | null
  setName: string | null
  tier: string | null
  circulation: number | null
  team: string | null
  series: number | null
  thumbnailUrl: string | null
  videoUrl: string | null
}

function normalizeTier(raw: string | null | undefined): string | null {
  if (!raw) return null
  const t = String(raw).toUpperCase()
  if (t.includes("ULTIMATE")) return "ULTIMATE"
  if (t.includes("LEGENDARY")) return "LEGENDARY"
  if (t.includes("RARE")) return "RARE"
  if (t.includes("FANDOM")) return "FANDOM"
  if (t.includes("COMMON")) return "COMMON"
  return null
}

async function callProxy(setId: number, playId: number): Promise<ResolvedMeta | null> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "rip-packs-city/topshot-stub-resolver",
  }
  if (TS_PROXY_SECRET) headers["X-Proxy-Secret"] = TS_PROXY_SECRET

  let res: Response
  try {
    res = await fetch(TS_PROXY_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: SEARCH_EDITION_QUERY,
        variables: { input: { bySetIDs: [setId], byPlayIDs: [playId] } },
      }),
      signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    console.log(`[topshot-stub-resolver] proxy fetch failed set=${setId} play=${playId}: ${err}`)
    return null
  }

  if (!res.ok) {
    console.log(`[topshot-stub-resolver] proxy HTTP ${res.status} set=${setId} play=${playId}`)
    return null
  }

  type Resp = {
    data?: {
      searchEditions?: {
        searchSummary?: {
          data?: {
            data?: Array<{
              tier?: string | null
              circulationCount?: number | null
              set?: {
                flowId?: number | string | null
                flowName?: string | null
                flowSeriesNumber?: number | null
              } | null
              play?: {
                flowID?: string | null
                stats?: {
                  playerName?: string | null
                  teamAtMoment?: string | null
                } | null
              } | null
            }>
          }
        }
      }
    }
    errors?: unknown[]
  }

  let json: Resp
  try {
    json = (await res.json()) as Resp
  } catch {
    return null
  }
  if (Array.isArray(json.errors) && json.errors.length > 0) return null
  const node = json.data?.searchEditions?.searchSummary?.data?.data?.[0]
  if (!node) return null

  return {
    playerName: node.play?.stats?.playerName ?? null,
    setName: node.set?.flowName ?? null,
    tier: normalizeTier(node.tier),
    circulation: node.circulationCount != null ? Number(node.circulationCount) : null,
    team: node.play?.stats?.teamAtMoment ?? null,
    series: node.set?.flowSeriesNumber != null ? Number(node.set.flowSeriesNumber) : null,
    thumbnailUrl: null,
    videoUrl: null,
  }
}

async function logPipelineRun(args: {
  startedAtIso: string
  ok: boolean
  rowsFound: number
  rowsWritten: number
  rowsSkipped: number
  errorMsg: string | null
  extra: Record<string, unknown>
}) {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabase as any).rpc("log_pipeline_run", {
      p_pipeline: "topshot-stub-resolver",
      p_started_at: args.startedAtIso,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.errorMsg,
      p_collection_slug: "nba_top_shot",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: args.extra,
    })
  } catch { /* ignore */ }
}

Deno.serve(async (req: Request) => {
  // Bearer or ?token= auth.
  const auth = req.headers.get("authorization") ?? ""
  const url = new URL(req.url)
  const qToken = url.searchParams.get("token") ?? ""
  const tokenOk =
    auth === `Bearer ${INGEST_SECRET_TOKEN}` || qToken === INGEST_SECRET_TOKEN
  if (!tokenOk) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
  }

  const startedAt = Date.now()
  const startedAtIso = new Date(startedAt).toISOString()

  const counters = {
    targets_found: 0,
    targets_processed: 0,
    rows_resolved: 0,
    rows_skipped_no_onchain_ids: 0,
    rows_skipped_proxy_null: 0,
    rows_skipped_upsert_err: 0,
    early_exit: false,
  }

  // 1. Pull a batch of stub targets.
  // deno-lint-ignore no-explicit-any
  const { data: targetsRaw, error: targetsErr } = await (supabase as any).rpc(
    "get_topshot_stub_targets",
    { p_limit: BATCH_LIMIT },
  )

  if (targetsErr) {
    await logPipelineRun({
      startedAtIso,
      ok: false,
      rowsFound: 0,
      rowsWritten: 0,
      rowsSkipped: 0,
      errorMsg: `get_topshot_stub_targets: ${targetsErr.message}`,
      extra: { ...counters, elapsed_ms: Date.now() - startedAt },
    })
    return new Response(JSON.stringify({ ok: false, error: targetsErr.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }

  const targets = (targetsRaw ?? []) as StubTarget[]
  counters.targets_found = targets.length

  if (targets.length === 0) {
    await logPipelineRun({
      startedAtIso,
      ok: true,
      rowsFound: 0,
      rowsWritten: 0,
      rowsSkipped: 0,
      errorMsg: null,
      extra: { ...counters, elapsed_ms: Date.now() - startedAt, message: "no stub targets" },
    })
    return new Response(JSON.stringify({ ok: true, ...counters }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }

  // 2. Resolve each one. Sequential (not parallel) — the topshot-proxy
  // worker has a per-IP rate limit and we'd rather pace this conservatively
  // than chunk and burst.
  for (const t of targets) {
    if (Date.now() - startedAt > MAX_BATCH_DURATION_MS) {
      counters.early_exit = true
      break
    }
    counters.targets_processed++

    const setId = t.set_id_onchain != null ? Number(t.set_id_onchain) : NaN
    const playId = t.play_id_onchain != null ? Number(t.play_id_onchain) : NaN
    if (!Number.isFinite(setId) || !Number.isFinite(playId)) {
      counters.rows_skipped_no_onchain_ids++
      continue
    }

    const meta = await callProxy(setId, playId)
    if (!meta) {
      counters.rows_skipped_proxy_null++
      continue
    }

    // deno-lint-ignore no-explicit-any
    const { error: upErr } = await (supabase as any).rpc(
      "upsert_topshot_edition_metadata",
      {
        p_edition_id: t.edition_id,
        p_player_name: meta.playerName,
        p_set_name: meta.setName,
        p_tier: meta.tier,
        p_circulation_count: meta.circulation,
        p_thumbnail_url: meta.thumbnailUrl,
        p_video_url: meta.videoUrl,
        p_team: meta.team,
        p_series: meta.series != null ? String(meta.series) : null,
      },
    )

    if (upErr) {
      console.log(`[topshot-stub-resolver] upsert err edition=${t.edition_id}: ${upErr.message}`)
      counters.rows_skipped_upsert_err++
      continue
    }
    counters.rows_resolved++
  }

  await logPipelineRun({
    startedAtIso,
    ok: true,
    rowsFound: counters.targets_found,
    rowsWritten: counters.rows_resolved,
    rowsSkipped:
      counters.rows_skipped_no_onchain_ids +
      counters.rows_skipped_proxy_null +
      counters.rows_skipped_upsert_err,
    errorMsg: null,
    extra: {
      ...counters,
      elapsed_ms: Date.now() - startedAt,
      function_version: 1,
    },
  })

  return new Response(JSON.stringify({ ok: true, ...counters }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
})
