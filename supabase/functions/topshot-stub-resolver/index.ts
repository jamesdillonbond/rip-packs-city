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

import { createClient } from "@supabase/supabase-js"

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

// ENCODE: JS string -> base64, UTF-8 safe (used for the Cadence script body).
function b64Utf8(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
}

// DECODE: base64 -> JS string, UTF-8 correct. The inverse of b64Utf8 and the
// mirror of scan-pinnacle-wallet's b64ToUtf8. Plain `atob` returns latin1 (one
// byte = one char), which double-encodes every multi-byte UTF-8 sequence; on this
// path that would corrupt player/set/team names on their way into `editions`.
// Pure-ASCII payloads decode identically, so this is a no-op for them.
function b64ToUtf8(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder("utf-8").decode(bytes)
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

// The literal sentinel Top Shot stores on chain for an absent name field.
const INVALID_ONCHAIN = "<invalid Value>"

// Top Shot's on-chain FullName is occasionally stored as the literal string
// "<invalid Value>" — fall back to FirstName/LastName when that happens.
// FirstName/LastName carry the SAME sentinel: guarding only FullName let the
// fallback compose the literal "<invalid Value> <invalid Value>" into
// editions.player_name. Measured 2026-07-27 on 4 of 42 sampled targets (set 141).
function pickPlayerName(meta: Record<string, string>): string | null {
  const full = meta.FullName
  if (full && full !== "<invalid Value>" && full.trim() !== "") return full.trim()
  const clean = (v: string | undefined): string => {
    const t = (v ?? "").trim()
    return t === INVALID_ONCHAIN ? "" : t
  }
  const first = clean(meta.FirstName)
  const last = clean(meta.LastName)
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
    // b64ToUtf8, NOT atob: this payload carries TopShot player/set/team names,
    // which are routinely non-ASCII (Dončić / Jokić / Şengün — 846 editions
    // already hold non-ASCII player_name/set_name), and they are written straight
    // to editions via upsert_topshot_edition_metadata below. atob is latin1-only,
    // so it would double-encode them ("Dončić" -> "DonÄiÄ‡"). Same fix class as
    // seed-allday-pack-distributions (2026-07-25), which had already corrupted 55
    // pack titles + 308 metadata rows this way.
    const decoded = b64ToUtf8(raw.replace(/^"|"$/g, "").trim())
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
    // A target whose upsert matched its row but changed NOTHING — the on-chain
    // record held nothing this edition was missing (overwhelmingly team moments,
    // which have no player on chain at all). This is the counter whose absence
    // made the pipeline read 50/50 green forever: the old code incremented
    // rows_resolved on ROW_COUNT>0, i.e. "a row matched", not "a field was filled".
    rows_no_change: 0,
    // ── A SUB-COUNT OF rows_no_change, not a replacement (2026-08-28) ────────
    // The subset that can NEVER be resolved by this pipeline: the edition is
    // missing player_name and the on-chain play has no player name to give.
    //
    // WHY IT IS SEPARATE. `rows_skipped_no_player_data` was supposed to be this
    // counter — its comment says "some plays legitimately lack player data on
    // chain; track them separately so we don't conflate them with Cadence
    // failures". It cannot do that job, because its predicate is
    // `!playerName && !setName` (AND). A Reel has a setName, so it sails past
    // that guard into an upsert that COALESCEs to nothing and lands in
    // rows_no_change — the SAME bucket as a row that was already correct.
    //
    // MEASURED 2026-08-28: 520 eligible editions, 88 runs in 48 h, 4,400
    // attempts, `rows_resolved: 0` on every single run. Sampling the queue head
    // against mainnet, the stuck rows are `PlayType: "Reel"` moments —
    // "2022-23 Season Rewind", "2023 NBA All-Star", "Fit Check" — whose play
    // metadata carries `TeamAtMoment` and no `FullName` at all. Resolving them
    // is not slow or flaky; it is impossible.
    //
    // Without this split, "we are re-attempting the impossible ~8.5 times a day"
    // and "everything is already up to date" are the same number.
    rows_no_change_no_onchain_player: 0,
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

    // `changed` is the RPC's boolean: TRUE only when a column actually took a new
    // value. Do NOT go back to counting a successful call as a resolution — the
    // upsert COALESCEs every field, so it returns cleanly while writing nothing.
    // deno-lint-ignore no-explicit-any
    const { data: changed, error: upErr } = await (supabase as any).rpc(
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
    if (changed === true) {
      counters.rows_resolved++
    } else {
      counters.rows_no_change++
      // Per-FIELD, which is the test the AND-guard above cannot express: this
      // edition wants a player name and the chain has none.
      if (!t.has_player_name && !resolved.playerName) {
        counters.rows_no_change_no_onchain_player++
      }
    }
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
      counters.rows_skipped_upsert_err +
      counters.rows_no_change,
    errorMsg: null,
    extra: {
      ...counters,
      elapsed_ms: Date.now() - startedAt,
      function_version: 4,
      error_samples: errorSamples,
    },
  })

  return new Response(JSON.stringify({ ok: true, ...counters }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
})
