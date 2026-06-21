import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { fetchLivePackListings, SUPPORTED_PACK_COLLECTIONS } from "@/lib/packs/live-pack-listings"

// Snapshots the live sealed-pack lowest-ask per dist into public.pack_ask_state
// so the Pack Sniper can show a real "just listed / price dropped" recency
// signal (parity with the regular Sniper's "Recently Listed" sort). The Dapper
// Studio aggregation returns one node per dist with NO per-listing timestamp,
// so the only way to know "as they get listed" is to diff snapshots over time —
// which is exactly what the SECDEF RPC upsert_pack_ask_state does, atomically,
// per collection (migration audit_20260621_pack_ask_state_table_and_diff_rpc).
//
// Auth: Bearer INGEST_SECRET_TOKEN. 202 + after() so a slow upstream fetch never
// trips cron-job.org's 30s client cap (pipeline_runs is the real signal).
//
// Operator: wire a cron-job.org entry (www.rippackscity.com, ~every 5 min) with
// Authorization: Bearer <INGEST_SECRET_TOKEN>. Cadence is the freshness lever
// (cost-flat: 2-3 min for snappier "as they get listed", 5+ for lighter egress).

export const dynamic = "force-dynamic"
export const maxDuration = 120

const PIPELINE_NAME = "snapshot-pack-asks"

async function run(request: NextRequest) {
  const auth = request.headers.get("authorization")
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAt = new Date().toISOString()

  after(async () => {
    const startedMs = Date.now()
    let ok = true
    let errMsg: string | null = null
    const perCollection: Record<string, unknown> = {}
    let totalListed = 0
    let totalNew = 0
    let totalChanged = 0
    let totalDropped = 0

    for (const collection of SUPPORTED_PACK_COLLECTIONS) {
      try {
        // force:true bypasses the 2-min in-lambda memo so each tick sees the
        // freshest upstream book (the public board's read path keeps the memo).
        const { listings } = await fetchLivePackListings(collection, { force: true })
        const payload = listings
          .filter((l) => l.lowestAsk > 0)
          .map((l) => ({
            dist_id: l.distId,
            pack_listing_id: l.packListingId,
            lowest_ask: l.lowestAsk,
          }))

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabaseAdmin as any).rpc("upsert_pack_ask_state", {
          p_collection_slug: collection,
          p_listings: payload,
        })

        if (error) {
          ok = false
          errMsg = `${collection}: ${error.message}`
          perCollection[collection] = { error: error.message }
        } else {
          const r = (data ?? {}) as {
            total_listed?: number; new?: number; changed?: number; dropped?: number
          }
          perCollection[collection] = r
          totalListed += Number(r.total_listed ?? 0)
          totalNew += Number(r.new ?? 0)
          totalChanged += Number(r.changed ?? 0)
          totalDropped += Number(r.dropped ?? 0)
        }
      } catch (e) {
        ok = false
        errMsg = `${collection}: ${e instanceof Error ? e.message : String(e)}`
        perCollection[collection] = { error: errMsg }
      }
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAt,
        p_rows_found: totalListed,
        p_rows_written: totalNew + totalChanged,
        p_rows_skipped: totalDropped,
        p_ok: ok,
        p_error: errMsg,
        p_extra: { duration_ms: Date.now() - startedMs, per_collection: perCollection },
      })
    } catch (logErr) {
      console.log(
        `[${PIPELINE_NAME}] log_pipeline_run err: ${logErr instanceof Error ? logErr.message : String(logErr)}`,
      )
    }
  })

  return NextResponse.json({ ok: true, accepted: true, pipeline: PIPELINE_NAME }, { status: 202 })
}

export async function POST(request: NextRequest) {
  return run(request)
}

export async function GET(request: NextRequest) {
  return run(request)
}
