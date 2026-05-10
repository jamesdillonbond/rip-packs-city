// supabase/functions/topshot-stub-resolver/index.ts
//
// TS stub-edition auto-resolver. Pulls a batch of integer-pair TopShot edition
// stubs (player_name / set_name NULL) via the get_topshot_stub_targets RPC and
// resolves them through the on-chain TopShot contract on Flow mainnet.
//
// Why Cadence and not GraphQL: Top Shot's public GQL `searchEditions` schema
// rejects integer on-chain IDs — `bySetIDs: [104]` returns the dal-level error
// `invalid input syntax for type uuid: "104"`. The integer-pair path is only
// resolvable on-chain. The previous version of this function called GraphQL
// and silently skipped 50/50 targets per cron tick because the failure
// surfaced as a 200-with-errors response that the original code returned null
// from without logging. Two stacked schema mismatches: (a) the function sent
// `{input:{bySetIDs}}` but the schema requires `{input:{filters:{bySetIDs},
// searchInput:{pagination:{...}}}}`, (b) even with the nested shape fixed,
// `bySetIDs` no longer accepts integers. Per RPC_DESIGN_SYSTEM.md §11, integer
// editions resolve via Cadence; UUID editions go through GraphQL.
//
// Targets returned by get_topshot_stub_targets have has_tier=true already, so
// tier doesn't need to be re-resolved (TopShot.getSetData on-chain doesn't
// expose tier anyway — it's a GQL-only field).
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — service-role client
//   INGEST_SECRET_TOKEN                     — Bearer auth on the function
//
// Deploy with `verify_jwt = false` so cron-job.org can hit it with a
// shared-secret Bearer header instead of a Supabase user JWT.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var required")

const FLOW_REST = "https://rest-mainnet.onflow.org/v1/scripts?block_height=final"
const PER_REQUEST_TIMEOUT_MS = 8_000
const BATCH_LIMIT = 50
const MAX_BATCH_DURATION_MS = 110_000

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
)

// Combined script: pulls the play metadata dict and tacks on the three
// set-level fields under reserved __ keys to keep the response a flat
// {String: String}. One Flow REST call per (setID, playID) pair.
const CADENCE_RESOLVE = `
import TopShot from 0x0b2a3299cc857e29

access(all) fun main(setID: UInt32, playID: UInt32): {String: String} {
    let result: {String: String} = TopShot.getPlayMetaData(playID: playID) ?? {}

    if let setName = TopShot.getSetName(setID: setID) {
        result["__SetName"] = setName
    }
    if let series = TopShot.getSetSeries(setID: setID) {
        result["__SetSeries"] = series.toString()
    }
    if let circulation = TopShot.getNumMomentsInEdition(setID: setID, playID: playID) {
        result["__Circulation"] = circulation.toString()
    }

    return result
}
`.trim()

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
  circulation: number | null
  team: string | null
  // Numeric on-chain series (UInt32 cast to JS number). Display mapping
  // (e.g. 5 → "Series 4") happens at read/render time. Editions.series is
  // a smallint column.
  series: number | null
}

function b64Utf8(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
}

function argB64(arg: { type: string; value: string }): string {
  return btoa(JSON.stringify(arg))
}

// Cadence's Flow REST encoding for `{String: String}` returns a `value` array
// of `{key: {value, type}, value: {value, type}}` entries. Flatten to JS dict.
function flattenCadenceDict(parsed: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  // deno-lint-ignore no-explicit-any
  const v = (parsed as any)?.value
  if (!Array.isArray(v)) return out
  for (const entry of v) {
    const k = entry?.key?.value
    const val = entry?.value?.value
    if (typeof k === "string" && typeof val === "string") out[k] = val
  }
  return out
}

// Top Shot's on-chain FullName is occasionally stored as the literal string
// "<invalid Value>" — fall back to FirstName/LastName when that happens.
function pickPlayerName(meta: Record<string, string>): string | null {
  const full = meta.FullName
  if (full && full !== "<invalid Value>" && full.trim() !== "") return full.trim()
  const first = (meta.FirstName ?? "").trim()
  const last = (meta.LastName ?? "").trim()
  const composed = [first, last].filter(Boolean).join(" ")
  return composed || null
}

async function resolveViaCadence(setId: number, playId: number): Promise<ResolvedMeta | { error: string }> {
  const body = {
    script: b64Utf8(CADENCE_RESOLVE),
    arguments: [
      argB64({ type: "UInt32", value: String(setId) }),
      argB64({ type: "UInt32", value: String(playId) }),
    ],
  }

  let res: Response
  try {
    res = await fetch(FLOW_REST, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    return { error: `fetch_failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  if (!res.ok) {
    const txt = await res.text()
    return { error: `http_${res.status}: ${txt.slice(0, 200)}` }
  }

  let raw: string
  try {
    raw = await res.text()
  } catch (err) {
    return { error: `read_body_failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  let parsed: unknown
  try {
    const decoded = atob(raw.replace(/^"|"$/g, "").trim())
    parsed = JSON.parse(decoded)
  } catch (err) {
    return { error: `decode_failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  const meta = flattenCadenceDict(parsed)

  const seriesRaw = meta.__SetSeries ?? null
  const seriesNum =
    seriesRaw != null && Number.isFinite(Number(seriesRaw)) ? Number(seriesRaw) : null

  const circRaw = meta.__Circulation ?? null
  const circulation = circRaw != null && Number.isFinite(Number(circRaw)) ? Number(circRaw) : null

  return {
    playerName: pickPlayerName(meta),
    setName: meta.__SetName?.trim() || null,
    circulation,
    team: meta.TeamAtMoment?.trim() || null,
    series: seriesNum,
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
    rows_skipped_cadence_err: 0,
    rows_skipped_no_player_data: 0,
    rows_skipped_upsert_err: 0,
    early_exit: false,
  }
  const errorSamples: string[] = []

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

  // 2. Resolve each one via Flow REST. Sequential — one Cadence call per
  // target, ~200-500ms each. 50 targets fit comfortably under the 110s
  // batch budget.
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

    const resolved = await resolveViaCadence(setId, playId)
    if ("error" in resolved) {
      counters.rows_skipped_cadence_err++
      if (errorSamples.length < 5) {
        errorSamples.push(`${t.external_id}: ${resolved.error}`)
      }
      console.log(`[topshot-stub-resolver] cadence err set=${setId} play=${playId}: ${resolved.error}`)
      continue
    }

    // If the on-chain record has no player name AND no set name, there's
    // nothing to write. Some plays (Redemption, team-moment sets) legitimately
    // lack player data on chain; track them separately so we don't conflate
    // them with Cadence failures.
    if (!resolved.playerName && !resolved.setName) {
      counters.rows_skipped_no_player_data++
      continue
    }

    // deno-lint-ignore no-explicit-any
    const { error: upErr } = await (supabase as any).rpc(
      "upsert_topshot_edition_metadata",
      {
        p_edition_id: t.edition_id,
        p_player_name: resolved.playerName,
        p_set_name: resolved.setName,
        p_tier: null,
        p_circulation_count: resolved.circulation,
        p_thumbnail_url: null,
        p_video_url: null,
        p_team: resolved.team,
        p_series: resolved.series,
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
      counters.rows_skipped_cadence_err +
      counters.rows_skipped_no_player_data +
      counters.rows_skipped_upsert_err,
    errorMsg: null,
    extra: {
      ...counters,
      elapsed_ms: Date.now() - startedAt,
      function_version: 3,
      error_samples: errorSamples,
    },
  })

  return new Response(JSON.stringify({ ok: true, ...counters }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
})
