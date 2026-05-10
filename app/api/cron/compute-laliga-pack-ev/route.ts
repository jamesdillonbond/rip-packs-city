// app/api/cron/compute-laliga-pack-ev/route.ts
//
// LaLiga Golazos pack-EV-derived FMV fallback (R1). Mirrors the shape of
// supabase/functions/compute-allday-pack-ev/index.ts but reads from an
// already-seeded pack_drop_pool (no GQL fetch — Golazos uses a separate
// pool seeder) and adds a sentinel FMV write for thin-coverage editions.
//
// What it does, per dist_id in pack_drop_pool for the Golazos collection:
//   1. Calls compute_pack_ev_from_pool RPC to get gross_ev / pack_ev /
//      per-edition EV (via the existing pool weighting — same primitive
//      AllDay uses).
//   2. Inserts a pack_ev_history row.
//   3. For each edition in the pool that has sales_count_30d=0 AND
//      no ask_proxy_fmv in the most recent fmv_snapshots row, writes a
//      sentinel fmv_snapshots row with fmv_usd=0, confidence=PACK_EV,
//      algo_version='pack-ev-v1-laliga'. The guard prevents clobbering
//      real FMVs — only editions with no sales evidence and no ask
//      proxy receive the pack-ev fallback.
//
// Bearer-gated by INGEST_SECRET_TOKEN or CRON_SECRET. Daily schedule
// via vercel.json (added in this commit).
//
// Note: pack_drop_pool currently has zero Golazos rows — until the pool
// seeder lands, this route is a no-op that logs `pool_empty=true` and
// returns 200. The shape is in place so a single seed write enables
// pack-EV FMVs across the entire Golazos catalog.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const maxDuration = 300
export const dynamic = "force-dynamic"

const GOLAZOS_COLLECTION_ID = "06248cc4-b85f-47cd-af67-1855d14acd75"
const ALGO_VERSION = "pack-ev-v1-laliga"
const SENTINEL_FMV_USD = 0

function isAuthed(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? ""
  const ingest = process.env.INGEST_SECRET_TOKEN
  const cron = process.env.CRON_SECRET
  if (ingest && auth === `Bearer ${ingest}`) return true
  if (cron && auth === `Bearer ${cron}`) return true
  // Allow ?token=… for cron-job.org browser-fired triggers — same pattern
  // as the rest of the cron tree.
  const qToken = req.nextUrl.searchParams.get("token") ?? ""
  if (ingest && qToken === ingest) return true
  if (cron && qToken === cron) return true
  return false
}

interface PoolRow {
  dist_id: string
  edition_id: string
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
    const { error } = await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: "compute-laliga-pack-ev",
      p_started_at: args.startedAtIso,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.errorMsg,
      p_collection_slug: "laliga_golazos",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: args.extra,
    })
    if (error) console.log("[compute-laliga-pack-ev] log_pipeline_run:", error.message)
  } catch (err) {
    console.log("[compute-laliga-pack-ev] log_pipeline_run threw:", err instanceof Error ? err.message : err)
  }
}

export async function POST(req: NextRequest) {
  if (!isAuthed(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  const startedAt = Date.now()
  const startedAtIso = new Date(startedAt).toISOString()

  after(async () => {
    const counters = {
      pool_empty: false,
      dists_processed: 0,
      ev_rows_written: 0,
      sentinels_written: 0,
      sentinels_skipped_existing_fmv: 0,
      rpc_errors: 0,
    }

    try {
      const sb = supabaseAdmin as any

      // 1. Pull all (dist_id, edition_id) pairs in the Golazos pool.
      const { data: poolRowsRaw, error: poolErr } = await sb
        .from("pack_drop_pool")
        .select("dist_id, edition_id")
        .eq("collection_id", GOLAZOS_COLLECTION_ID)

      if (poolErr) {
        await logPipelineRun({
          startedAtIso,
          ok: false,
          rowsFound: 0,
          rowsWritten: 0,
          rowsSkipped: 0,
          errorMsg: `pool fetch: ${poolErr.message}`,
          extra: { counters, elapsed_ms: Date.now() - startedAt },
        })
        return
      }

      const poolRows = (poolRowsRaw ?? []) as PoolRow[]
      if (poolRows.length === 0) {
        counters.pool_empty = true
        await logPipelineRun({
          startedAtIso,
          ok: true,
          rowsFound: 0,
          rowsWritten: 0,
          rowsSkipped: 0,
          errorMsg: null,
          extra: { counters, elapsed_ms: Date.now() - startedAt, algo_version: ALGO_VERSION, message: "pack_drop_pool has no Golazos rows yet" },
        })
        return
      }

      // 2. Group by dist_id.
      const distEditions = new Map<string, Set<string>>()
      for (const r of poolRows) {
        let s = distEditions.get(r.dist_id)
        if (!s) {
          s = new Set<string>()
          distEditions.set(r.dist_id, s)
        }
        s.add(r.edition_id)
      }

      // 3. For each dist_id, call the EV RPC (compute_pack_ev_from_pool —
      // shared with AllDay/TS path). pack_price=0 / slots=1 give a per-pull
      // EV reading; downstream consumers can scale by price later.
      const evRows: Array<Record<string, unknown>> = []
      const allEditionIds = new Set<string>()
      for (const [distId, editionSet] of distEditions.entries()) {
        const { data: rpcResult, error: rpcErr } = await sb.rpc("compute_pack_ev_from_pool", {
          p_collection_id: GOLAZOS_COLLECTION_ID,
          p_dist_id: distId,
          p_pack_price: 0,
          p_slots: 1,
        })
        if (rpcErr) {
          counters.rpc_errors++
          console.log(`[compute-laliga-pack-ev] rpc err dist=${distId}: ${rpcErr.message}`)
          continue
        }
        const ev = rpcResult as Record<string, unknown> | null
        if (!ev || ev.ok !== true) continue
        counters.dists_processed++
        evRows.push({
          collection_id: GOLAZOS_COLLECTION_ID,
          dist_id: distId,
          pack_listing_id: null,
          pack_name: null,
          pack_price: 0,
          gross_ev: Number(ev.gross_ev ?? 0),
          pack_ev: Number(ev.pack_ev ?? 0),
          is_positive_ev: Boolean(ev.is_positive_ev),
          value_ratio: ev.value_ratio != null ? Number(ev.value_ratio) : null,
          fmv_coverage_pct: Number(ev.fmv_coverage_pct ?? 0),
          edition_count: Math.min(Number(ev.edition_count ?? editionSet.size), 32767),
          total_unopened: 0,
          depletion_pct: null,
          algo_version: ALGO_VERSION,
        })
        for (const id of editionSet) allEditionIds.add(id)
      }

      if (evRows.length > 0) {
        const { error: evInsErr } = await sb.from("pack_ev_history").insert(evRows)
        if (evInsErr) {
          await logPipelineRun({
            startedAtIso,
            ok: false,
            rowsFound: poolRows.length,
            rowsWritten: 0,
            rowsSkipped: poolRows.length,
            errorMsg: `pack_ev_history insert: ${evInsErr.message}`,
            extra: { counters, elapsed_ms: Date.now() - startedAt, algo_version: ALGO_VERSION },
          })
          return
        }
        counters.ev_rows_written = evRows.length
      }

      // 4. Sentinel FMV write — for editions in the pool that currently
      // have NO recent fmv_snapshots row OR have one with sales_count_30d=0
      // AND ask_proxy_fmv IS NULL. Real sales-driven FMVs are never touched.
      const editionList = Array.from(allEditionIds)
      const sentinelEditions: string[] = []
      const FMV_LOOKUP_CHUNK = 200
      for (let i = 0; i < editionList.length; i += FMV_LOOKUP_CHUNK) {
        const chunk = editionList.slice(i, i + FMV_LOOKUP_CHUNK)
        const { data: latestFmv } = await sb
          .from("fmv_snapshots")
          .select("edition_id, sales_count_30d, ask_proxy_fmv, computed_at")
          .in("edition_id", chunk)
          .order("computed_at", { ascending: false })

        const latestByEdition = new Map<string, { sales: number; askProxy: number | null }>()
        for (const row of (latestFmv ?? []) as Array<{
          edition_id: string
          sales_count_30d: number | null
          ask_proxy_fmv: number | null
        }>) {
          if (latestByEdition.has(row.edition_id)) continue
          latestByEdition.set(row.edition_id, {
            sales: Number(row.sales_count_30d ?? 0),
            askProxy: row.ask_proxy_fmv != null ? Number(row.ask_proxy_fmv) : null,
          })
        }

        for (const id of chunk) {
          const meta = latestByEdition.get(id)
          if (!meta) {
            // No fmv_snapshots row at all → safe to write sentinel.
            sentinelEditions.push(id)
            continue
          }
          if (meta.sales > 0) {
            counters.sentinels_skipped_existing_fmv++
            continue
          }
          if (meta.askProxy != null && meta.askProxy > 0) {
            counters.sentinels_skipped_existing_fmv++
            continue
          }
          sentinelEditions.push(id)
        }
      }

      if (sentinelEditions.length > 0) {
        const todayStart = new Date()
        todayStart.setUTCHours(0, 0, 0, 0)

        // Delete-then-insert (fmv_snapshots is partitioned, never upsert).
        const DEL_CHUNK = 500
        for (let i = 0; i < sentinelEditions.length; i += DEL_CHUNK) {
          const slice = sentinelEditions.slice(i, i + DEL_CHUNK)
          await sb
            .from("fmv_snapshots")
            .delete()
            .in("edition_id", slice)
            .gte("computed_at", todayStart.toISOString())
        }

        const sentinelRows = sentinelEditions.map((edId) => ({
          edition_id: edId,
          collection_id: GOLAZOS_COLLECTION_ID,
          fmv_usd: SENTINEL_FMV_USD,
          floor_price_usd: null,
          wap_usd: null,
          wap_without_outliers: null,
          liquidity_rating: 0,
          confidence: "PACK_EV",
          ask_proxy_fmv: null,
          sales_count_7d: 0,
          sales_count_30d: 0,
          days_since_sale: null,
          algo_version: ALGO_VERSION,
        }))

        const INS_CHUNK = 100
        for (let i = 0; i < sentinelRows.length; i += INS_CHUNK) {
          const chunk = sentinelRows.slice(i, i + INS_CHUNK)
          const { error: sentErr } = await sb.from("fmv_snapshots").insert(chunk)
          if (!sentErr) counters.sentinels_written += chunk.length
          else console.log("[compute-laliga-pack-ev] sentinel insert err:", sentErr.message)
        }
      }

      await logPipelineRun({
        startedAtIso,
        ok: true,
        rowsFound: poolRows.length,
        rowsWritten: counters.ev_rows_written + counters.sentinels_written,
        rowsSkipped: counters.sentinels_skipped_existing_fmv,
        errorMsg: null,
        extra: {
          ...counters,
          algo_version: ALGO_VERSION,
          elapsed_ms: Date.now() - startedAt,
          dists_total: distEditions.size,
          editions_total: editionList.length,
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error("[compute-laliga-pack-ev] fatal:", msg)
      await logPipelineRun({
        startedAtIso,
        ok: false,
        rowsFound: 0,
        rowsWritten: 0,
        rowsSkipped: 0,
        errorMsg: msg,
        extra: { elapsed_ms: Date.now() - startedAt, algo_version: ALGO_VERSION },
      })
    }
  })

  return NextResponse.json({
    ok: true,
    message: "compute-laliga-pack-ev triggered",
    triggered_at: startedAtIso,
  })
}

export async function GET(req: NextRequest) {
  return POST(req)
}
