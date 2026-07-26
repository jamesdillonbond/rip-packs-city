// app/api/ingest/candy-offers/route.ts
//
// Candy (Solana) standing-offer sweep. While Magic Eden lists 0 Candy items
// under the quest-hold rule, BIDS are the only live market signal — the sales
// indexer deliberately discards them (a bid is not a sale). This route captures
// them into `candy_offers` as an honest BEST-OFFER signal:
//
//   1. Walk /v2/collections/<symbol>/activities for `bid` events → distinct
//      bidder wallets (bidding is currently concentrated in a few sweepers).
//   2. Union with buyers of currently-active stored offers, so a standing offer
//      whose bid event has aged out of the activities window is still re-swept
//      (without this, step 4 would wrongly deactivate it).
//   3. For each bidder, page /v2/wallets/<addr>/offers_made — CURRENT standing
//      state, unlike activities — and keep rows whose tokenMint is a known
//      Candy mint (wallet_moments_cache.moment_id for the candy collection).
//   4. Upsert on pdaAddress; then deactivate active rows the sweep did not see,
//      plus rows whose expiry has passed. Deactivation is SKIPPED whenever any
//      per-bidder fetch failed — a partial sweep must never mark still-standing
//      offers dead.
//
// HONESTY CONSTRAINT (do not relax): this is a "best offer" signal, NEVER FMV.
// It must not be folded into fmv_snapshots. Current bids are lowballs from a
// single sweeping wallet; `candy_best_offers` carries distinct_bidders so any
// surface can suppress or caveat a single-bidder signal.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { solUsd } from "@/lib/chains/solana/das"
import {
  CANDY_MLB_ME_SYMBOL,
  CANDY_MLB_SLUG,
  CANDY_MLB_UUID,
  candyMeSymbolReady,
} from "@/lib/chains/solana/normalize"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "candy-offers-indexer"
const ME_BASE = "https://api-mainnet.magiceden.dev/v2"
const ME_LIMIT = 500
// Bidder discovery: bounded activities walk (newest-first) + a time floor.
const MAX_ACTIVITY_PAGES = 6
const ACTIVITY_LOOKBACK_DAYS = 45
// Bound the per-bidder standing-offer walk so one whale wallet with thousands
// of cross-collection offers can't blow the lambda budget.
const MAX_OFFER_PAGES_PER_BIDDER = 20
// Bound total bidders swept per tick; overflow is LOGGED (no silent caps) and
// picked up next tick via the active-offer-buyer union.
//
// RAISED 40 -> 250 on 2026-07-26. The cap is a lambda-budget guard, but at 40 it
// bound BELOW the real bidder population: `bidders_discovered` crossed it on
// 2026-07-25 06:50Z and reached 60, so EVERY tick after that logged
// `bidders_truncated: true` — and because step 5 (correctly) refuses to
// deactivate on a partial sweep, the deactivation pass had not run for ~42h.
// The failure mode is stale-LIVE offers, not false-dead ones: 6 of 17 "active"
// rows had not been re-verified since 07-25 00:50Z, so `candy_best_offers` /
// `candy_offer_spread_board` could quote a bid that no longer exists. One ME
// call per bidder makes 250 cheap; a truncated tick now also reports ok=false
// so the freeze can never again be invisible.
const MAX_BIDDERS = 250

interface MeActivity {
  signature?: string
  type: string
  buyer?: string | null
  blockTime?: number // unix seconds
}

// Standing offer as returned by /v2/wallets/<addr>/offers_made (same shape as
// /v2/tokens/<mint>/offers_received). `expiry` is unix seconds, 0 = none.
interface MeStandingOffer {
  pdaAddress?: string
  tokenMint?: string
  auctionHouse?: string
  buyer?: string
  price?: number // SOL
  tokenSize?: number
  expiry?: number
}

function meHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" }
  const key = process.env.MAGIC_EDEN_API_KEY
  if (key) headers["Authorization"] = `Bearer ${key}`
  return headers
}

async function meGetArray<T>(path: string): Promise<T[]> {
  const resp = await fetch(`${ME_BASE}${path}`, { headers: meHeaders() })
  if (!resp.ok) {
    throw new Error(`ME ${path.split("?")[0]} HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`)
  }
  const json = await resp.json()
  return Array.isArray(json) ? (json as T[]) : []
}

async function logRun(
  startedAtIso: string,
  rowsFound: number,
  rowsWritten: number,
  rowsSkipped: number,
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
      p_rows_skipped: rowsSkipped,
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

// INGEST_SECRET_TOKEN (manual / cron-job.org) OR Bearer CRON_SECRET (Vercel
// cron sends only CRON_SECRET, via GET). Mirrors app/api/candy-sales-indexer.
function authed(req: NextRequest): boolean {
  const header = req.headers.get("authorization") ?? ""
  const ingest = process.env.INGEST_SECRET_TOKEN
  const cron = process.env.CRON_SECRET
  if (ingest && header === `Bearer ${ingest}`) return true
  if (cron && header === `Bearer ${cron}`) return true
  return false
}

export async function GET(req: NextRequest) {
  return handleSweep(req)
}

export async function POST(req: NextRequest) {
  return handleSweep(req)
}

async function handleSweep(req: NextRequest) {
  if (!authed(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAtIso = new Date().toISOString()
  const startedMs = Date.now()

  if (!candyMeSymbolReady()) {
    await logRun(startedAtIso, 0, 0, 0, true, null, {
      skip_reason: "discovery_pending",
    })
    return NextResponse.json(
      { accepted: false, skipped: "discovery_pending", collection: CANDY_MLB_SLUG },
      { status: 202 }
    )
  }

  after(async () => {
    let found = 0
    let written = 0
    let skipped = 0
    let deactivated = 0
    let bidderFetchErrors = 0
    try {
      // 1. Bidder discovery from recent bid activity.
      const bidders = new Set<string>()
      const floorMs = Date.now() - ACTIVITY_LOOKBACK_DAYS * 86400000
      for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
        const acts = await meGetArray<MeActivity>(
          `/collections/${encodeURIComponent(CANDY_MLB_ME_SYMBOL)}/activities?offset=${page * ME_LIMIT}&limit=${ME_LIMIT}`
        )
        if (acts.length === 0) break
        let pastFloor = false
        for (const a of acts) {
          if ((a.blockTime ?? 0) * 1000 < floorMs) {
            pastFloor = true
            continue
          }
          if (a.type === "bid" && a.buyer) bidders.add(a.buyer)
        }
        if (pastFloor || acts.length < ME_LIMIT) break
      }

      // 2. Union with buyers of active stored offers, so standing offers older
      //    than the activities window are re-verified rather than orphaned.
      const { data: activeBuyers } = await (supabaseAdmin as any)
        .from("candy_offers")
        .select("buyer")
        .eq("is_active", true)
      for (const row of activeBuyers ?? []) {
        if (row?.buyer) bidders.add(row.buyer)
      }

      const allBidders = [...bidders]
      const biddersTruncated = allBidders.length > MAX_BIDDERS
      const sweepBidders = allBidders.slice(0, MAX_BIDDERS)

      // 3. Standing offers per bidder, filtered to Candy mints.
      const rate = await solUsd()
      // tokenMint → edition_id|null (Candy) or undefined-sentinel miss cache.
      const editionByMint = new Map<string, string | null | false>()
      const rows: Record<string, unknown>[] = []
      const seenPdas = new Set<string>()

      for (const bidder of sweepBidders) {
        try {
          for (let page = 0; page < MAX_OFFER_PAGES_PER_BIDDER; page++) {
            const offers = await meGetArray<MeStandingOffer>(
              `/wallets/${encodeURIComponent(bidder)}/offers_made?offset=${page * ME_LIMIT}&limit=${ME_LIMIT}`
            )
            if (offers.length === 0) break
            for (const o of offers) {
              if (!o.pdaAddress || !o.tokenMint || o.price == null || o.price <= 0) continue

              // Candy-mint gate + edition resolution via wmc (moment_id is the
              // mint pubkey; edition_key === editions.external_id by invariant).
              let edition = editionByMint.get(o.tokenMint)
              if (edition === undefined) {
                const { data: wmcRow } = await (supabaseAdmin as any)
                  .from("wallet_moments_cache")
                  .select("edition_key")
                  .eq("collection_id", CANDY_MLB_UUID)
                  .eq("moment_id", o.tokenMint)
                  .limit(1)
                const key = wmcRow?.[0]?.edition_key
                if (!key) {
                  edition = false // not a Candy mint
                } else {
                  const { data: edRow } = await (supabaseAdmin as any)
                    .from("editions")
                    .select("id")
                    .eq("external_id", key)
                    .eq("collection_id", CANDY_MLB_UUID)
                    .limit(1)
                  edition = (edRow?.[0]?.id ?? null) as string | null
                }
                editionByMint.set(o.tokenMint, edition)
              }
              if (edition === false) continue // non-Candy offer from this wallet
              if (seenPdas.has(o.pdaAddress)) continue
              seenPdas.add(o.pdaAddress)
              found++

              rows.push({
                pda_address: o.pdaAddress,
                token_mint: o.tokenMint,
                edition_id: edition,
                collection_id: CANDY_MLB_UUID,
                buyer: o.buyer ?? bidder,
                auction_house: o.auctionHouse ?? null,
                price_sol: o.price,
                price_usd: rate != null ? Number((o.price * rate).toFixed(2)) : null,
                token_size: o.tokenSize ?? null,
                expiry: o.expiry && o.expiry > 0 ? new Date(o.expiry * 1000).toISOString() : null,
                last_seen_at: new Date().toISOString(),
                is_active: true,
                // first_seen_at deliberately omitted: defaulted on insert,
                // preserved on conflict.
              })
            }
            if (offers.length < ME_LIMIT) break
          }
        } catch (e) {
          bidderFetchErrors++
          console.log(
            `[${PIPELINE_NAME}] offers_made fetch failed for ${bidder}: ${e instanceof Error ? e.message : String(e)}`
          )
        }
      }

      // 4. Upsert standing offers.
      for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100)
        const { error } = await (supabaseAdmin as any)
          .from("candy_offers")
          .upsert(batch, { onConflict: "pda_address" })
        if (error) {
          console.log(`[${PIPELINE_NAME}] upsert err: ${error.message}`)
          skipped += batch.length
        } else {
          written += batch.length
        }
      }

      // 5. Deactivate offers the sweep did not see — ONLY on a complete sweep
      //    (any per-bidder failure or bidder truncation could make an absence
      //    a fetch artifact, not a cancelled offer).
      const nowIso = new Date().toISOString()
      if (bidderFetchErrors === 0 && !biddersTruncated) {
        const { data: gone } = await (supabaseAdmin as any)
          .from("candy_offers")
          .update({ is_active: false })
          .eq("is_active", true)
          .lt("last_seen_at", startedAtIso)
          .select("pda_address")
        deactivated += (gone ?? []).length
      }
      // Expired offers are dead regardless of sweep completeness.
      const { data: expired } = await (supabaseAdmin as any)
        .from("candy_offers")
        .update({ is_active: false })
        .eq("is_active", true)
        .lt("expiry", nowIso)
        .select("pda_address")
      deactivated += (expired ?? []).length

      // A truncated sweep is a DEGRADED run, not a clean one: deactivation is
      // skipped above, so `is_active` silently drifts toward stale-live. Report
      // it as a failure so it surfaces in health instead of hiding behind the
      // healthy-looking `offers_upserted` count.
      const truncErr = biddersTruncated
        ? `bidder sweep truncated: ${allBidders.length} discovered > MAX_BIDDERS ${MAX_BIDDERS} — deactivation skipped, is_active is stale`
        : null

      await logRun(startedAtIso, found, written, skipped, !biddersTruncated, truncErr, {
        bidders_discovered: allBidders.length,
        bidders_swept: sweepBidders.length,
        bidders_truncated: biddersTruncated,
        bidder_fetch_errors: bidderFetchErrors,
        offers_upserted: written,
        deactivated,
        sol_usd: rate,
        duration_ms: Date.now() - startedMs,
      })
    } catch (e) {
      await logRun(startedAtIso, found, written, skipped, false, e instanceof Error ? e.message : String(e), {
        bidder_fetch_errors: bidderFetchErrors,
        deactivated,
      })
    }
  })

  return NextResponse.json(
    { accepted: true, collection: CANDY_MLB_SLUG, started_at: startedAtIso },
    { status: 202 }
  )
}
