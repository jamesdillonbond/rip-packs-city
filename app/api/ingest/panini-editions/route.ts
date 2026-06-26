// app/api/ingest/panini-editions/route.ts
//
// Panini Blockchain — catalog + circulation ingest. Pulls every WC2026 Prizm
// edition from the Plane-A feed and upserts one panini_editions row per edition,
// refreshing pulled_count (circulation) so still_in_packs (the generated squeeze
// input) stays current.
//
// INERT until go-live: the feed returns [] until PANINI_FEED_MODE + creds are set
// (lib/chains/panini/feed.ts) AND the panini_editions table is applied
// (docs/drafts/panini/panini-schema.sql — NOT yet applied). Until then the route
// short-circuits to a clean logged no-op. Do NOT wire a cron / watchlist row
// until the feed is configured and one manual run has verified counts against the
// product spec ladder.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { fetchPaniniEditions, paniniFeedEnabled, paniniFeedMode } from "@/lib/chains/panini/feed"
import { PANINI_SLUG, toEditionRow } from "@/lib/chains/panini/normalize"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "panini-editions-ingest"
const UPSERT_CHUNK = 500

async function logRun(
  startedAtIso: string,
  rowsFound: number,
  rowsWritten: number,
  ok: boolean,
  error: string | null,
  extra: Record<string, unknown>
) {
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: rowsFound,
      p_rows_written: rowsWritten,
      p_rows_skipped: 0,
      p_ok: ok,
      p_error: error,
      p_collection_slug: PANINI_SLUG,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: extra,
    })
  } catch (e) {
    console.log(
      `[${PIPELINE_NAME}] log_pipeline_run failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`
    )
  }
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization")
  const expectedToken = process.env.INGEST_SECRET_TOKEN
  if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAtIso = new Date().toISOString()
  const startedMs = Date.now()

  if (!paniniFeedEnabled()) {
    await logRun(startedAtIso, 0, 0, true, null, {
      skip_reason: "feed_inert",
      note: "PANINI_FEED_MODE unset or creds missing",
      mode: paniniFeedMode(),
    })
    return NextResponse.json(
      { accepted: false, skipped: "feed_inert", collection: PANINI_SLUG },
      { status: 202 }
    )
  }

  after(async () => {
    let found = 0
    let written = 0
    try {
      const nowIso = new Date().toISOString()
      const rows = (await fetchPaniniEditions()).map((r) => toEditionRow(r, nowIso))
      found = rows.length

      // Dedup by external_id within the batch (the feed can return multiple
      // serials sharing one edition key) — upserting the same conflict target
      // twice in a single batch is a Postgres error.
      const byKey = new Map<string, (typeof rows)[number]>()
      for (const r of rows) {
        if (r.external_id) byKey.set(r.external_id, r)
      }
      const editionRows = [...byKey.values()]

      for (let i = 0; i < editionRows.length; i += UPSERT_CHUNK) {
        const chunk = editionRows.slice(i, i + UPSERT_CHUNK)
        const { data, error } = await (supabaseAdmin as any)
          .from("panini_editions")
          .upsert(chunk, { onConflict: "external_id,collection_id" })
          .select("id")
        if (error) {
          console.log(`[${PIPELINE_NAME}] panini_editions upsert err: ${error.message}`)
        } else {
          written += data?.length ?? chunk.length
        }
      }

      // still_in_packs recomputes automatically (generated column on mint_cap −
      // pulled_count). panini_pack_state + panini_fmv_snapshots are refreshed by
      // their own routes (panini-circulation-refresh / panini-fmv-recalc).
      await logRun(startedAtIso, found, written, true, null, {
        editions_written: written,
        duration_ms: Date.now() - startedMs,
        mode: paniniFeedMode(),
      })
    } catch (e) {
      await logRun(startedAtIso, found, written, false, e instanceof Error ? e.message : String(e), {
        editions_written: written,
        mode: paniniFeedMode(),
      })
    }
  })

  return NextResponse.json(
    { accepted: true, collection: PANINI_SLUG, started_at: startedAtIso },
    { status: 202 }
  )
}
