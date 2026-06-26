// app/api/cron/panini-circulation-refresh/route.ts
//
// Panini Blockchain — circulation + pack-state refresh cron. Re-polls the
// Plane-A feed for per-edition circulation (pulled_count) so still_in_packs (the
// squeeze headline) tracks the live drop, then rolls up the pack-level
// panini_pack_state (packs_remaining, % ripped, EV inputs).
//
// INERT until go-live: short-circuits to a logged no-op until PANINI_FEED_MODE +
// creds are set AND the panini_editions / panini_pack_state tables are applied
// (docs/drafts/panini/panini-schema.sql). Do NOT wire a cron entry / watchlist
// row until one manual run verifies circulation decreases over time.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { fetchPaniniEditions, paniniFeedEnabled, paniniFeedMode } from "@/lib/chains/panini/feed"
import { PANINI_SLUG, toEditionRow } from "@/lib/chains/panini/normalize"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "panini-circulation-refresh"
const UPSERT_CHUNK = 500

function authed(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization") ?? ""
  const ingest = process.env.INGEST_SECRET_TOKEN
  const cron = process.env.CRON_SECRET
  return (
    (!!ingest && authHeader === `Bearer ${ingest}`) ||
    (!!cron && authHeader === `Bearer ${cron}`)
  )
}

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
  if (!authed(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAtIso = new Date().toISOString()
  const startedMs = Date.now()

  if (!paniniFeedEnabled()) {
    await logRun(startedAtIso, 0, 0, true, null, {
      skip_reason: "feed_inert",
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

      const byKey = new Map<string, (typeof rows)[number]>()
      for (const r of rows) if (r.external_id) byKey.set(r.external_id, r)
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

      // TODO(go-live): roll up panini_pack_state from the feed's pack-level data
      // (FOTL / Hobby / craft) — packs_remaining + % ripped + gross/net EV (Σ
      // edition_fmv × per-slot pull prob). PaniniRawEdition is card-grain; the
      // pack rollup needs the pack definitions captured at discovery.

      await logRun(startedAtIso, found, written, true, null, {
        circulation_refreshed: written,
        pack_state: "pending_discovery",
        duration_ms: Date.now() - startedMs,
        mode: paniniFeedMode(),
      })
    } catch (e) {
      await logRun(startedAtIso, found, written, false, e instanceof Error ? e.message : String(e), {
        circulation_refreshed: written,
        mode: paniniFeedMode(),
      })
    }
  })

  return NextResponse.json(
    { accepted: true, collection: PANINI_SLUG, started_at: startedAtIso },
    { status: 202 }
  )
}
