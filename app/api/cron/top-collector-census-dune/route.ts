// app/api/cron/top-collector-census-dune/route.ts
//
// The FULL holder census behind the Top Collector Leaderboard — every wallet, not only the ones RPC has
// walked (Trevor, 2026-11-27). One collection per call:
//
//   POST /api/cron/top-collector-census-dune?collection=nba-top-shot      (nfl-all-day | laliga-golazos | disney-pinnacle)
//   Auth: Bearer ${INGEST_SECRET_TOKEN} or ${CRON_SECRET}
//
//   1. top_collector_census_map_csv(collection)  → RPC's edition map as CSV (one text value: no 1,000-row clamp)
//   2. dune-proxy POST /upload_csv              → public Dune table dataset_rpc_census_map_<key> (replaced)
//   3. dune-proxy POST /execute + GET /status   → the saved census query (lib/dune/top-collector-census.ts)
//   4. dune-proxy GET /results (pages of 1,000) → stage_top_collector_census(run_id, …)
//   5. finalize_top_collector_census(run_id, collection, expected) — one transaction swaps the leaderboard
//      in as source 'dune_census'; a short stage is refused and the previous set stays.
//
// ⚠ ok is DERIVED: every step must land, and the stage must hold every keyed row the walk received. A
// row that cannot be keyed is counted in extra.rows_unkeyed, never written, and fails the run (it means
// the query and the map disagree).
// ⚠ Resume: ?execution_id=<id> skips 1–3 and pages an execution that already finished (the status poll is
// bounded at STATUS_BUDGET_MS; a long Dune run that outlives it is logged with its id).
// ⚠ Cost: an execution scans flow.cadence_events from contract launch; export is billed per MB, which is
// why the query returns only the top rows per entity. Runs are logged in dune_api_usage.

import { bearerMatches } from "@/lib/auth/bearer-secret"
import { NextRequest, NextResponse, after } from "next/server"
import { randomUUID } from "node:crypto"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { recordDuneUsage } from "@/lib/dune/budget"
import { censusConfigBySlug, censusQueryId, mapTableName, normalizeCensusRow, type CensusRow } from "@/lib/dune/top-collector-census"

export const dynamic = "force-dynamic"
export const maxDuration = 800

const PIPELINE = "top-collector-census-dune"
const PAGE_LIMIT = 1000
const STAGE_CHUNK = 1000
const INTER_PAGE_MS = 1500
const STATUS_POLL_MS = 10_000
const STATUS_BUDGET_MS = 540_000
const HARD_BUDGET_MS = 760_000
const REQ_TIMEOUT_MS = 60_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function authed(req: NextRequest): boolean {
  return bearerMatches(req.headers.get("authorization"), "INGEST_SECRET_TOKEN", "CRON_SECRET")
}

export async function POST(req: NextRequest) {
  return run(req)
}
export async function GET(req: NextRequest) {
  return run(req)
}

async function logRun(startedAt: string, ok: boolean, found: number, written: number, error: string | null, slug: string | null, extra: Record<string, unknown>) {
  const { error: logErr } = await supabaseAdmin.rpc("log_pipeline_run", {
    p_pipeline: PIPELINE,
    p_started_at: startedAt,
    p_rows_found: found,
    p_rows_written: written,
    p_rows_skipped: 0,
    p_ok: ok,
    p_error: error,
    p_collection_slug: slug,
    p_cursor_before: null,
    p_cursor_after: null,
    p_extra: extra,
  })
  if (logErr) console.log(`[${PIPELINE}] log_pipeline_run failed: ${logErr.message}`)
}

async function run(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const url = new URL(req.url)
  const cfg = censusConfigBySlug(url.searchParams.get("collection") ?? "")
  // ⛔ No default collection: an absent or unknown one is refused, never substituted.
  if (!cfg) return NextResponse.json({ error: "collection must be one of nba-top-shot, nfl-all-day, laliga-golazos, disney-pinnacle" }, { status: 400 })
  const resumeExec = url.searchParams.get("execution_id")
  const startedAt = new Date().toISOString()
  await writeInvocationHeartbeat({ pipeline: PIPELINE, startedAtMs: Date.parse(startedAt) })

  const proxyUrl = process.env.DUNE_PROXY_URL
  const proxySecret = process.env.DUNE_PROXY_SECRET
  const queryId = censusQueryId(cfg)
  if (!proxyUrl || !proxySecret || !queryId) {
    await logRun(startedAt, false, 0, 0, "dune not configured", cfg.urlSlug, { skipped: "dune_not_configured" })
    return NextResponse.json({ ok: false, error: "dune_not_configured" }, { status: 503 })
  }
  const proxy = (path: string, init?: RequestInit) =>
    fetch(`${proxyUrl.replace(/\/+$/, "")}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${proxySecret}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      cache: "no-store",
    })

  after(async () => {
    const t0 = Date.now()
    const runId = randomUUID()
    const extra: Record<string, unknown> = { collection: cfg.urlSlug, query_id: queryId, run_id: runId }
    let found = 0
    let staged = 0
    let unkeyed = 0
    let err: string | null = null
    try {
      let executionId = resumeExec
      if (!executionId) {
        // 1–2. Map → Dune table.
        const { data: csv, error: mapErr } = await supabaseAdmin.rpc("top_collector_census_map_csv", { p_collection_id: cfg.collectionId })
        if (mapErr) throw new Error(`map: ${mapErr.message}`)
        if (typeof csv !== "string" || csv.split("\n").length < 3) throw new Error("map: empty")
        extra.map_bytes = csv.length
        const up = await proxy("/upload_csv", {
          method: "POST",
          body: JSON.stringify({ table_name: mapTableName(cfg), data: csv, description: `RPC Top Collector census map — ${cfg.contract} (${startedAt})` }),
        })
        const upText = await up.text()
        extra.upload_status = up.status
        if (!up.ok) throw new Error(`upload HTTP ${up.status}: ${upText.slice(0, 200)}`)

        // 3. Execute + poll.
        const ex = await proxy(`/execute?query_id=${queryId}`, { method: "POST", body: "{}" })
        await recordDuneUsage({ pipeline: PIPELINE, endpoint: "execute", queryId, httpStatus: ex.status })
        const exBody = (await ex.json().catch(() => ({}))) as { execution_id?: string; error?: string }
        if (!ex.ok || !exBody.execution_id) throw new Error(`execute HTTP ${ex.status}: ${exBody.error ?? "no execution_id"}`)
        executionId = exBody.execution_id
        extra.execution_id = executionId
        const pollStart = Date.now()
        for (;;) {
          await sleep(STATUS_POLL_MS)
          const st = await proxy(`/status?execution_id=${encodeURIComponent(executionId)}`)
          const stBody = (await st.json().catch(() => ({}))) as { state?: string; error?: unknown }
          if (stBody.state === "QUERY_STATE_COMPLETED") break
          if (stBody.state && /FAILED|CANCELLED|EXPIRED/.test(stBody.state)) {
            throw new Error(`execution ${stBody.state}: ${JSON.stringify(stBody.error ?? null).slice(0, 300)}`)
          }
          if (Date.now() - pollStart > STATUS_BUDGET_MS) {
            throw new Error(`execution still ${stBody.state ?? "unknown"} after ${Math.round(STATUS_BUDGET_MS / 1000)} s — resume with ?execution_id=${executionId}`)
          }
        }
        extra.execution_seconds = Math.round((Date.now() - pollStart) / 1000)
      } else {
        extra.execution_id = executionId
        extra.resumed = true
      }

      // 4. Page the result into the stage.
      let offset = 0
      let total: number | null = null
      for (;;) {
        if (Date.now() - t0 > HARD_BUDGET_MS) throw new Error(`budget: walk stopped at offset ${offset} of ${total ?? "?"}`)
        const res = await proxy(`/results?query_id=${queryId}&limit=${PAGE_LIMIT}&offset=${offset}`)
        const body = (await res.json().catch(() => ({}))) as {
          execution_id?: string
          result?: { rows?: Array<Record<string, unknown>>; metadata?: { total_row_count?: number; column_names?: string[] } }
          next_offset?: number
          error?: string
        }
        if (!res.ok) throw new Error(`results HTTP ${res.status}: ${body.error ?? ""}`.slice(0, 300))
        // The cached result must be OUR execution, never an older one paged as if it were current.
        if (body.execution_id && body.execution_id !== executionId) throw new Error(`results belong to execution ${body.execution_id}, not ${executionId}`)
        const rows = body.result?.rows ?? []
        total = body.result?.metadata?.total_row_count ?? total
        await recordDuneUsage({ pipeline: PIPELINE, endpoint: "results", queryId, rows: rows.length, columns: body.result?.metadata?.column_names?.length ?? 10, httpStatus: res.status })
        found += rows.length
        const keyed: CensusRow[] = []
        for (const r of rows) {
          const n = normalizeCensusRow(r)
          if (n) keyed.push(n)
          else unkeyed++
        }
        for (let i = 0; i < keyed.length; i += STAGE_CHUNK) {
          const chunk = keyed.slice(i, i + STAGE_CHUNK)
          const { data: n, error: stErr } = await supabaseAdmin.rpc("stage_top_collector_census", {
            p_run_id: runId,
            p_collection_id: cfg.collectionId,
            p_rows: chunk,
          })
          if (stErr) throw new Error(`stage: ${stErr.message}`)
          staged += typeof n === "number" ? n : 0
        }
        if (rows.length < PAGE_LIMIT || body.next_offset == null) break
        offset = body.next_offset
        await sleep(INTER_PAGE_MS)
      }
      extra.total_row_count = total
      extra.rows_unkeyed = unkeyed
      if (total != null && found !== total) throw new Error(`walk received ${found} of ${total} rows`)
      if (unkeyed > 0) throw new Error(`${unkeyed} result rows could not be keyed — query and map disagree`)

      // 5. Swap in.
      const { data: fin, error: finErr } = await supabaseAdmin.rpc("finalize_top_collector_census", {
        p_run_id: runId,
        p_collection_id: cfg.collectionId,
        p_expected_rows: staged,
      })
      if (finErr) throw new Error(`finalize: ${finErr.message}`)
      extra.finalize = fin
      if (!fin || (fin as { ok?: boolean }).ok !== true) throw new Error(`finalize refused: ${(fin as { error?: string } | null)?.error ?? "no result"}`)
    } catch (e) {
      err = e instanceof Error ? e.message : String(e)
    }
    extra.duration_ms = Date.now() - t0
    // A failed run leaves its stage behind only until finalize's own cleanup or the next run; drop it now.
    if (err) await supabaseAdmin.from("entity_top_fans_census_stage").delete().eq("run_id", runId)
    await logRun(startedAt, err == null, found, err == null ? staged : 0, err, cfg.urlSlug, extra)
  })

  return NextResponse.json({ ok: true, accepted: true, pipeline: PIPELINE, collection: cfg.urlSlug }, { status: 202 })
}
