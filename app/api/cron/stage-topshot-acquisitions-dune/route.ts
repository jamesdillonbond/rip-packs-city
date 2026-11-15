// app/api/cron/stage-topshot-acquisitions-dune/route.ts
//
// Known-issue #190 (Trevor 2026-11-14 ~8:50 PM PT: "I have the analyst plan ... do #1").
//
// Pages the LATEST result set of the private temp Dune query STAGE_QUERY_ID (pre-2023-11-08
// marketplace buys of Top Shot moments that saved wallets still hold) through the dune-proxy
// worker into public.topshot_dune_acquisition_stage — a REVIEW table. Nothing reads that table
// and nothing here writes moment_acquisitions: Trevor reviews the staged rows before any
// cost-basis write (standing rule).
//
// It NEVER executes the query. Executions are run by hand (Dune MCP) so their credit cost is a
// decision, not a schedule. Each tick first reads ONE row to learn the latest execution id and its
// total row count; when the stage already holds that execution in full it stops there, so the
// hourly cron is ~free once the stage is current. A new execution is restaged in full.
//
// HONESTY: ok is derived from the writes — a tick is ok only when every mapped row of the
// execution was written (count read back from the table, never from a running counter that
// cannot go down). A row Dune returned that fails the shape check is counted as skipped and
// reported; it is never written. A proxy or DB failure fails the run with the error string.
// `dune_budget_state.paused` is the kill switch; an unreadable switch fails the run.
//
// Auth: Bearer ${CRON_SECRET} (Vercel cron) or ${INGEST_SECRET_TOKEN}. 202 + after().

import { bearerMatches } from "@/lib/auth/bearer-secret"
import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { sweepDeadlineSignal } from "@/lib/http/sweep-deadline"
import { recordDuneUsage, columnCount } from "@/lib/dune/budget"
import {
  STAGE_QUERY_ID,
  PROVENANCE_QUERY_ID,
  HOP_QUERY_ID,
  mapStageRow,
  mapProvenanceStageRow,
  mapHopRow,
} from "@/lib/dune/topshot-acquisition-stage"

export const dynamic = "force-dynamic"
export const maxDuration = 800

const PIPELINE_NAME = "stage-topshot-acquisitions-dune"
// Lanes share one walk. `?lane=provenance` (#190 step 2) loads the wallet-scoped arrival
// provenance into topshot_arrival_provenance; apply_topshot_arrival_provenance() (another
// lane's tested writer) then decides what reaches moment_acquisitions — this route never does.
const LANES = {
  purchases: {
    queryId: STAGE_QUERY_ID,
    table: "topshot_dune_acquisition_stage",
    onConflict: "wallet,nft_id",
    map: mapStageRow,
  },
  provenance: {
    queryId: PROVENANCE_QUERY_ID,
    table: "topshot_arrival_provenance",
    onConflict: "wallet,nft_id,arrival_tx",
    map: mapProvenanceStageRow,
  },
  hop: {
    queryId: HOP_QUERY_ID,
    table: "topshot_transfer_hop_stage",
    onConflict: "sender,nft_id",
    map: mapHopRow,
  },
} as const
type LaneName = keyof typeof LANES
const PAGE_LIMIT = 2000
const WRITE_CHUNK = 1000
const HARD_BUDGET_MS = 720_000
const DUNE_LOG_RESERVE_MS = 30_000
// Dune's per-minute request cap answered 429 after ~77 pages in 46 s (2026-11-14). Pace pages and
// back off on 429 (Retry-After when sent) so a tick walks steadily instead of stopping at the cap.
const INTER_PAGE_MS = 700
const MAX_429_RETRIES = 5
const BACKOFF_BASE_MS = 5_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function authed(req: NextRequest): boolean {
  return bearerMatches(req.headers.get("authorization"), "CRON_SECRET", "INGEST_SECRET_TOKEN")
}

type ResultsPage = {
  execution_id?: string
  state?: string
  result?: { rows?: Array<Record<string, unknown>>; metadata?: { total_row_count?: number } }
  next_offset?: number | null
}

export async function GET(req: NextRequest) {
  return run(req)
}
export async function POST(req: NextRequest) {
  return run(req)
}

async function run(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const laneParam = req.nextUrl.searchParams.get("lane") ?? "purchases"
  if (!Object.prototype.hasOwnProperty.call(LANES, laneParam)) {
    return NextResponse.json({ error: "unknown lane" }, { status: 400 })
  }
  const laneName = laneParam as LaneName
  const lane = LANES[laneName]
  const pipeline = laneName === "purchases" ? PIPELINE_NAME : `${PIPELINE_NAME}-${laneName}`
  const proxyUrl = process.env.DUNE_PROXY_URL
  const proxySecret = process.env.DUNE_PROXY_SECRET
  const startedAt = new Date().toISOString()
  await writeInvocationHeartbeat({ pipeline, startedAtMs: Date.parse(startedAt) })

  after(async () => {
    const startedMs = Date.now()
    let ok = true
    let errMsg: string | null = null
    let found = 0
    let skipped = 0
    let stagedForExecution: number | null = null
    let executionId: string | null = null
    let totalRows: number | null = null
    let upToDate = false
    let pausedStop = false
    // Next page to read when this tick stops early; the next tick resumes there (never re-buys pages).
    let resumeOffset: number | null = null
    let walkOffset: number | null = null
    let completed = false
    let startOffset = 0

    const fetchPage = async (offset: number, limit: number): Promise<ResultsPage> => {
      for (let attempt = 0; ; attempt++) {
        const page = await fetchOnce(offset, limit)
        if (page !== "rate_limited") return page
        if (attempt >= MAX_429_RETRIES) throw new Error(`dune proxy HTTP 429 at offset ${offset} after ${attempt} retries`)
        const waitMs = BACKOFF_BASE_MS * 2 ** attempt
        if (Date.now() - startedMs + waitMs > HARD_BUDGET_MS) throw new Error(`dune proxy HTTP 429 at offset ${offset}; no time left to back off`)
        await sleep(waitMs)
      }
    }

    const fetchOnce = async (offset: number, limit: number): Promise<ResultsPage | "rate_limited"> => {
      const res = await fetch(
        `${proxyUrl}/results?query_id=${lane.queryId}&limit=${limit}&offset=${offset}`,
        {
          headers: { Authorization: `Bearer ${proxySecret}` },
          cache: "no-store",
          // Whichever fires first: the sweep's own deadline, or 60 s for this one page.
          signal: AbortSignal.any([
            sweepDeadlineSignal(startedMs, HARD_BUDGET_MS, { reserveMs: DUNE_LOG_RESERVE_MS }),
            AbortSignal.timeout(60_000),
          ]),
        },
      )
      const body = (await res.json().catch(() => null)) as ResultsPage | null
      const rows = body?.result?.rows ?? []
      await recordDuneUsage({
        pipeline,
        endpoint: "results",
        queryId: lane.queryId,
        rows: rows.length,
        columns: columnCount(rows),
        httpStatus: res.status,
        note: `offset ${offset}`,
      })
      if (res.status === 429) return "rate_limited"
      if (!res.ok || !body) {
        throw new Error(`dune proxy HTTP ${res.status} at offset ${offset}: ${JSON.stringify(body).slice(0, 300)}`)
      }
      return body
    }

    try {
      if (!proxyUrl || !proxySecret) throw new Error("DUNE_PROXY_URL / DUNE_PROXY_SECRET unset")

      const { data: st, error: stErr } = await supabaseAdmin
        .from("dune_budget_state")
        .select("paused")
        .eq("id", 1)
        .single()
      if (stErr || !st) throw new Error(`dune_budget_state read: ${stErr?.message ?? "no row"}`)
      if (st.paused === true) {
        pausedStop = true
      } else {
        // One row tells us which execution is latest and how big it is.
        const head = await fetchPage(0, 1)
        executionId = head.execution_id ?? null
        const t = head.result?.metadata?.total_row_count
        totalRows = typeof t === "number" ? t : null
        if (!executionId || totalRows == null) {
          throw new Error(`no completed execution to stage (state ${head.state ?? "unknown"})`)
        }

        const { count: haveCount, error: haveErr } = await supabaseAdmin
          .from(lane.table)
          .select("nft_id", { count: "exact", head: true })
          .eq("dune_execution_id", executionId)
        if (haveErr || haveCount == null) throw new Error(`stage count read: ${haveErr?.message ?? "no count"}`)

        // Done = a previous tick walked this execution to its end. A row count alone cannot say so:
        // rows the mapper skips are never written, so the count may never reach Dune's total, and
        // relying on it alone would re-buy the whole result every hour.
        const { count: doneRuns, error: doneErr } = await supabaseAdmin
          .from("pipeline_runs")
          .select("id", { count: "exact", head: true })
          .eq("pipeline", pipeline)
          .eq("extra->>execution_id", executionId)
          .eq("extra->>completed", "true")
        if (doneErr || doneRuns == null) throw new Error(`completion read: ${doneErr?.message ?? "no count"}`)

        if (haveCount >= totalRows || doneRuns > 0) {
          upToDate = true
          stagedForExecution = haveCount
        } else {
          // Resume where the last tick on THIS execution stopped. Pages already written are not
          // re-read: Dune bills result reads by volume, and a restart from 0 would buy them again.
          const { data: prev, error: prevErr } = await supabaseAdmin
            .from("pipeline_runs")
            .select("extra")
            .eq("pipeline", pipeline)
            .eq("extra->>execution_id", executionId)
            .not("extra->>resume_offset", "is", null)
            .order("started_at", { ascending: false })
            .limit(1)
          if (prevErr) throw new Error(`resume read: ${prevErr.message}`)
          const prevOffset = Number((prev?.[0]?.extra as { resume_offset?: unknown } | undefined)?.resume_offset)
          startOffset = Number.isInteger(prevOffset) && prevOffset > 0 ? prevOffset : 0
          let offset = startOffset
          for (;;) {
            walkOffset = offset
            if (Date.now() - startedMs > HARD_BUDGET_MS) {
              resumeOffset = offset
              throw new Error(`time budget spent at offset ${offset}; next tick resumes there`)
            }
            const page = await fetchPage(offset, PAGE_LIMIT)
            if (page.execution_id !== executionId) {
              throw new Error(`execution changed mid-walk (${executionId} -> ${page.execution_id}); rerun`)
            }
            const rows = page.result?.rows ?? []
            found += rows.length
            const mapped: Record<string, unknown>[] = []
            for (const r of rows) {
              const m = lane.map(r, executionId)
              if (m) mapped.push(m)
              else skipped++
            }
            for (let i = 0; i < mapped.length; i += WRITE_CHUNK) {
              const { error: upErr } = await supabaseAdmin
                .from(lane.table)
                .upsert(mapped.slice(i, i + WRITE_CHUNK), { onConflict: lane.onConflict })
              if (upErr) throw new Error(`stage upsert at offset ${offset}: ${upErr.message}`)
            }
            if (page.next_offset == null || rows.length === 0) break
            offset = Number(page.next_offset)
            await sleep(INTER_PAGE_MS)
          }
          walkOffset = null
          completed = true

          // Written = what the table now holds for this execution, read back.
          const { count: afterCount, error: afterErr } = await supabaseAdmin
            .from(lane.table)
            .select("nft_id", { count: "exact", head: true })
            .eq("dune_execution_id", executionId)
          if (afterErr || afterCount == null) throw new Error(`stage count re-read: ${afterErr?.message ?? "no count"}`)
          stagedForExecution = afterCount
          if (startOffset === 0 && found !== totalRows) {
            ok = false
            errMsg = `paged ${found} rows but Dune reports ${totalRows}`
          } else if (startOffset === 0 && afterCount !== found - skipped) {
            ok = false
            errMsg = `stage holds ${afterCount} rows for ${executionId}, expected ${found - skipped}`
          }
        }
      }
    } catch (e) {
      // Any failure mid-walk resumes at the page that did not finish, never at 0.
      if (resumeOffset == null && walkOffset != null) resumeOffset = walkOffset
      ok = false
      errMsg = e instanceof Error ? e.message : String(e)
    }

    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: pipeline,
        p_started_at: startedAt,
        p_rows_found: found,
        p_rows_written: upToDate ? 0 : stagedForExecution,
        p_rows_skipped: skipped,
        p_ok: ok,
        p_error: errMsg,
        p_extra: {
          query_id: lane.queryId,
          execution_id: executionId,
          dune_total_rows: totalRows,
          staged_for_execution: stagedForExecution,
          up_to_date: upToDate,
          ...(completed ? { completed: true } : {}),
          ...(startOffset > 0 ? { resumed_from: startOffset } : {}),
          ...(resumeOffset != null ? { resume_offset: resumeOffset } : {}),
          ...(pausedStop ? { paused: true } : {}),
          duration_ms: Date.now() - startedMs,
        },
      })
    } catch (logErr) {
      console.log(`[${pipeline}] log_pipeline_run err: ${logErr instanceof Error ? logErr.message : String(logErr)}`)
    }
  })

  return NextResponse.json({ ok: true, accepted: true, pipeline }, { status: 202 })
}
