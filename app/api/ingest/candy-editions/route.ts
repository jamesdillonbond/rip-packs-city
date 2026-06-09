// app/api/ingest/candy-editions/route.ts
//
// Item 3 — Candy (Solana / Metaplex Core) editions + serials ingest. Walks the
// whole Candy collection via DAS getAssetsByGroup, upserting one `editions` row
// per distinct edition key and one `wallet_moments_cache` row per serial (mint).
//
// INERT until discovery: the Candy collection (id 209ade70…) is is_active=false
// and CANDY_MLB_COLLECTION_ADDRESS is a TODO placeholder, so the route short-
// circuits to a clean no-op (logged ok=true, skipped) until Item 0 fills it in.
// Do NOT wire a cron / watchlist row until the collection address is set and one
// manual run has verified counts.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { paginateGroup, type DasAsset } from "@/lib/chains/solana/das"
import {
  CANDY_MLB_COLLECTION_ADDRESS,
  CANDY_MLB_SLUG,
  candyDiscoveryReady,
  normalizeEdition,
  normalizeSerial,
} from "@/lib/chains/solana/normalize"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "candy-editions-ingest"
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
      p_collection_slug: CANDY_MLB_SLUG,
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

  if (!candyDiscoveryReady()) {
    await logRun(startedAtIso, 0, 0, true, null, {
      skip_reason: "discovery_pending",
      note: "CANDY_MLB_COLLECTION_ADDRESS is a TODO placeholder",
    })
    return NextResponse.json(
      { accepted: false, skipped: "discovery_pending", collection: CANDY_MLB_SLUG },
      { status: 202 }
    )
  }

  after(async () => {
    let assetsSeen = 0
    let editionsWritten = 0
    let serialsWritten = 0
    try {
      assetsSeen = await paginateGroup(CANDY_MLB_COLLECTION_ADDRESS, async (items) => {
        // Editions: dedup by external_id within the page (many serials share one
        // edition key) — upserting the same conflict target twice in one batch
        // is a Postgres error.
        const edByKey = new Map<string, ReturnType<typeof normalizeEdition>>()
        for (const a of items as DasAsset[]) {
          const e = normalizeEdition(a)
          if (e.external_id) edByKey.set(e.external_id, e)
        }
        const editionRows = [...edByKey.values()]
        for (let i = 0; i < editionRows.length; i += UPSERT_CHUNK) {
          const chunk = editionRows.slice(i, i + UPSERT_CHUNK)
          const { data, error } = await (supabaseAdmin as any)
            .from("editions")
            .upsert(chunk, { onConflict: "external_id,collection_id" })
            .select("id")
          if (error) {
            console.log(`[${PIPELINE_NAME}] editions upsert err: ${error.message}`)
          } else {
            editionsWritten += data?.length ?? chunk.length
          }
        }

        // Serials → wmc. One row per mint; moment_id is unique so no in-batch
        // conflict. created_at is DB-defaulted (mirrors the Flow backfills).
        const now = new Date().toISOString()
        const serialRows = (items as DasAsset[])
          .map((a) => {
            const s = normalizeSerial(a)
            if (!s.wallet_address || !s.moment_id) return null
            return { ...s, last_seen_at: now }
          })
          .filter((r): r is NonNullable<typeof r> => r !== null)
        for (let i = 0; i < serialRows.length; i += UPSERT_CHUNK) {
          const chunk = serialRows.slice(i, i + UPSERT_CHUNK)
          const { data, error } = await (supabaseAdmin as any)
            .from("wallet_moments_cache")
            .upsert(chunk, { onConflict: "wallet_address,collection_id,moment_id" })
            .select("moment_id")
          if (error) {
            console.log(`[${PIPELINE_NAME}] wmc upsert err: ${error.message}`)
          } else {
            serialsWritten += data?.length ?? chunk.length
          }
        }
      })

      await logRun(startedAtIso, assetsSeen, editionsWritten + serialsWritten, true, null, {
        assets_seen: assetsSeen,
        editions_written: editionsWritten,
        serials_written: serialsWritten,
        duration_ms: Date.now() - startedMs,
      })
    } catch (e) {
      await logRun(
        startedAtIso,
        assetsSeen,
        editionsWritten + serialsWritten,
        false,
        e instanceof Error ? e.message : String(e),
        { assets_seen: assetsSeen, editions_written: editionsWritten, serials_written: serialsWritten }
      )
    }
  })

  return NextResponse.json(
    { accepted: true, collection: CANDY_MLB_SLUG, started_at: startedAtIso },
    { status: 202 }
  )
}
