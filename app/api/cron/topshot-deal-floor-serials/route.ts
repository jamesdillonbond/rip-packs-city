import { NextRequest, NextResponse, after } from "next/server"
import { topshotGraphql } from "@/lib/topshot"
import { supabaseAdmin } from "@/lib/supabase"

// ─────────────────────────────────────────────────────────────────────────────
// Floor-listing serial capture for the edition-level deal board.
//
// The edition-level deal board (cross_collection_deals_board -> topshot_deals_vs_fmv
// -> edition_offers) carries only the FLOOR PRICE (edition_offers.low_ask, written
// by offers-sweep's aggregate searchMarketplaceEditions walk). That walk exposes no
// per-listing serial, so an edition deal alert renders "Legendary · Set · /50" with
// no serial and no Buy link — a #3/50 at $75 reads identically to a #49/50.
//
// This cron fills that gap. For every edition currently on the TS deal board it
// fetches the CHEAPEST active listing via searchMintedMoments(sortBy:PRICE_USD_ASC,
// limit 1) and writes its serial + nft_id + price into edition_offers. Price and
// serial therefore come from the SAME listing (the handoff's hard consistency
// rule), and low_ask is overwritten from that listing so the displayed ask always
// equals the displayed serial's price.
//
// searchMintedMoments.byEditions takes Top Shot UUIDs, not the "setID:playID"
// integer pair, so we read set_uuid/play_uuid from edition_offers (persisted by
// offers-sweep, which already receives set.id/play.id for every edition). A deal
// edition without UUIDs yet (offers-sweep cycle ~80m) is simply skipped this run.
//
// Live cron (cron-job.org): POST /api/cron/topshot-deal-floor-serials with
// Authorization: Bearer $INGEST_SECRET_TOKEN (or ?token=) ~hourly. Returns 202;
// the GQL fan-out (~600 calls) runs in after() and exceeds cron-job.org's 30s cap.
// pipeline_runs ('topshot-deal-floor-serials') is the real success signal.
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 300
export const dynamic = "force-dynamic"

const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const PIPELINE_NAME = "topshot-deal-floor-serials"
const IN_CHUNK = 200
// The TS-GQL proxy rate-limits a burst fan-out (5 workers tripped a 429 on ~88%
// of calls), so reliability beats raw speed here: 2 workers + per-call jitter to
// desync them + bounded backoff retry on 429/5xx/network. The route is after()-
// wrapped at maxDuration=300, so a slower fully-covering run is fine.
const CONCURRENCY = 2
const UPSERT_BATCH = 500
const MAX_RETRIES = 3

const FLOOR_QUERY = `
  query FloorListing($filters: MintedMomentFilterInput!, $s: BaseSearchInput!) {
    searchMintedMoments(input: { filters: $filters searchInput: $s sortBy: PRICE_USD_ASC }) {
      data {
        searchSummary {
          data {
            data {
              ... on MintedMoment { flowId flowSerialNumber price }
            }
          }
        }
      }
    }
  }
`

type FloorMoment = { flowId: string | null; flowSerialNumber: string | null; price: string | null }
type FloorGql = {
  searchMintedMoments: {
    data: { searchSummary: { data: { data: FloorMoment[] } } } | null
  } | null
}

type DealEdition = {
  external_id: string
  set_uuid: string
  play_uuid: string
  low_ask_serial: number | null
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// A 429 means "slow down + retry," not "no listing." Network/timeout throws and
// 5xx are transient too. A genuine empty result (no active listing) is NOT thrown
// here — fetchFloorListing returns null for that — so only true faults reach this.
function is429(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    msg.includes("429") ||
    msg.includes("too many request") ||
    msg.includes("slow down") ||
    msg.includes("rate limit")
  )
}

function isRetryable(err: unknown): boolean {
  if (is429(err)) return true
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    /failed with 5\d\d/.test(msg) ||
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("socket")
  )
}

async function fetchFloorListing(setUuid: string, playUuid: string): Promise<FloorMoment | null> {
  const data = await topshotGraphql<FloorGql>(FLOOR_QUERY, {
    filters: { byEditions: [{ setID: setUuid, playID: playUuid }], byPrice: { min: 1 } },
    s: { pagination: { direction: "RIGHT", limit: 1, cursor: "" } },
  })
  const row = data?.searchMintedMoments?.data?.searchSummary?.data?.data?.[0]
  return row ?? null
}

// Bounded exponential backoff (~400/800/1600ms + jitter) on 429/5xx/network.
// Re-throws the last error once retries are exhausted or the error isn't transient.
async function fetchFloorWithRetry(setUuid: string, playUuid: string): Promise<FloorMoment | null> {
  let attempt = 0
  for (;;) {
    try {
      return await fetchFloorListing(setUuid, playUuid)
    } catch (err) {
      if (attempt >= MAX_RETRIES || !isRetryable(err)) throw err
      const backoff = 400 * Math.pow(2, attempt) + Math.floor(Math.random() * 250)
      await sleep(backoff)
      attempt++
    }
  }
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const queryToken = req.nextUrl.searchParams.get("token") ?? ""
  const ok =
    !!process.env.INGEST_SECRET_TOKEN &&
    (bearer === process.env.INGEST_SECRET_TOKEN || queryToken === process.env.INGEST_SECRET_TOKEN)
  if (!ok) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  after(async () => {
    const startTime = Date.now()
    let fetchError: string | null = null
    let editionsTargeted = 0
    let listingsFound = 0
    let upserted = 0
    let skippedNoListing = 0
    let gqlErrors = 0
    let throttledGiveUps = 0

    try {
      // 1. The deal set = TS editions currently on the deal board.
      const { data: dealRows, error: dealErr } = await (supabaseAdmin as any)
        .from("topshot_deals_vs_fmv")
        .select("external_id")
        .limit(5000)
      if (dealErr) throw new Error(`deal board read: ${dealErr.message}`)
      const dealExtIds = Array.from(
        new Set(((dealRows ?? []) as Array<{ external_id: string }>).map((r) => r.external_id))
      )

      // 2. Resolve their UUIDs from edition_offers (persisted by offers-sweep).
      const targets: DealEdition[] = []
      for (let i = 0; i < dealExtIds.length; i += IN_CHUNK) {
        const chunk = dealExtIds.slice(i, i + IN_CHUNK)
        const { data, error } = await (supabaseAdmin as any)
          .from("edition_offers")
          .select("external_id, set_uuid, play_uuid, low_ask_serial")
          .eq("collection_id", COLLECTION_ID)
          .in("external_id", chunk)
          .not("set_uuid", "is", null)
          .not("play_uuid", "is", null)
        if (error) throw new Error(`edition_offers read: ${error.message}`)
        for (const r of (data as DealEdition[] | null) ?? []) targets.push(r)
      }
      // First-coverage editions (no serial yet) go first, so they don't compete
      // with already-serialed refreshes for the limited per-run throughput.
      targets.sort((a, b) => (a.low_ask_serial == null ? 0 : 1) - (b.low_ask_serial == null ? 0 : 1))
      editionsTargeted = targets.length

      // 3. Fetch each edition's floor listing (bounded concurrency).
      const rows: Array<Record<string, unknown>> = []
      const nowIso = new Date().toISOString()
      let cursor = 0
      async function worker() {
        while (cursor < targets.length) {
          const t = targets[cursor++]
          // Small jitter desyncs the two workers so they don't hit the proxy in lockstep.
          await sleep(50 + Math.floor(Math.random() * 100))
          try {
            const floor = await fetchFloorWithRetry(t.set_uuid, t.play_uuid)
            const serial = floor?.flowSerialNumber != null ? Number(floor.flowSerialNumber) : NaN
            const price = floor?.price != null ? Number(floor.price) : NaN
            const nftId = floor?.flowId != null ? String(floor.flowId) : null
            if (!floor || !nftId || !Number.isFinite(serial) || !Number.isFinite(price) || price <= 0) {
              skippedNoListing++
              continue
            }
            listingsFound++
            // Price + serial + nft_id from the same listing; overwrite low_ask so
            // the displayed ask always matches the displayed serial's price.
            rows.push({
              collection_id: COLLECTION_ID,
              external_id: t.external_id,
              low_ask: price,
              low_ask_serial: serial,
              low_ask_nft_id: nftId,
              updated_at: nowIso,
            })
          } catch (err) {
            gqlErrors++
            if (is429(err)) throttledGiveUps++
            console.log(`[${PIPELINE_NAME}] floor fetch ${t.external_id} err:`, err instanceof Error ? err.message : String(err))
          }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

      // 4. Upsert (omitted columns — highest_offer, set_uuid, play_uuid — are
      //    preserved on conflict).
      for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
        const batch = rows.slice(i, i + UPSERT_BATCH)
        const { error } = await (supabaseAdmin as any)
          .from("edition_offers")
          .upsert(batch, { onConflict: "collection_id,external_id" })
        if (error) {
          console.log(`[${PIPELINE_NAME}] upsert batch ${i} error:`, error.message)
        } else {
          upserted += batch.length
        }
      }
    } catch (e) {
      fetchError = e instanceof Error ? e.message : String(e)
      console.log(`[${PIPELINE_NAME}] fatal:`, fetchError)
    }

    try {
      await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: new Date(startTime).toISOString(),
        p_rows_found: editionsTargeted,
        p_rows_written: upserted,
        p_rows_skipped: skippedNoListing,
        p_ok: fetchError === null,
        p_error: fetchError,
        p_collection_slug: "nba_top_shot",
        p_extra: {
          listings_found: listingsFound,
          gql_errors: gqlErrors,
          throttled_giveups: throttledGiveUps,
          duration_ms: Date.now() - startTime,
        },
      })
    } catch (err) {
      console.warn(`[${PIPELINE_NAME}] log_pipeline_run failed (non-fatal):`, err)
    }
  })

  return NextResponse.json({ ok: true, accepted: true, pipeline: PIPELINE_NAME }, { status: 202 })
}

export async function GET() {
  const { count, error } = await (supabaseAdmin as any)
    .from("edition_offers")
    .select("external_id", { count: "exact", head: true })
    .eq("collection_id", COLLECTION_ID)
    .not("low_ask_serial", "is", null)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({
    ok: true,
    note: "POST with Bearer INGEST_SECRET_TOKEN to run the floor-serial sweep",
    editionsWithFloorSerial: count,
  })
}
