// app/api/ingest/candy-editions/route.ts
//
// Item 3 — Candy (Solana / Metaplex Core) editions + serials ingest. Walks the
// whole Candy collection via DAS getAssetsByGroup, upserting one `editions` row
// per distinct edition key and one `wallet_moments_cache` row per serial (mint).
//
// DISCOVERY COMPLETE 2026-07-17 — CANDY_MLB_COLLECTION_ADDRESS is filled, so this
// route is now LIVE (candyDiscoveryReady() === true). The Candy collection
// (id 209ade70...) stays is_active=false and NO cron is wired: run this manually
// once, verify counts, THEN wire a cron / watchlist row. The collection mixes
// sealed pack assets (Item Type=Pack) with the ICONs — packs are skipped here.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { paginateGroup, type DasAsset } from "@/lib/chains/solana/das"
import {
  CANDY_MLB_COLLECTION_ADDRESS,
  CANDY_MLB_SLUG,
  candyDiscoveryReady,
  isBurnt,
  isPack,
  normalizeEdition,
  normalizePack,
  normalizeSerial,
  CANDY_MLB_UUID,
} from "@/lib/chains/solana/normalize"

export const dynamic = "force-dynamic"
// 800 is the Vercel Pro hard cap — anything above it sends the DEPLOY to ERROR
// invisibly (build logs read "Compiled successfully"), so do not raise it further.
//
// Raised 300 -> 800 on 2026-08-04 after this route started being KILLED at the
// wall. The RPC Sentinel reported it as "Pipeline Silence: candy-editions-ingest
// silent 2337m", which is misleading: the route is not silent, it is dying before
// it can write its pipeline_runs row, so a hard failure presents as an absence.
// Same class as the pinnacle-sync after() defect. Vercel runtime errors show
// "Task timed out after 300 seconds" for this path, and pipeline_runs_daily shows
// the run time climbing 61.4s -> 68.5s -> 71.4s -> 197.4s -> killed across
// 07-30..08-03 while rows_found/rows_written stayed byte-identical at
// 27,876/28,483 — so the slowdown is contention, not data growth.
//
// ⚠ pipeline_runs retains only ~73h; read pipeline_runs_daily for this route's
// history, or a healthy daily cadence looks like a long-dead cron.
export const maxDuration = 800

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

// INGEST_SECRET_TOKEN (GitHub Actions / manual / cron-job.org) OR Bearer
// CRON_SECRET (Vercel cron sends only CRON_SECRET). Both are equivalent-trust
// server secrets. The GET handler exists so the daily Vercel cron — which always
// invokes via GET — can drive the refresh; manual/operator runs POST.
function authed(req: NextRequest): boolean {
  const header = req.headers.get("authorization") ?? ""
  const ingest = process.env.INGEST_SECRET_TOKEN
  const cron = process.env.CRON_SECRET
  if (ingest && header === `Bearer ${ingest}`) return true
  if (cron && header === `Bearer ${cron}`) return true
  return false
}

export async function GET(req: NextRequest) {
  return handleIngest(req)
}

export async function POST(req: NextRequest) {
  return handleIngest(req)
}

async function handleIngest(req: NextRequest) {
  if (!authed(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAtIso = new Date().toISOString()
  const startedMs = Date.now()

  // Invocation heartbeat. The real work runs inside `after()` and logs ONLY on
  // completion, so a killed invocation writes nothing at all and a HARD FAILURE
  // PRESENTS AS AN ABSENCE — the exact ambiguity the maxDuration note at the top
  // of this file describes, and the reason the sentinel reported this route as
  // "silent" when it was in fact being killed at the wall.
  //
  // That was not a one-off. It recurred on 2026-08-16 at the RAISED 800 s
  // ceiling: `pipeline_runs` held nothing newer than 08-15 08:40Z (39.5 h,
  // against an 1800 min cadence arm) while `editions.updated_at` for candy_mlb
  // read 08-16 08:54Z — i.e. the 08-16 tick ran, did its work, and died before
  // logging. Reconciling those two facts needed a hand query against a table
  // nobody watches; this marker makes it a lookup.
  //
  //   heartbeat + candy-editions-ingest row -> ran to completion
  //   heartbeat only                        -> after() dropped / killed at the wall
  //   neither                               -> route never reached (cron / auth)
  //
  // ⚠ SEPARATE pipeline name, never an extra `candy-editions-ingest` row — this
  // pipeline is on pipeline_cadence_watchlist (1800 min), so a marker under its
  // own name would refresh `last_run` every tick and silence
  // detect_stalled_pipelines() on the very outage this exists to expose.
  // ⚠ `duration_ms` on these heartbeat rows is MEANINGLESS — read `extra`/`ok`,
  // never the duration. `log_pipeline_run` has no `p_finished_at` parameter, so
  // the row takes `finished_at DEFAULT now()` and the GENERATED `duration_ms`
  // becomes this insert's own latency. Both sibling Candy heartbeats have the
  // identical property; matching them beats diverging here.
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: `${PIPELINE_NAME}-heartbeat`,
      p_started_at: startedAtIso,
      p_rows_found: 0,
      p_rows_written: 0,
      p_rows_skipped: 0,
      p_ok: true,
      p_error: null,
      p_collection_slug: CANDY_MLB_SLUG,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: { phase: "invoked" },
    })
  } catch (e) {
    // Non-fatal: the heartbeat is diagnostic. Never let it break the ingest.
    console.log(
      `[${PIPELINE_NAME}] heartbeat log failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`
    )
  }

  if (!candyDiscoveryReady()) {
    await logRun(startedAtIso, 0, 0, true, null, {
      skip_reason: "discovery_pending",
      note: "CANDY_MLB_COLLECTION_ADDRESS not configured (still a TODO_-prefixed placeholder)",
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
    let burntSkipped = 0
    let packsSkipped = 0
    let packRowsWritten = 0
    // DISTINCT catalog counts. editionsWritten/serialsWritten below are
    // upsert ROWS TOUCHED across DAS page-chunks — the same 125 editions are
    // re-upserted on every page, so that counter read 3,108 for a 125-edition
    // catalog (2026-07-26). Keep both, but name them for what they are.
    const distinctEditionKeys = new Set<string>()
    const distinctMints = new Set<string>()
    const distinctPackMints = new Set<string>()
    const distinctJerseys = new Set<string>()
    try {
      assetsSeen = await paginateGroup(CANDY_MLB_COLLECTION_ADDRESS, async (items) => {
        // Editions: dedup by external_id within the page (many serials share one
        // edition key) — upserting the same conflict target twice in one batch
        // is a Postgres error.
        // Burnt assets (Diamond Economy) never create or refresh rows — their
        // ownership is stale and the serial has left circulation. Pack assets
        // (Item Type=Pack) are not editions/moments — skip them too.
        // Packs are checked FIRST and BEFORE the burnt filter so a burnt pack
        // would still be recorded. NOTE (verified 2026-07-27 on the first full
        // walk): opening a Candy pack does NOT burn it — is_burnt is false on
        // all 2,501 pack assets while ~700+ packs have demonstrably been opened
        // (an opened pack returns to the treasury). So is_burnt is NOT an
        // opened-pack signal and candy_pack_market deliberately publishes no
        // sealed-vs-opened split. Cards keep the old behaviour — a burnt card
        // never creates or refreshes an editions/wmc row.
        const packAssets: DasAsset[] = []
        const live = (items as DasAsset[]).filter((a) => {
          if (isPack(a)) {
            packsSkipped++
            packAssets.push(a)
            return false
          }
          if (isBurnt(a)) {
            burntSkipped++
            return false
          }
          return true
        })

        // Sealed-pack inventory. The DAS walk already paid for these assets and
        // used to throw them away, so this is a free feed for candy_pack_market.
        if (packAssets.length > 0) {
          const nowIso = new Date().toISOString()
          const packRows = packAssets.map((a) => ({
            ...normalizePack(a),
            last_seen_at: nowIso,
          }))
          for (let i = 0; i < packRows.length; i += UPSERT_CHUNK) {
            const chunk = packRows.slice(i, i + UPSERT_CHUNK)
            const { data, error } = await (supabaseAdmin as any)
              .from("candy_packs")
              .upsert(chunk, { onConflict: "token_mint" })
              .select("token_mint")
            if (error) {
              console.log(`[${PIPELINE_NAME}] candy_packs upsert err: ${error.message}`)
            } else {
              packRowsWritten += data?.length ?? chunk.length
              for (const r of chunk) distinctPackMints.add(r.token_mint)
            }
          }
        }
        const edByKey = new Map<string, ReturnType<typeof normalizeEdition>>()
        for (const a of live) {
          const e = normalizeEdition(a)
          if (e.external_id) {
            edByKey.set(e.external_id, e)
            distinctEditionKeys.add(e.external_id)
            // Jersey numbers ride the SAME attribute map normalizeEdition already
            // reads, and land on editions.jersey_number — the platform-wide column
            // Top Shot and All Day fill, not a Candy-only side table. Counted here
            // so the run log shows trait coverage without a second query.
            if (e.jersey_number != null) distinctJerseys.add(e.external_id)
          }
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

        // Serials -> wmc. One row per mint; moment_id is unique so no in-batch
        // conflict. created_at is DB-defaulted (mirrors the Flow backfills).
        const now = new Date().toISOString()
        const serialRows = live
          .map((a) => {
            const s = normalizeSerial(a)
            if (!s.wallet_address || !s.moment_id) return null
            distinctMints.add(s.moment_id)
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

        // Metadata denorm post-pass (2026-08-02) — the missing half of the
        // Candy wmc write path.
        //
        // normalizeSerial() emits exactly 6 columns (wallet_address,
        // collection_id, moment_id, edition_key, serial_number, image_url).
        // tier / set_name / mint_count / player_name / team_name are NOT in
        // the payload and were therefore NEVER filled by this route — unlike
        // every Flow wallet backfill, which calls this same RPC as a post-pass
        // (see runAllDayDetailsBackfill). Result: 18,932 of 25,375 Candy wmc
        // rows (74.6%) rendered unlabelled on the PUBLIC /insights/candy-mlb
        // surface. The 6,443 that were fine had been filled by a one-off
        // 2026-07-19 parity denorm; everything created after that date was
        // never enriched by anything.
        //
        // This is NOT the `set_name` re-NULLing class fixed on 2026-08-01 —
        // that was on `editions`. Because these columns are absent from the
        // upsert payload, PostgREST's ON CONFLICT DO UPDATE never touches
        // them, so a fill here is durable (verified: all 25,375 rows were
        // re-upserted 2026-08-02 08:40Z and every already-enriched row kept
        // its tier). The RPC is COALESCE-guarded — it only ever fills a NULL.
        try {
          const { error: denormErr } = await (supabaseAdmin as any).rpc(
            "backfill_wmc_metadata_from_editions",
            { p_wallet_address: null, p_collection_id: CANDY_MLB_UUID },
          )
          if (denormErr) {
            console.log(`[${PIPELINE_NAME}] wmc metadata denorm err: ${denormErr.message}`)
          }
        } catch (e) {
          console.log(`[${PIPELINE_NAME}] wmc metadata denorm threw: ${e instanceof Error ? e.message : String(e)}`)
        }
      })

      await logRun(startedAtIso, assetsSeen, editionsWritten + serialsWritten, true, null, {
        assets_seen: assetsSeen,
        edition_rows_touched: editionsWritten,
        serial_rows_touched: serialsWritten,
        editions_distinct: distinctEditionKeys.size,
        serials_distinct: distinctMints.size,
        burnt_skipped: burntSkipped,
        packs_skipped: packsSkipped,
        pack_rows_touched: packRowsWritten,
        packs_distinct: distinctPackMints.size,
        jerseys_distinct: distinctJerseys.size,
        duration_ms: Date.now() - startedMs,
      })
    } catch (e) {
      await logRun(
        startedAtIso,
        assetsSeen,
        editionsWritten + serialsWritten,
        false,
        e instanceof Error ? e.message : String(e),
        {
          assets_seen: assetsSeen,
          edition_rows_touched: editionsWritten,
          serial_rows_touched: serialsWritten,
          editions_distinct: distinctEditionKeys.size,
          serials_distinct: distinctMints.size,
          packs_skipped: packsSkipped,
          packs_distinct: distinctPackMints.size,
        }
      )
    }
  })

  return NextResponse.json(
    { accepted: true, collection: CANDY_MLB_SLUG, started_at: startedAtIso },
    { status: 202 }
  )
}
