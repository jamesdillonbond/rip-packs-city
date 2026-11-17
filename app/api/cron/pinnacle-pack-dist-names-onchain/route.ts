import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { bearerMatches } from "@/lib/auth/bearer-secret"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { logTerminalRun } from "@/lib/pipeline/terminal-run"
import { readPdsDistFacts, mergePinnacleDistMetadata, type PdsDistFacts } from "@/lib/packs/pds-dist-info"

// Disney Pinnacle pack distributions a collector opened get a row, and the row
// gets a name, from the chain.
//
// WHY THIS EXISTS (2026-10-19). The only Pinnacle writer of pack_distributions
// was the compute-pinnacle-pack-ev edge function, which upserts what Studio
// Platform's searchDistributions lists — and that search has listed nothing new
// since mid-August. The 09-25 "Summer Sunset" dists were seeded by hand; the
// 10-09 "Star Wars Halloween Vol.1" drop (dist 8891, 414 opens) and dist 8871
// had no row at all until 20261019155503 seeded them. Nothing kept the 09-25
// post-condition ("no pack event points at a missing distribution") true.
//
// HOW. (1) discover_missing_pinnacle_pack_distributions(14) inserts a placeholder
// row (title NULL) for every dist a recent pinnacle_pack_opens row references
// and the table lacks. (2) Every untitled Pinnacle row is named from
// PDS.getDistInfo (0xb6f2481eba4df97b): title, plus tier, slots, retail price,
// uuid and sale window, FILL-ONLY. A dist whose PDS productID is not "disney" is
// not a Pinnacle distribution: counted as `wrong_product`, never named.
//
// HONESTY. A Flow REST failure fails the run (never a quietly smaller sweep);
// a dist the chain does not know is `not_on_chain` and stays unnamed (NULL, not
// a fabricated title); a budget stop is complete:false; a write error fails the
// run, and the written count is the rows the UPDATE returned.
//
// Auth: `Bearer $CRON_SECRET` (Vercel cron) or `Bearer $INGEST_SECRET_TOKEN`.
// 202 + after(): heartbeat FIRST, terminal row LAST.

export const dynamic = "force-dynamic"
export const maxDuration = 120

const PIPELINE_NAME = "pinnacle-pack-dist-names-onchain"
const PINNACLE_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
const PINNACLE_PDS_PRODUCT_ID = "disney"
const MAX_ROWS_PER_RUN = 100
const TIME_BUDGET_MS = (maxDuration - 30) * 1000
const DISCOVERY_DAYS = 14

type DistRow = { id: string; dist_id: string; metadata: Record<string, unknown> | null }

async function readUntitled(): Promise<{ rows: DistRow[]; complete: boolean }> {
  const { data, error } = await (supabaseAdmin as any)
    .from("pack_distributions")
    .select("id,dist_id,metadata")
    .eq("collection_id", PINNACLE_COLLECTION_ID)
    .is("title", null)
    .order("dist_id", { ascending: true })
    .limit(MAX_ROWS_PER_RUN + 1)
  if (error) throw new Error(`pack_distributions read failed: ${error.message}`)
  const rows = (data ?? []) as DistRow[]
  return { rows: rows.slice(0, MAX_ROWS_PER_RUN), complete: rows.length <= MAX_ROWS_PER_RUN }
}

function authorized(request: NextRequest): boolean {
  // Constant-time, fail-closed on an unset secret (security audit 2026-10-25).
  return bearerMatches(request.headers.get("authorization"), "CRON_SECRET", "INGEST_SECRET_TOKEN")
}

async function run(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedMs = Date.now()

  after(async () => {
    await writeInvocationHeartbeat({ pipeline: PIPELINE_NAME, startedAtMs: startedMs })

    let ok = true
    let errMsg: string | null = null
    let complete = true
    let discovered: number | null = null
    let untitled = 0
    let named = 0
    let notOnChain = 0
    let wrongProduct = 0
    let scriptCalls = 0
    let scriptErrors = 0
    let writeErrors = 0

    // Discovery first, so the naming pass sees the new rows. A failure fails the
    // run but does not stop naming the rows that do exist.
    try {
      const { data, error } = await (supabaseAdmin as any).rpc("discover_missing_pinnacle_pack_distributions", {
        p_days: DISCOVERY_DAYS,
      })
      if (error) throw new Error(error.message)
      // null is not 0 — an absent count must not become a measured zero.
      if (data == null) throw new Error("no count returned")
      discovered = typeof data === "number" ? data : Number(data)
      if (!Number.isFinite(discovered)) throw new Error(`unexpected result ${JSON.stringify(data)}`)
    } catch (e) {
      ok = false
      discovered = null
      errMsg = errMsg ?? `discover: ${e instanceof Error ? e.message : String(e)}`
    }

    try {
      const read = await readUntitled()
      complete = read.complete
      untitled = read.rows.length
      for (const row of read.rows) {
        if (Date.now() - startedMs > TIME_BUDGET_MS) {
          complete = false
          break
        }
        let facts: PdsDistFacts | null
        try {
          scriptCalls++
          facts = await readPdsDistFacts(row.dist_id)
        } catch (e) {
          scriptErrors++
          ok = false
          errMsg = errMsg ?? `flow rest: ${e instanceof Error ? e.message : String(e)}`
          continue
        }
        if (!facts) {
          notOnChain++
          continue
        }
        if (facts.productId !== PINNACLE_PDS_PRODUCT_ID) {
          wrongProduct++
          continue
        }
        // `.is("title", null)` keeps this fill-only under a concurrent writer;
        // the returned rows are the count that LANDED, never the count sent.
        const { data, error } = await (supabaseAdmin as any)
          .from("pack_distributions")
          .update({
            title: facts.title,
            metadata: mergePinnacleDistMetadata(row.metadata, facts),
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id)
          .is("title", null)
          .select("id")
        if (error) {
          writeErrors++
          ok = false
          errMsg = errMsg ?? `write: ${error.message}`
          continue
        }
        named += Array.isArray(data) ? data.length : 0
      }
    } catch (e) {
      ok = false
      errMsg = errMsg ?? (e instanceof Error ? e.message : String(e))
    }

    await logTerminalRun({
      pipeline: PIPELINE_NAME,
      startedAt: startedMs,
      ok,
      error: errMsg,
      rowsFound: untitled,
      rowsWritten: (discovered ?? 0) + named,
      rowsSkipped: notOnChain + wrongProduct,
      collectionSlug: "disney-pinnacle",
      extra: {
        complete,
        discovered,
        untitled,
        named,
        not_on_chain: notOnChain,
        wrong_product: wrongProduct,
        script_calls: scriptCalls,
        script_errors: scriptErrors,
        write_errors: writeErrors,
        duration_ms: Date.now() - startedMs,
      },
    })
  })

  return NextResponse.json({ ok: true, accepted: true, pipeline: PIPELINE_NAME }, { status: 202 })
}

export async function POST(request: NextRequest) {
  return run(request)
}

export async function GET(request: NextRequest) {
  return run(request)
}
