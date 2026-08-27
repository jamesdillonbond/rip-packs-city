// app/api/candy-listings-indexer/route.ts
//
// Item A — Candy (Solana) secondary LISTINGS (asks) indexer. Candy had a sales
// feed (candy-sales-indexer) and a bid feed (candy-offers-indexer) but NO ask
// feed — which blocked the entire deals / offer-spread / sniper / floor family
// (every listing table in the DB is Flow/Pinnacle). This lands the ask side.
//
// Sweep is simpler than the offers indexer (no per-wallet fan-out): the ME
// collection listings endpoint returns every active ask directly.
//   1. Page /v2/collections/<symbol>/listings (CURRENT active listings).
//   2. Resolve each tokenMint → Candy edition via wmc (moment_id = mint pubkey;
//      edition_key === editions.external_id by invariant). Non-Candy mints skip.
//   3. Upsert on pdaAddress; then deactivate active rows the sweep did not see —
//      ONLY on a complete sweep (any page-fetch failure aborts deactivation, so a
//      transient error can never wrongly mark a still-standing ask dead), plus
//      rows whose expiry has passed.
//
// While the quest-hold rule keeps Magic Eden listings at 0, every tick is a
// clean no-op that writes nothing — and captures the first real ask the moment
// it prints, exactly like candy-sales-indexer.
//
// HONESTY CONSTRAINT (do not relax): a listing is an ASK, never FMV. It must not
// be folded into fmv_snapshots. candy_listing_floor is a floor-ask signal only.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { solUsd } from "@/lib/chains/solana/das"
import {
  CANDY_MLB_ME_SYMBOL,
  CANDY_MLB_SLUG,
  CANDY_MLB_UUID,
  candyMeSymbolReady,
} from "@/lib/chains/solana/normalize"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "candy-listings-indexer"
const ME_BASE = "https://api-mainnet.magiceden.dev/v2"
// ME's /v2/collections/<symbol>/listings endpoint caps `limit` low: limit=500
// returns HTTP 400 (verified live 2026-07-24 — every prior tick failed here), 100
// is the accepted max. MAX_PAGES × ME_LIMIT (10,000) bounds the sweep well above
// any realistic active book so a short/empty page always ends it (and lets the
// deactivation pass run) rather than truncating at MAX_PAGES.
const ME_LIMIT = 100
const MAX_PAGES = 100
// Sweep-sanity guard: if a complete-looking sweep returns less than this
// fraction of the book we already hold, treat the feed as degraded and refuse
// to deactivate. Only applied once the book is big enough for the ratio to mean
// anything.
// How many pages of the activities feed to read for listing-ending evidence.
// 2 x 500 comfortably covers a 3h tick (the busiest observed window ran ~90
// activities in 2.3h) with headroom for a backlog.
const ACTIVITY_PAGES = 2

// Listing as returned by /v2/collections/<symbol>/listings. `expiry` is unix
// seconds (0 = none).
interface MeListing {
  pdaAddress?: string
  tokenMint?: string
  auctionHouse?: string
  seller?: string
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

// The ACTIVITIES feed is the reliable half of Magic Eden's API for this
// collection: it returns 500 rows a page and its recency ordering matches the
// chain (candy-sales-indexer has walked it every 3h without a gap). The
// LISTINGS endpoint is not — it answered 420, then 7, then 22 for the same book
// inside six hours on 2026-07-27. So listings are treated as a PRICE REFRESHER
// and the activities feed as the STATE MACHINE for what is still listed.
interface MeActivity {
  type: string
  tokenMint?: string
  blockTime?: number
}

// Per-request cap on every Magic Eden call. `fetch()` HAS NO DEFAULT TIMEOUT, so
// an upstream that accepts the connection and then holds it open consumes the
// caller's ENTIRE lambda budget — and this route's budget is 300s.
//
// 🚨 That is not hypothetical here; it is the measured cause of a 44-hour
// blackout on the PUBLIC /insights/candy-mlb board (2026-08-27). The signature:
// 15 invocation heartbeats in 48h, ONE terminal `pipeline_runs` row, and a
// Vercel `Task timed out after 300 seconds`. The route's `after()` body has a
// try/catch that logs an ok:false row, so a THROW would have been recorded —
// nothing was, which means the tick was KILLED rather than failing. The only
// unbounded awaits in the path were the two ME fetches below.
//
// ⭐ The fix already existed in this codebase and had not spread. `solUsd()` in
// lib/chains/solana/das.ts — called by this very route, one line above the ME
// walk — carries an 8s cap and a comment naming this exact failure mode
// ("CoinGecko rate-limits datacenter egress hard and can hold a connection open
// indefinitely"). The same reasoning applies to Magic Eden and was never
// applied. When you find one of these, grep for the EXPRESSION, not the file.
//
// ⚠ Egress-dependent, so do not "disprove" it from a laptop. Probed residentially
// on 2026-08-27 ME answered 200 in 0.1–1.0s with a shallow book (0 rows by
// offset 2000), i.e. from a home IP there is nothing slow to find. The sibling
// candy-offers route is simultaneously getting Cloudflare 1015 rate-limits from
// Vercel. A hang that only appears on datacenter egress is exactly that shape.
const ME_FETCH_TIMEOUT_MS = 15_000

// Whole-sweep deadline, and it is a SEPARATE guarantee from the per-request cap
// above — not a belt-and-braces duplicate. ME_FETCH_TIMEOUT_MS bounds ONE call;
// MAX_PAGES is 100, so per-request caps alone still permit 100 x 15s = 1,500s,
// five times the 300s `maxDuration`. Without a total budget the route could
// still be killed before reaching `logRun`, which is the whole defect: a killed
// tick writes NO terminal row, so the failure is invisible to `pipeline_runs`
// and reads as "the cron never fired".
//
// 🚨 THE VALUE IS 600s, NOT THE 240s YOU WOULD DERIVE FROM `maxDuration = 300`,
// AND THE DIFFERENCE IS MEASURED. Every SUCCESSFUL run of this sweep in the
// retained `pipeline_runs` window took **375,699 / 389,236 / 391,226 ms** — all
// well ABOVE the 300s maxDuration — and all three completed AND wrote their
// terminal row. `extra.duration_ms` is computed as `Date.now() - startedMs`,
// the SAME clock this budget uses, so those numbers are directly comparable:
// **a 240s budget would have truncated every healthy sweep on record.** That
// was the first value here and it was a regression, caught only by reading the
// duration distribution instead of reasoning from the declared ceiling.
//
// ⭐ The lesson: `maxDuration` is what the platform DECLARES; the success band
// is what the route actually gets. They disagree here (Fluid Compute does not
// bill or bound `after()` work the way a naive reading of maxDuration implies),
// so a deadline derived from the declared ceiling is derived from the wrong
// number. **Size a budget off the observed distribution of successes, never off
// the config.**
//
// 600s therefore sits ~1.5x above the observed max: it NEVER truncates a healthy
// sweep, while still capping the aggregate worst case, which per-request timeouts
// alone cannot (MAX_PAGES 100 x 15s = 1,500s). The per-call
// ME_FETCH_TIMEOUT_MS above is the real hang protection; this is the backstop
// for many-slow-calls rather than one-stuck-call.
//
// ⚠ SEPARATE, LARGER PROBLEM this budget does NOT solve, stated so nobody reads
// the timeout work as a fix for it: a ~385s sweep against a 300s maxDuration is
// OVER BUDGET BY DESIGN, which is why terminal rows are rare and most ticks die.
// The cost is dominated by per-listing round trips (~1,600 listings x 1-2
// sequential supabase lookups each); the DB side of each is an Index Only Scan
// at ~1.4ms, so it is ROUND-TRIP COUNT, not query cost. Batching those lookups
// is the real fix. Filed, not attempted here.
//
// A deadline break refreshes fewer prices and reports `sweep_complete: false`;
// it cannot destroy data, because deactivation here is evidence-based (an
// explicit delist or fill from the activities feed), never absence-based, and
// `sweepComplete` gates nothing but reporting.
const SWEEP_BUDGET_MS = 600_000

async function fetchActivities(offset: number): Promise<MeActivity[]> {
  const url = `${ME_BASE}/collections/${encodeURIComponent(CANDY_MLB_ME_SYMBOL)}/activities?offset=${offset}&limit=500`
  const resp = await fetch(url, { headers: meHeaders(), signal: AbortSignal.timeout(ME_FETCH_TIMEOUT_MS) })
  if (!resp.ok) {
    throw new Error(`ME activities HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`)
  }
  const json = await resp.json()
  return Array.isArray(json) ? (json as MeActivity[]) : []
}

// Activity types that END a listing: an explicit delist, or a fill.
const LISTING_ENDING_TYPES = new Set(["delist", "buyNow", "buyNowFill", "acceptBid"])

async function fetchListings(offset: number): Promise<MeListing[]> {
  const url = `${ME_BASE}/collections/${encodeURIComponent(CANDY_MLB_ME_SYMBOL)}/listings?offset=${offset}&limit=${ME_LIMIT}`
  const resp = await fetch(url, { headers: meHeaders(), signal: AbortSignal.timeout(ME_FETCH_TIMEOUT_MS) })
  if (!resp.ok) {
    throw new Error(`ME listings HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`)
  }
  const json = await resp.json()
  return Array.isArray(json) ? (json as MeListing[]) : []
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

// INGEST_SECRET_TOKEN (manual / cron-job.org) OR Bearer CRON_SECRET (Vercel cron
// sends only CRON_SECRET, via GET). Mirrors app/api/ingest/candy-offers.
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

  // Invocation heartbeat (deep-audit R11, added 2026-08-15). The real work runs
  // inside `after()` and logs ONLY on completion, so a dropped or killed
  // invocation wrote nothing at all — indistinguishable from the cron never
  // firing. That ambiguity was not theoretical: on 2026-08-15 this pipeline read
  // 1,151 min silent against a 400 min ceiling while `candy_listings.last_seen_at`
  // showed a sweep HAD run at 06:40Z, and the two facts could not be reconciled
  // from any available signal. ⚠ It also produced a wrong operator note — "it
  // runs and writes but does not log", which invites dismissing the alarm —
  // whereas re-measured the data was ALSO 10 h stale, i.e. later ticks did no
  // work either. Both readings needed the same missing evidence.
  //
  // With this marker the states separate, exactly as for candy-offers-indexer:
  //   heartbeat + candy-listings-indexer row -> ran to completion
  //   heartbeat only                          -> after() dropped / killed at 300s
  //   neither                                 -> route never reached (cron / auth)
  //
  // ⚠ SEPARATE pipeline name, not an extra `candy-listings-indexer` row — this
  // pipeline is on pipeline_cadence_watchlist (400 min), so a marker under its
  // own name would refresh `last_run` every tick and silence
  // detect_stalled_pipelines() on the very outage this exists to expose.
  // ⚠ `duration_ms` on these heartbeat rows is MEANINGLESS — read `extra`/`ok`,
  // never the duration. `log_pipeline_run` has no `p_finished_at` parameter
  // (verified against pg_proc: 11 args, no finished_at), so the row takes
  // `finished_at DEFAULT now()` and the GENERATED `duration_ms` becomes this
  // insert's own latency. That is the same defect fixed today on
  // drain-conflated-subeditions and fmv-recalc-heartbeat by pinning
  // finished_at = started_at; it cannot be pinned through this RPC without a
  // migration, and the sibling candy-offers-indexer heartbeat has the identical
  // property. Filed rather than diverging from the established call here.
  // 2026-08-20: moved to `lib/pipeline/heartbeat.ts`. This site used the
  // `log_pipeline_run` RPC, which has NO `p_finished_at` parameter — so
  // `finished_at` took its `now()` default and `duration_ms` (GENERATED from the
  // pair) published this call's own latency as a run duration: measured live at
  // up to 47,462 ms across these three candy markers. The site documented the
  // trap ("read `extra`/`ok`, never the duration") rather than fixing it,
  // because from inside the RPC it was unfixable. The helper writes the table
  // directly, so the duration is a hard 0 and the rows_* columns are NULL rather
  // than a fabricated 0.
  //
  // ⚠ `phase` was `"invoked"` here and `"started"` at the other two sites — a
  // divergence nobody could see from inside either file, and one that would
  // silently exclude these rows from any correlation query keyed on the phase.
  await writeInvocationHeartbeat({
    pipeline: PIPELINE_NAME,
    startedAtMs: startedMs,
    collectionSlug: CANDY_MLB_SLUG,
  })

  if (!candyMeSymbolReady()) {
    await logRun(startedAtIso, 0, 0, 0, true, null, { skip_reason: "discovery_pending" })
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
    let packWritten = 0
    let packDeactivated = 0
    let sweepComplete = false
    try {
      const rate = await solUsd()
      // tokenMint → edition_id|null (Candy card) or false (not a Candy card)
      // miss cache. A miss is re-checked against candy_packs: the collection
      // mixes sealed PACKS in with the cards, and a pack ask used to be dropped
      // here as "not a Candy mint" because the wmc gate only knows card mints.
      const editionByMint = new Map<string, string | null | false>()
      const packMintCache = new Map<string, boolean>()
      const rows: Record<string, unknown>[] = []
      const packRows: Record<string, unknown>[] = []
      const seenPdas = new Set<string>()
      const seenPackPdas = new Set<string>()

      // Raw ME rows seen before the Candy-mint gate. `found` counts only Candy
      // listings, so it cannot distinguish "ME returned an empty book" from "ME
      // returned rows, none of them Candy" — and an empty book while we hold
      // active asks is an upstream fault, not a market event.
      let rawSeen = 0

      let page = 0
      let budgetExhausted = false
      for (; page < MAX_PAGES; page++) {
        // Stop before the lambda is killed, so logRun below always runs.
        if (Date.now() - startedMs > SWEEP_BUDGET_MS) {
          budgetExhausted = true
          sweepComplete = false
          break
        }
        const listings = await fetchListings(page * ME_LIMIT)
        rawSeen += listings.length
        if (listings.length === 0) {
          sweepComplete = true
          break
        }
        // ── Batch-resolve this page's unseen mints BEFORE the per-listing loop ──
        //
        // 🚨 WHY. This sweep's cost is ROUND-TRIP COUNT, not query cost. The
        // per-mint lookups below are individually cheap — the wmc probe is an
        // Index Only Scan on idx_wmc_moment_collection_cover at ~1.4ms / 3
        // buffers — but issued ONE AT A TIME they are ~1,600 sequential
        // Vercel→Supabase round trips per sweep. Measured: every successful run
        // on record took 375–391s against a 300s maxDuration, i.e. the sweep was
        // OVER BUDGET BY DESIGN and only finished when the platform allowed the
        // overrun. That is why terminal rows were rare and the PUBLIC
        // /insights/candy-mlb board went 44h stale.
        //
        // ⚠ Do NOT "optimise" this by making the queries cheaper — they are
        // already index-only. The lever is the number of trips, not the cost of
        // each. (I falsified "the query is slow" early on and briefly took that
        // to mean the lookups were not the cost; those are different claims.)
        //
        // Equivalence: identical rows, identical mapping. Each cache ends the
        // page holding exactly what the sequential version would have put there
        // — `false` for a mint with no wmc row (not a Candy card), the edition id
        // or null otherwise — so the loop below is unchanged in behaviour.
        {
          const pageMints = [
            ...new Set(
              listings
                .filter((l) => l.pdaAddress && l.tokenMint && l.price != null && l.price > 0)
                .map((l) => l.tokenMint as string)
                .filter((m) => !editionByMint.has(m)),
            ),
          ]
          if (pageMints.length) {
            // 1) mint → edition_key. A mint can carry rows for several wallets;
            //    edition_key is a property of the MOMENT, so first-wins matches
            //    the .limit(1) this replaces.
            const keyByMint = new Map<string, string>()
            for (let i = 0; i < pageMints.length; i += 200) {
              const { data, error } = await (supabaseAdmin as any)
                .from("wallet_moments_cache")
                .select("moment_id, edition_key")
                .eq("collection_id", CANDY_MLB_UUID)
                .in("moment_id", pageMints.slice(i, i + 200))
              // ⚠ THROW, do not swallow. The sequential version destructured only
              // `data`, so a failed read left `key` undefined and the listing was
              // silently classified "not a Candy mint" and DROPPED — a failed
              // read rendering as a fact, on the feed behind a public board.
              // Failing the sweep is safe: deactivation is evidence-based, so a
              // thrown sweep deactivates nothing.
              if (error) throw new Error(`wmc batch lookup failed: ${error.message}`)
              for (const r of (data ?? []) as Array<{ moment_id: string; edition_key: string | null }>) {
                if (r.edition_key && !keyByMint.has(r.moment_id)) keyByMint.set(r.moment_id, r.edition_key)
              }
            }

            // 2) edition_key → edition id, one trip per chunk of keys.
            const keys = [...new Set([...keyByMint.values()])]
            const idByKey = new Map<string, string>()
            for (let i = 0; i < keys.length; i += 200) {
              const { data, error } = await (supabaseAdmin as any)
                .from("editions")
                .select("id, external_id")
                .eq("collection_id", CANDY_MLB_UUID)
                .in("external_id", keys.slice(i, i + 200))
              if (error) throw new Error(`editions batch lookup failed: ${error.message}`)
              for (const r of (data ?? []) as Array<{ id: string; external_id: string }>) {
                if (!idByKey.has(r.external_id)) idByKey.set(r.external_id, r.id)
              }
            }

            for (const m of pageMints) {
              const key = keyByMint.get(m)
              editionByMint.set(m, key ? (idByKey.get(key) ?? null) : false)
            }

            // 3) The non-card mints may still be sealed PACKS. Same batching.
            const notCards = pageMints.filter((m) => editionByMint.get(m) === false && !packMintCache.has(m))
            for (let i = 0; i < notCards.length; i += 200) {
              const chunk = notCards.slice(i, i + 200)
              const { data, error } = await (supabaseAdmin as any)
                .from("candy_packs")
                .select("token_mint")
                .in("token_mint", chunk)
              if (error) throw new Error(`candy_packs batch lookup failed: ${error.message}`)
              const present = new Set((data ?? []).map((r: { token_mint: string }) => r.token_mint))
              for (const m of chunk) packMintCache.set(m, present.has(m))
            }
          }
        }

        for (const l of listings) {
          if (!l.pdaAddress || !l.tokenMint || l.price == null || l.price <= 0) continue

          // Candy-mint gate + edition resolution via wmc.
          let edition = editionByMint.get(l.tokenMint)
          if (edition === undefined) {
            const { data: wmcRow } = await (supabaseAdmin as any)
              .from("wallet_moments_cache")
              .select("edition_key")
              .eq("collection_id", CANDY_MLB_UUID)
              .eq("moment_id", l.tokenMint)
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
            editionByMint.set(l.tokenMint, edition)
          }
          if (edition === false) {
            // Not a card — is it a sealed pack? candy_packs is filled by the
            // daily DAS walk, so this costs one indexed lookup per new mint and
            // no extra Magic Eden call.
            let isPackMint = packMintCache.get(l.tokenMint)
            if (isPackMint === undefined) {
              const { data: packRow } = await (supabaseAdmin as any)
                .from("candy_packs")
                .select("token_mint")
                .eq("token_mint", l.tokenMint)
                .limit(1)
              isPackMint = Boolean(packRow?.[0]?.token_mint)
              packMintCache.set(l.tokenMint, isPackMint)
            }
            if (!isPackMint) continue // genuinely not a Candy asset
            if (seenPackPdas.has(l.pdaAddress)) continue
            seenPackPdas.add(l.pdaAddress)
            packRows.push({
              pda_address: l.pdaAddress,
              token_mint: l.tokenMint,
              collection_id: CANDY_MLB_UUID,
              seller: l.seller ?? null,
              auction_house: l.auctionHouse ?? null,
              price_sol: l.price,
              price_usd: rate != null ? Number((l.price * rate).toFixed(2)) : null,
              expiry: l.expiry && l.expiry > 0 ? new Date(l.expiry * 1000).toISOString() : null,
              last_seen_at: new Date().toISOString(),
              is_active: true,
            })
            continue
          }
          if (seenPdas.has(l.pdaAddress)) continue
          seenPdas.add(l.pdaAddress)
          found++

          rows.push({
            pda_address: l.pdaAddress,
            token_mint: l.tokenMint,
            edition_id: edition,
            collection_id: CANDY_MLB_UUID,
            seller: l.seller ?? null,
            auction_house: l.auctionHouse ?? null,
            price_sol: l.price,
            price_usd: rate != null ? Number((l.price * rate).toFixed(2)) : null,
            token_size: l.tokenSize ?? null,
            expiry: l.expiry && l.expiry > 0 ? new Date(l.expiry * 1000).toISOString() : null,
            last_seen_at: new Date().toISOString(),
            is_active: true,
            // first_seen_at defaulted on insert, preserved on conflict.
          })
        }
        if (listings.length < ME_LIMIT) {
          sweepComplete = true
          break
        }
      }
      // Reaching MAX_PAGES without a short/empty page means we truncated — treat
      // the sweep as incomplete so deactivation is skipped (never deactivate on a
      // partial view of the book).
      if (page >= MAX_PAGES) sweepComplete = false

      // Upsert pack asks (same all-or-nothing batching rules as the cards).
      for (let i = 0; i < packRows.length; i += 100) {
        const batch = packRows.slice(i, i + 100)
        const { error } = await (supabaseAdmin as any)
          .from("candy_pack_listings")
          .upsert(batch, { onConflict: "pda_address" })
        if (error) console.log(`[${PIPELINE_NAME}] pack upsert err: ${error.message}`)
        else packWritten += batch.length
      }

      // Upsert active listings.
      for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100)
        const { error } = await (supabaseAdmin as any)
          .from("candy_listings")
          .upsert(batch, { onConflict: "pda_address" })
        if (error) {
          console.log(`[${PIPELINE_NAME}] upsert err: ${error.message}`)
          skipped += batch.length
        } else {
          written += batch.length
        }
      }

      // Deactivation is EVIDENCE-BASED, never absence-based.
      //
      // The old rule — "any active row this sweep did not see is dead" — is only
      // sound if the sweep is a census. It is not: on 2026-07-27 Magic Eden
      // answered 420 listings at 21:38Z, SEVEN at 00:35Z and 22 at 03:35Z for a
      // book the chain says barely moved (6 delists and 8 sales across the whole
      // collection in that window). The 00:35Z tick therefore deactivated 419
      // standing asks and collapsed candy_listing_floor to 7 rows. A ratio guard
      // was tried first and is NOT enough either — once a bad tick lands, the
      // "book we already hold" it compares against is itself the damaged number.
      //
      // So: only a listing we have POSITIVE evidence about gets deactivated —
      // an explicit `delist`, or a fill (`buyNow`/`buyNowFill`/`acceptBid`) —
      // read from the activities feed, plus expiry. A pulled ask we miss stays
      // live one tick longer; a live ask is never destroyed by a short answer.
      const endedMints = new Set<string>()
      let activitiesSeen = 0
      try {
        for (let ap = 0; ap < ACTIVITY_PAGES; ap++) {
          // Same deadline. No evidence is safer than a killed tick: an empty
          // endedMints set simply deactivates nothing this pass.
          if (Date.now() - startedMs > SWEEP_BUDGET_MS) break
          const acts = await fetchActivities(ap * 500)
          activitiesSeen += acts.length
          for (const a of acts) {
            if (a.tokenMint && LISTING_ENDING_TYPES.has(a.type)) endedMints.add(a.tokenMint)
          }
          if (acts.length < 500) break
        }
      } catch (e) {
        // A failed activities walk means no evidence, which means no
        // deactivation — never the other way round.
        console.log(`[${PIPELINE_NAME}] activities walk failed (no deactivation): ${e instanceof Error ? e.message : String(e)}`)
      }

      const { count: activeBefore } = await (supabaseAdmin as any)
        .from("candy_listings")
        .select("pda_address", { count: "exact", head: true })
        .eq("is_active", true)
      const before = activeBefore ?? 0

      const endedList = [...endedMints]
      for (let i = 0; i < endedList.length; i += 200) {
        const slice = endedList.slice(i, i + 200)
        const { data: gone } = await (supabaseAdmin as any)
          .from("candy_listings")
          .update({ is_active: false })
          .eq("is_active", true)
          .in("token_mint", slice)
          .lt("last_seen_at", startedAtIso)
          .select("pda_address")
        deactivated += (gone ?? []).length
        const { data: packGone } = await (supabaseAdmin as any)
          .from("candy_pack_listings")
          .update({ is_active: false })
          .eq("is_active", true)
          .in("token_mint", slice)
          .lt("last_seen_at", startedAtIso)
          .select("pda_address")
        packDeactivated += (packGone ?? []).length
      }

      // Expired listings are dead regardless of what the feed said.
      const nowIso = new Date().toISOString()
      const { data: expired } = await (supabaseAdmin as any)
        .from("candy_listings")
        .update({ is_active: false })
        .eq("is_active", true)
        .lt("expiry", nowIso)
        .select("pda_address")
      deactivated += (expired ?? []).length

      // A short listings answer is no longer dangerous — it just refreshes
      // fewer prices — so it is reported as a metric, not a failure.
      const feedLooksTruncated = before >= 20 && rawSeen < before * 0.5

      await logRun(startedAtIso, found, written, skipped, true, null, {
        listings_found: found,
        listings_upserted: written,
        raw_listings_seen: rawSeen,
        active_before: before,
        feed_looks_truncated: feedLooksTruncated,
        activities_seen: activitiesSeen,
        listing_ending_mints: endedMints.size,
        pack_asks_upserted: packWritten,
        pack_asks_deactivated: packDeactivated,
        skipped,
        deactivated,
        sweep_complete: sweepComplete,
        // Distinguishes "the book ended" from "we ran out of time". Without it a
        // budget-truncated sweep and a genuinely short book both read as
        // sweep_complete:false, which is the same empty-vs-unavailable
        // conflation this repo fixes everywhere else.
        budget_exhausted: budgetExhausted,
        pages_walked: page,
        me_key_present: Boolean(process.env.MAGIC_EDEN_API_KEY),
        sol_usd: rate,
        duration_ms: Date.now() - startedMs,
      })
    } catch (e) {
      await logRun(startedAtIso, found, written, skipped, false, e instanceof Error ? e.message : String(e), {
        listings_found: found,
        listings_upserted: written,
        deactivated,
        sweep_complete: sweepComplete,
      })
    }
  })

  return NextResponse.json(
    { accepted: true, collection: CANDY_MLB_SLUG, started_at: startedAtIso },
    { status: 202 }
  )
}
