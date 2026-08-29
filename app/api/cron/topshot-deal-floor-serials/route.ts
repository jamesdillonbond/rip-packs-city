import { NextRequest, NextResponse, after } from "next/server"
import { topshotGraphql } from "@/lib/chains/flow/topshot"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"

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
// fetches the cheapest active listings via searchMintedMoments(sortBy:PRICE_USD_ASC)
// and writes the target PRINTING's floor (serial + nft_id + price) into
// edition_offers. Price and serial therefore come from the SAME listing (the
// handoff's hard consistency rule), and low_ask is overwritten from that listing
// so the displayed ask always equals the displayed serial's price.
//
// Parallel-aware (2026-07-07): searchMintedMoments.byEditions is parallel-BLIND
// (it returns listings across every printing of the set:play), but MintedMoment
// exposes parallelID (0 = Standard; verified live from the v2 origin). So we
// fetch ONE price-sorted page per set:play and pick each target edition's floor
// as the first listing whose parallelID matches its printing (base pair -> 0,
// "setID:playID::subID" -> subID). One page serves the base row AND every ::
// sibling on the deal board (cached per pair within the run). If a printing's
// floor doesn't appear within the page (PAGE_LIMIT cheapest listings), we skip
// it rather than write a cross-printing floor — never fabricate.
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
const MAX_RETRIES = 2
// Per-run work cap + incremental flush + soft budget keep a run well under the
// 300s maxDuration. Coverage lands in ~2-3 hourly runs; a capped run finishes in
// ~60-90s, and flushing during the loop means a (now very unlikely) kill loses at
// most the last FLUSH_EVERY rows, never the whole batch. SOFT_BUDGET_MS stops the
// fetch loop with ~30s of headroom so the final flush + log_pipeline_run always run.
const MAX_PER_RUN = 250
const FLUSH_EVERY = 100
const SOFT_BUDGET_MS = 270_000

const FLOOR_QUERY = `
  query FloorListing($filters: MintedMomentFilterInput!, $s: BaseSearchInput!) {
    searchMintedMoments(input: { filters: $filters searchInput: $s sortBy: PRICE_USD_ASC }) {
      data {
        searchSummary {
          data {
            data {
              ... on MintedMoment { flowId flowSerialNumber price parallelID }
            }
          }
        }
      }
    }
  }
`

// Cheapest-listings page size per set:play. Must be deep enough that a parallel's
// floor isn't hidden below a wall of cheaper Standard listings (typical listed
// counts per play are well under this).
const PAGE_LIMIT = 100

type FloorMoment = { flowId: string | null; flowSerialNumber: string | null; price: string | null; parallelID?: number | null }
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
  updated_at: string | null
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

async function fetchFloorListings(setUuid: string, playUuid: string): Promise<FloorMoment[]> {
  const data = await topshotGraphql<FloorGql>(FLOOR_QUERY, {
    filters: { byEditions: [{ setID: setUuid, playID: playUuid }], byPrice: { min: 1 } },
    s: { pagination: { direction: "RIGHT", limit: PAGE_LIMIT, cursor: "" } },
  })
  return data?.searchMintedMoments?.data?.searchSummary?.data?.data ?? []
}

// Bounded exponential backoff (~400/800/1600ms + jitter) on 429/5xx/network.
// Re-throws the last error once retries are exhausted or the error isn't transient.
async function fetchFloorWithRetry(setUuid: string, playUuid: string): Promise<FloorMoment[]> {
  let attempt = 0
  for (;;) {
    try {
      return await fetchFloorListings(setUuid, playUuid)
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
    let dealEditionsTotal = 0
    let listingsFound = 0
    let upserted = 0
    let skippedNoListing = 0
    let gqlErrors = 0
    let firstGqlError: string | null = null
    let throttledGiveUps = 0
    let budgetHit = false

    try {
      // 1. The deal set = TS editions currently on the deal board. Read via a
      //    SECDEF RPC (90s statement_timeout) instead of an inline select: the
      //    inline query gets the service_role 30s default and was chronically
      //    dying in the 21:00-01:00 UTC peak-contention window ("deal board read:
      //    canceling statement due to statement timeout"). The RPC's proconfig
      //    timeout DOES apply on the rpc() path, so it survives the spike; it
      //    returns text[] (not subject to PostgREST's 1000-row cap).
      const { data: dealIds, error: dealErr } = await (supabaseAdmin as any)
        .rpc("get_topshot_deal_external_ids")
      if (dealErr) throw new Error(`deal board read: ${dealErr.message}`)
      const dealExtIds = Array.from(new Set(((dealIds ?? []) as string[])))

      // 2. Resolve their UUIDs from edition_offers (persisted by offers-sweep).
      const targets: DealEdition[] = []
      for (let i = 0; i < dealExtIds.length; i += IN_CHUNK) {
        const chunk = dealExtIds.slice(i, i + IN_CHUNK)
        const { data, error } = await (supabaseAdmin as any)
          .from("edition_offers")
          .select("external_id, set_uuid, play_uuid, low_ask_serial, updated_at")
          .eq("collection_id", COLLECTION_ID)
          .in("external_id", chunk)
          .not("set_uuid", "is", null)
          .not("play_uuid", "is", null)
        if (error) throw new Error(`edition_offers read: ${error.message}`)
        for (const r of (data as DealEdition[] | null) ?? []) targets.push(r)
      }
      dealEditionsTotal = targets.length

      // Prioritize first-coverage editions (no serial yet), then the oldest-
      // refreshed, and cap the work set so a run never approaches maxDuration.
      // The full deal set rotates through over a few hourly runs.
      targets.sort((a, b) => {
        const an = a.low_ask_serial == null ? 0 : 1
        const bn = b.low_ask_serial == null ? 0 : 1
        if (an !== bn) return an - bn
        return (a.updated_at ?? "").localeCompare(b.updated_at ?? "")
      })
      const workSet = targets.slice(0, MAX_PER_RUN)
      editionsTargeted = workSet.length

      // 3. Fetch each edition's floor listing (bounded concurrency), flushing
      //    incrementally so a kill loses at most the last partial batch.
      const nowIso = new Date().toISOString()
      const pending: Array<Record<string, unknown>> = []
      async function flush(drain = false) {
        while (pending.length >= FLUSH_EVERY || (drain && pending.length > 0)) {
          const batch = pending.splice(0, FLUSH_EVERY)
          const { error } = await (supabaseAdmin as any)
            .from("edition_offers")
            .upsert(batch, { onConflict: "collection_id,external_id" })
          if (error) {
            console.log(`[${PIPELINE_NAME}] flush upsert error:`, error.message)
          } else {
            upserted += batch.length
          }
        }
      }
      // One listings page per set:play serves the base row and every :: sibling
      // in the same run (the sweep persists the SAME base set/play UUIDs on ::
      // rows). null = fetch failed (don't treat as "no listings").
      const pageByPair = new Map<string, FloorMoment[] | null>()
      let cursor = 0
      async function worker() {
        while (cursor < workSet.length) {
          if (Date.now() - startTime > SOFT_BUDGET_MS) { budgetHit = true; break }
          const t = workSet[cursor++]
          // Small jitter desyncs the two workers so they don't hit the proxy in lockstep.
          await sleep(50 + Math.floor(Math.random() * 100))
          try {
            const pairKey = `${t.set_uuid}:${t.play_uuid}`
            let page = pageByPair.get(pairKey)
            if (page === undefined) {
              page = await fetchFloorWithRetry(t.set_uuid, t.play_uuid)
              pageByPair.set(pairKey, page)
            }
            // The printing this edition_offers row represents: base pair -> 0,
            // "setID:playID::subID" -> subID.
            const targetParallel = t.external_id.includes("::")
              ? Number(t.external_id.split("::")[1])
              : 0
            const floor = (page ?? []).find((m) => (m.parallelID ?? 0) === targetParallel) ?? null
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
            pending.push({
              collection_id: COLLECTION_ID,
              external_id: t.external_id,
              low_ask: price,
              low_ask_serial: serial,
              low_ask_nft_id: nftId,
              updated_at: nowIso,
            })
            await flush()
          } catch (err) {
            gqlErrors++
            if (firstGqlError === null) {
              firstGqlError = (err instanceof Error ? err.message : String(err)).slice(0, 160)
            }
            if (is429(err)) throttledGiveUps++
            console.log(`[${PIPELINE_NAME}] floor fetch ${t.external_id} err:`, err instanceof Error ? err.message : String(err))
          }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
      await flush(true) // drain the remainder
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
        // 🚨 EVERY EDITION FAILING IS NOT A SUCCESS (2026-08-29).
        // `fetchError` is set only by a FATAL error in the outer try, so
        // per-edition GQL failures never reached `ok`. Measured that day: 21
        // consecutive hourly runs logged `gql_errors: 10` of
        // `deal_editions_total: 10`, `listings_found: 0`, `rows_written: 0` —
        // every one green, while `public-api.nbatopshot.com` had been answering
        // 530/1033 for 22 hours. Worse, the aggregate ("23 runs, 22 ok") is what
        // an operator reads, so this pipeline actively argued the endpoint was
        // healthy while resolving nothing.
        //
        // ⚠ THE PREDICATE IS "WE TRIED, FAULTED, AND RESOLVED NOTHING".
        // ⛔ NOT `gqlErrors === editionsTargeted`, which is the obvious form and is
        // WRONG HERE: one price-sorted page is fetched per (set_uuid, play_uuid)
        // and serves the base edition AND all its `::` parallel siblings, so the
        // two counters have different denominators — a single failed fetch can
        // wipe out several editions and `gqlErrors` never reaches
        // `editionsTargeted`. Caught by the two-edition test below, which shares
        // one set:play and produced gql_errors 1 against editionsTargeted 2.
        //
        // `listingsFound === 0` is the outcome-based test and needs no denominator
        // at all: nothing was priced. Pairing it with `gqlErrors > 0` is what keeps
        // the honest-degradation case green — a board whose editions genuinely have
        // no live listing resolves nothing WITHOUT faulting, and must stay ok.
        // `editionsTargeted > 0` keeps an empty deal board green: nothing attempted
        // is not a failure.
        p_ok:
          fetchError === null &&
          !(editionsTargeted > 0 && listingsFound === 0 && gqlErrors > 0),
        p_error:
          fetchError ??
          (editionsTargeted > 0 && listingsFound === 0 && gqlErrors > 0
            ? `resolved 0 of ${editionsTargeted} deal editions; ${gqlErrors} fetch errors; first: ${firstGqlError ?? "unknown"}`.slice(0, 500)
            : null),
        p_collection_slug: "nba_top_shot",
        p_extra: {
          deal_editions_total: dealEditionsTotal,
          listings_found: listingsFound,
          gql_errors: gqlErrors,
          first_gql_error: firstGqlError,
          throttled_giveups: throttledGiveUps,
          budget_hit: budgetHit,
          duration_ms: Date.now() - startTime,
        },
      })
    } catch (err) {
      console.warn(`[${PIPELINE_NAME}] log_pipeline_run failed (non-fatal):`, err)
    }
  })

  return NextResponse.json({ ok: true, accepted: true, pipeline: PIPELINE_NAME }, { status: 202 })
}

// ⚠ ANON-REACHABLE — see the note on offers-sweep's GET. Same shape, same
// prefix exclusion, same leak.
export async function GET() {
  const { count, error } = await (supabaseAdmin as any)
    .from("edition_offers")
    .select("external_id", { count: "exact", head: true })
    .eq("collection_id", COLLECTION_ID)
    .not("low_ask_serial", "is", null)
  if (error) return apiErrorResponse(error, "api/cron/topshot-deal-floor-serials")
  return NextResponse.json({
    ok: true,
    note: "POST with Bearer INGEST_SECRET_TOKEN to run the floor-serial sweep",
    editionsWithFloorSerial: count,
  })
}
