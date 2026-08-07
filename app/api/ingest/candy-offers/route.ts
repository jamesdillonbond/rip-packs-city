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
// RAISED 300 -> 800 on 2026-08-07 (Pro lambda hard cap; >800 sends the deploy to
// ERROR silently). This is NOT the reflexive "raise the wall" fix that was
// deliberately rejected earlier the same day — it is a response to a MEASURED
// per-bidder cost. The 18:22Z run swept 9 of 70 bidders in the full 210s budget
// with bidder_fetch_errors 0: ~23s per bidder, every request succeeding. Magic
// Eden answers Vercel egress ~265x slower than the 87ms it serves a residential
// probe, i.e. it tarpits datacenter IPs rather than erroring them.
//
// At that cost a complete sweep is unreachable inside 300s at ANY concurrency
// that stays polite, and a permanently-partial sweep is not merely slow — it is
// WRONG: step 6 (correctly) refuses to deactivate on a partial sweep, so
// `is_active` on the PUBLIC candy_offer_spread_board would never be reconciled
// again. Budget + bounded concurrency together make a complete sweep reachable
// (~70 bidders x 23s / 4 ≈ 400s), which is what lets deactivation run at all.
export const maxDuration = 800

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
// Sweep-sanity guard, mirroring candy-listings-indexer: a sweep that returns
// less than this fraction of the standing book we already hold is treated as
// degraded and is not allowed to deactivate. Only applied once the book is big
// enough for the ratio to mean anything.
const MIN_SWEEP_RATIO = 0.5
const SWEEP_GUARD_MIN_BOOK = 20
// Per-ME-request timeout. WITHOUT THIS a single hung upstream request consumes
// the entire lambda budget: fetch() has no default timeout, so one socket that
// never answers is indistinguishable from 300s of useful work. Magic Eden is
// demonstrably flaky from Vercel egress — the 2026-08-05 00:50Z run logged
// bidder_fetch_errors 19/74, and the sibling candy-listings-indexer has caught
// Cloudflare 520s from the same host — so this is the common case, not a tail
// risk. 15s is ~170x the 87ms a healthy offers_made answer takes.
const ME_REQUEST_TIMEOUT_MS = 15_000
// Wall-clock budget for discovery + the bidder walk, leaving headroom under
// maxDuration for the upsert / deactivation / logging tail.
//
// CANDY-OFFERS-DEADLINE (2026-08-07): this route died at the 300s wall on every
// tick from 2026-08-05 00:50Z (Vercel: "Task timed out after 300 seconds" at
// 00:50:33 / 06:50:33 / 12:50:33 on 08-07), leaving candy_offers 64h stale with
// 39 rows still flagged is_active behind the PUBLIC candy_offer_spread_board.
// Being killed mid-flight is the worst outcome available: after() never runs,
// so NOTHING is logged and the pipeline reads as silent rather than failing.
// An explicit deadline converts that into a bounded, honest, partial run.
const SWEEP_DEADLINE_MS = 700_000
// Bidders swept concurrently. Magic Eden tarpits Vercel egress (~23s/bidder,
// measured, with ZERO errors — slow, not rejecting), so the sweep is
// latency-bound, not rate-bound, and a small amount of overlap converts
// directly into coverage. Deliberately gentle: if ME is in fact rate-limiting
// as well, the extra pressure surfaces as `bidder_fetch_errors > 0`, which
// already suppresses deactivation — so the failure mode is a visibly degraded
// run, never a wrongly-emptied book.
const BIDDER_CONCURRENCY = 4
// Last-resort watchdog, well under maxDuration (300s).
//
// ⚠ A DEADLINE CHECKED INSIDE LOOPS IS NOT ENOUGH, and this was proven in prod
// on 2026-08-07: the first deadline fix still got "Task timed out after 300
// seconds" because a deadline can only fire at a point where the code actually
// looks at it. Anything that blocks on a single un-timed-out await — a hung
// CoinGecko call in solUsd(), a Supabase read stuck behind pooler saturation —
// sails straight past every loop check, and the lambda is then killed with
// after() never reaching logRun. That is the WORST outcome: the pipeline reads
// as SILENT rather than failing, which is precisely the bug this whole change
// set exists to eliminate.
//
// A timer, unlike a loop check, fires on the event loop while an await is still
// pending. So the watchdog can always write a row, whatever is stuck. It also
// reports `phase`, which turns "it hung somewhere" into a measured answer on the
// very next tick instead of another round of guessing.
const WATCHDOG_MS = 760_000

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
  const resp = await fetch(`${ME_BASE}${path}`, {
    headers: meHeaders(),
    signal: AbortSignal.timeout(ME_REQUEST_TIMEOUT_MS),
  })
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
      // Terminal: this path returns without scheduling after(), so it is a
      // complete run, not a pending one.
      phase: "complete",
      skip_reason: "discovery_pending",
    })
    return NextResponse.json(
      { accepted: false, skipped: "discovery_pending", collection: CANDY_MLB_SLUG },
      { status: 202 }
    )
  }

  // CANDY-OFFERS-INVOKED (2026-08-07): synchronous invocation marker, written
  // BEFORE after() is scheduled. On the happy path this route logged ONLY from
  // inside after(), so a dropped/frozen deferred body — or a lambda killed at
  // the 300s maxDuration — left NO row at all, making three very different
  // states indistinguishable. That is not hypothetical: this pipeline went
  // fully dark after 2026-08-05 00:50Z and the cause could not be determined
  // from any available signal (Vercel runtime logs are incomplete for cron
  // paths — a known-good sibling that ran 4x the same day also logged no line
  // at its tick, so log-absence proves nothing).
  //
  // With this marker the states separate:
  //   heartbeat + candy-offers-indexer row -> ran to completion
  //   heartbeat only                        -> after() dropped / killed at 300s
  //   neither                               -> route never reached (cron / auth)
  //
  // ⚠ The marker is written under a SEPARATE pipeline name, NOT as an extra
  // `candy-offers-indexer` row. That is load-bearing, not cosmetic: this
  // pipeline is on pipeline_cadence_watchlist (max_silent_minutes 800), so a
  // marker written under its own name would refresh `last_run` every tick and
  // make detect_stalled_pipelines() go quiet even while the real work never
  // completed — masking exactly the outage this exists to expose. Under a
  // distinct name the stall detector still fires on the real pipeline while
  // the heartbeat tells us how far the invocation got. Mirrors the existing
  // `fmv-recalc-heartbeat` precedent. Logged ok:true so it cannot inflate
  // v_pipeline_failure_rates.
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
    // Non-fatal: the heartbeat is diagnostic. Never let it break the sweep.
    console.log(
      `[${PIPELINE_NAME}] heartbeat log failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`
    )
  }

  after(async () => {
    let found = 0
    let written = 0
    let skipped = 0
    let deactivated = 0
    let bidderFetchErrors = 0
    let packOffersSeen = 0
    let biddersSwept = 0
    let deadlineHit = false
    const sweepStartedMs = Date.now()
    const outOfTime = () => Date.now() - sweepStartedMs > SWEEP_DEADLINE_MS

    // Phase marker: what the sweep is blocked on if the watchdog has to fire.
    let phase = "discovery_activities"
    // Exactly one run row, whoever gets there first (watchdog or normal exit).
    let reported = false
    const reportOnce = async (
      ok: boolean,
      error: string | null,
      extra: Record<string, unknown>
    ) => {
      if (reported) return
      reported = true
      await logRun(startedAtIso, found, written, skipped, ok, error, extra)
    }

    const watchdog = setTimeout(() => {
      void reportOnce(
        false,
        `sweep hung in phase "${phase}" past the ${WATCHDOG_MS / 1000}s watchdog — the lambda is about to be killed at maxDuration; reporting the partial run so this cannot read as SILENT`,
        {
          phase: "watchdog",
          hung_phase: phase,
          bidders_swept: biddersSwept,
          bidder_fetch_errors: bidderFetchErrors,
          deadline_hit: deadlineHit,
        }
      )
    }, WATCHDOG_MS)

    try {
      // 1. Bidder discovery from recent bid activity.
      const bidders = new Set<string>()
      const floorMs = Date.now() - ACTIVITY_LOOKBACK_DAYS * 86400000
      for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
        if (outOfTime()) {
          deadlineHit = true
          break
        }
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
      //
      //    Paged with .range(): a bare .select() is silently CLAMPED at 1000 by
      //    PostgREST, and a clamp here would drop standing offers out of the
      //    sweep set — which step 5 would then read as "not seen" the moment a
      //    sweep otherwise looked complete. The book is ~175 rows today; this
      //    keeps it correct as it grows.
      //
      //    last_seen_at rides along to drive the rotation order below.
      phase = "discovery_active_buyers"
      const lastSeenByBidder = new Map<string, string>()
      for (let from = 0; from < 10_000; from += 1000) {
        const { data: activeBuyers } = await (supabaseAdmin as any)
          .from("candy_offers")
          .select("buyer, last_seen_at")
          .eq("is_active", true)
          .range(from, from + 999)
        for (const row of activeBuyers ?? []) {
          if (!row?.buyer) continue
          bidders.add(row.buyer)
          const prev = lastSeenByBidder.get(row.buyer)
          // Keep the FRESHEST verification per bidder: a bidder is only
          // "overdue" if none of their standing offers was re-seen recently.
          if (row.last_seen_at && (!prev || row.last_seen_at > prev)) {
            lastSeenByBidder.set(row.buyer, row.last_seen_at)
          }
        }
        if ((activeBuyers ?? []).length < 1000) break
      }

      // 3. Rotation order: least-recently-verified first.
      //
      //    Load-bearing, not cosmetic. Once the deadline can cut the walk short,
      //    a fixed order would re-sweep the SAME prefix every tick and the tail
      //    would never be verified again — and because a short sweep suppresses
      //    deactivation (step 5), is_active would drift stale forever. Ordering
      //    by staleness makes successive partial ticks cover the whole book.
      //    Bidders with no stored offer (newly discovered from activities) sort
      //    first: they have never been verified at all. Address is the
      //    tie-break so the order is deterministic.
      const allBidders = [...bidders].sort((a, b) => {
        const la = lastSeenByBidder.get(a) ?? ""
        const lb = lastSeenByBidder.get(b) ?? ""
        return la === lb ? (a < b ? -1 : a > b ? 1 : 0) : la < lb ? -1 : 1
      })
      const biddersTruncated = allBidders.length > MAX_BIDDERS
      const sweepBidders = allBidders.slice(0, MAX_BIDDERS)

      // 4. Standing offers per bidder, filtered to Candy mints.
      phase = "sol_usd"
      const rate = await solUsd()
      phase = "bidder_sweep"
      // tokenMint → edition_id|null (Candy) or undefined-sentinel miss cache.
      const editionByMint = new Map<string, string | null | false>()
      const packMintCache = new Map<string, boolean>()
      const rows: Record<string, unknown>[] = []
      const seenPdas = new Set<string>()

      // Bounded worker pool over the ROTATED bidder list. Workers pull from a
      // shared cursor, so the least-recently-verified bidders are still started
      // first and a deadline cut still leaves the freshest ones for next tick.
      // JS is single-threaded, so the shared caches/arrays below need no locking
      // — the only cost of overlap is that two workers can both miss the same
      // mint cache and issue a duplicate lookup, which is harmless.
      let nextBidder = 0
      const sweepOne = async (bidder: string) => {
        try {
          for (let page = 0; page < MAX_OFFER_PAGES_PER_BIDDER; page++) {
            // Also check INSIDE the page loop: one whale bidder can page up to
            // MAX_OFFER_PAGES_PER_BIDDER times, and at the 15s per-request cap
            // that alone is 300s — enough to blow the whole budget between two
            // consecutive checks of the outer per-bidder guard.
            if (outOfTime()) {
              deadlineHit = true
              break
            }
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
              if (edition === false) {
                // Not a Candy CARD. It may still be a bid on a sealed PACK —
                // packs are mixed into the same ME collection and were
                // invisible to every Candy pipeline until 2026-07-27. We do not
                // yet store pack bids (that needs its own table); INSTRUMENT
                // first so the decision to build one is made on a measured
                // number rather than a guess. Cheap: one indexed lookup per
                // distinct mint, no extra Magic Eden call.
                let isPackMint = packMintCache.get(o.tokenMint)
                if (isPackMint === undefined) {
                  const { data: packRow } = await (supabaseAdmin as any)
                    .from("candy_packs")
                    .select("token_mint")
                    .eq("token_mint", o.tokenMint)
                    .limit(1)
                  isPackMint = Boolean(packRow?.[0]?.token_mint)
                  packMintCache.set(o.tokenMint, isPackMint)
                }
                if (isPackMint) packOffersSeen++
                continue
              }
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

      await Promise.all(
        Array.from({ length: Math.min(BIDDER_CONCURRENCY, sweepBidders.length) }, async () => {
          for (;;) {
            // Stop cleanly rather than being killed mid-walk: everything
            // collected so far is still upserted and logged below, and the run
            // is reported as the partial sweep it is.
            if (outOfTime()) {
              deadlineHit = true
              return
            }
            const i = nextBidder++
            if (i >= sweepBidders.length) return
            biddersSwept++
            await sweepOne(sweepBidders[i])
          }
        })
      )

      // 5. Upsert standing offers.
      phase = "upsert"
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

      // 6. Deactivate offers the sweep did not see — ONLY on a complete sweep
      //    (any per-bidder failure, bidder truncation, or a deadline cut could
      //    make an absence a fetch artifact, not a cancelled offer).
      //
      //    Plus the ratio guard the listings sweep learned the hard way on
      //    2026-07-27: Magic Eden served 7 listings against a 426-ask book and
      //    the card sweep deactivated 419 standing asks in one tick. The same
      //    shape is reachable here — every bidder fetch "succeeding" with a
      //    short answer — so a sweep that returns far less than the book we
      //    already hold does not get to kill it.
      phase = "deactivate"
      const { count: activeOffersBefore } = await (supabaseAdmin as any)
        .from("candy_offers")
        .select("pda_address", { count: "exact", head: true })
        .eq("is_active", true)
      const offersBefore = activeOffersBefore ?? 0
      const degradedSweep =
        offersBefore >= SWEEP_GUARD_MIN_BOOK && found < offersBefore * MIN_SWEEP_RATIO

      const nowIso = new Date().toISOString()
      if (bidderFetchErrors === 0 && !biddersTruncated && !degradedSweep && !deadlineHit) {
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
        : deadlineHit
          ? `sweep hit the ${SWEEP_DEADLINE_MS / 1000}s deadline after ${biddersSwept}/${sweepBidders.length} bidders — deactivation skipped, is_active is stale; least-recently-verified bidders are swept first so the tail is covered next tick`
          : degradedSweep
            ? `offer sweep returned ${found} offers against ${offersBefore} active (<${Math.round(MIN_SWEEP_RATIO * 100)}%) — deactivation suppressed, feed looks degraded`
            : null

      await reportOnce(truncErr === null, truncErr, {
        phase: "complete",
        bidders_discovered: allBidders.length,
        // ACTUAL count walked, which is < sweepBidders.length on a deadline
        // cut. Reporting the intended count here would hide the shortfall.
        bidders_swept: biddersSwept,
        bidders_eligible: sweepBidders.length,
        bidders_truncated: biddersTruncated,
        deadline_hit: deadlineHit,
        bidder_fetch_errors: bidderFetchErrors,
        pack_offers_seen: packOffersSeen,
        active_offers_before: offersBefore,
        degraded_sweep: degradedSweep,
        offers_upserted: written,
        deactivated,
        sol_usd: rate,
        duration_ms: Date.now() - startedMs,
      })
    } catch (e) {
      await reportOnce(false, e instanceof Error ? e.message : String(e), {
        phase: "complete",
        failed_at: "uncaught",
        hung_phase: phase,
        bidder_fetch_errors: bidderFetchErrors,
        bidders_swept: biddersSwept,
        deadline_hit: deadlineHit,
        deactivated,
      })
    } finally {
      clearTimeout(watchdog)
    }
  })

  return NextResponse.json(
    { accepted: true, collection: CANDY_MLB_SLUG, started_at: startedAtIso },
    { status: 202 }
  )
}
