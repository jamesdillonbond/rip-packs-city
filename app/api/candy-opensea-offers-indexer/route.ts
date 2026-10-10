// app/api/candy-opensea-offers-indexer/route.ts
//
// Candy (Solana) standing OFFERS (bids) placed on OPENSEA — the second bid feed
// beside /api/ingest/candy-offers (Magic Eden). Writes `candy_offers` rows with
// venue='opensea'. Plumbing and spec provenance: lib/chains/solana/opensea.ts.
//
// Source: GET /api/v2/offers/collection/{slug}/all (spec `Offer`: svm_order,
// asset, criteria, price {currency, decimals, value}, status, protocol_address).
//
//   · candy_offers is MINT-grain (token_mint NOT NULL). A collection or trait
//     offer has no single mint, so it is counted (`collection_offers`), never
//     written — inventing a mint for it would be a fabricated row.
//   · DEDUP: OpenSea aggregates other marketplaces' bids. An offer whose
//     order_state equals a Magic Eden pda_address is the same on-chain bid and
//     is skipped (`matched_me_pda`). Unlike a listing, a bid does not escrow the
//     card, so a bidder CAN hold one bid per venue; any residual duplicate cannot
//     move the readers' signal (best offer = max, distinct_bidders = distinct).
//   · RETIREMENT is evidence-only, exactly as on the listings feed: an unseen
//     venue='opensea' row is retired only on a terminal get-order status.
//
// HONESTY CONSTRAINT (shared with the Magic Eden route): a bid is a BEST-OFFER
// signal, never FMV.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { solUsd } from "@/lib/chains/solana/das"
import { CANDY_MLB_SLUG, CANDY_MLB_UUID } from "@/lib/chains/solana/normalize"
import {
  OS_PAGE_LIMIT,
  OS_TERMINAL_STATUSES,
  discoverCandyOpenSeaSlug,
  fetchOrderStatus,
  openSeaApiKey,
  orderMint,
  osGet,
  osPrice,
  type OsOrder,
  type OsPrice,
} from "@/lib/chains/solana/opensea"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "candy-opensea-offers-indexer"
const MAX_PAGES = 50
const SWEEP_BUDGET_MS = 240_000
const MAX_STATUS_CHECKS = 150

type OsOffer = OsOrder & { price?: OsPrice }

async function logRun(
  startedAtIso: string,
  rowsFound: number,
  rowsWritten: number,
  rowsSkipped: number,
  ok: boolean,
  error: string | null,
  extra: Record<string, unknown>,
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
    console.log(`[${PIPELINE_NAME}] log_pipeline_run failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`)
  }
}

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

  await writeInvocationHeartbeat({
    pipeline: PIPELINE_NAME,
    startedAtMs: startedMs,
    collectionSlug: CANDY_MLB_SLUG,
  })

  const apiKey = openSeaApiKey()
  if (!apiKey) {
    console.error(`[${PIPELINE_NAME}] OPENSEA_API_KEY is not set — no OpenSea Candy offers can be read`)
    await logRun(startedAtIso, 0, 0, 0, false, "OPENSEA_API_KEY not set (misconfiguration, not an OpenSea outage)", {
      skip_reason: "opensea_key_missing",
    })
    return NextResponse.json(
      { accepted: false, skipped: "opensea_key_missing", collection: CANDY_MLB_SLUG },
      { status: 202 },
    )
  }

  after(async () => {
    let found = 0
    let written = 0
    let skipped = 0
    let retired = 0
    let pages = 0
    let sweepComplete = false
    let budgetExhausted = false
    let slug: string | null = null
    const writeErrors: string[] = []
    try {
      const d = await discoverCandyOpenSeaSlug(supabaseAdmin, apiKey)
      slug = d.slug
      if (!slug) {
        await logRun(startedAtIso, 0, 0, 0, false, `OpenSea collection slug not found (${d.how})`, {
          skip_reason: "slug_not_found",
          slug_discovery: d.how,
        })
        return
      }
      const rate = await solUsd()

      // ── 1. Walk the OpenSea bid book ──────────────────────────────────────
      let rawSeen = 0
      let notActive = 0
      let collectionOffers = 0
      let noIdentity = 0
      const protocols: Record<string, number> = {}
      const reported: Array<{ o: OsOffer; mint: string; state: string }> = []
      let next: string | null = null
      for (; pages < MAX_PAGES; pages++) {
        if (Date.now() - startedMs > SWEEP_BUDGET_MS) {
          budgetExhausted = true
          break
        }
        const qs = `limit=${OS_PAGE_LIMIT}${next ? `&next=${encodeURIComponent(next)}` : ""}`
        const { json } = await osGet(`/offers/collection/${encodeURIComponent(slug)}/all?${qs}`, apiKey)
        const offers = (json?.offers ?? []) as OsOffer[]
        rawSeen += offers.length
        for (const o of offers) {
          const key = o.protocol ?? "(none)"
          protocols[key] = (protocols[key] ?? 0) + 1
          if ((o.status && o.status !== "ACTIVE") || (o.remaining_quantity != null && o.remaining_quantity <= 0)) {
            notActive++
            continue
          }
          const mint = orderMint(o)
          if (!mint) {
            collectionOffers++
            continue
          }
          const state = o.svm_order?.order_state
          if (!state) {
            noIdentity++
            continue
          }
          reported.push({ o, mint, state })
        }
        next = json?.next ?? null
        if (!next) {
          sweepComplete = true
          pages++
          break
        }
      }

      // ── 2. Resolve mints → Candy editions ─────────────────────────────────
      const mints = [...new Set(reported.map((r) => r.mint))]
      const keyByMint = new Map<string, string>()
      for (let i = 0; i < mints.length; i += 200) {
        const { data, error } = await (supabaseAdmin as any)
          .from("wallet_moments_cache")
          .select("moment_id, edition_key")
          .eq("collection_id", CANDY_MLB_UUID)
          .in("moment_id", mints.slice(i, i + 200))
        if (error) throw new Error(`wmc batch lookup failed: ${error.message}`)
        for (const r of (data ?? []) as Array<{ moment_id: string; edition_key: string | null }>) {
          if (r.edition_key && !keyByMint.has(r.moment_id)) keyByMint.set(r.moment_id, r.edition_key)
        }
      }
      const keys = [...new Set(keyByMint.values())]
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

      // ── 3. Same on-chain bid already held from Magic Eden? ────────────────
      const states = [...new Set(reported.map((r) => r.state))]
      const mePdas = new Set<string>()
      for (let i = 0; i < states.length; i += 200) {
        const { data, error } = await (supabaseAdmin as any)
          .from("candy_offers")
          .select("pda_address")
          .eq("venue", "magic_eden")
          .in("pda_address", states.slice(i, i + 200))
        if (error) throw new Error(`ME pda read failed: ${error.message}`)
        for (const r of (data ?? []) as Array<{ pda_address: string }>) mePdas.add(r.pda_address)
      }

      // ── 4. Rows ───────────────────────────────────────────────────────────
      let notCandy = 0
      let matchedMePda = 0
      let unpriced = 0
      const rows: Record<string, unknown>[] = []
      const seen = new Set<string>()
      const nowIso = new Date().toISOString()
      for (const { o, mint, state } of reported) {
        const key = keyByMint.get(mint)
        if (!key) {
          notCandy++
          continue
        }
        if (mePdas.has(state)) {
          matchedMePda++
          continue
        }
        if (seen.has(state)) continue
        const price = osPrice(o.price, rate)
        if (!price) {
          unpriced++
          continue
        }
        seen.add(state)
        found++
        rows.push({
          pda_address: state,
          token_mint: mint,
          edition_id: idByKey.get(key) ?? null,
          collection_id: CANDY_MLB_UUID,
          buyer: o.svm_order?.maker ?? null,
          auction_house: o.protocol_address ?? null,
          price_sol: price.sol,
          price_usd: price.usd,
          token_size: 1,
          expiry: null,
          last_seen_at: nowIso,
          is_active: true,
          venue: "opensea",
          venue_order_id: o.svm_order?.id ?? null,
        })
      }
      skipped = notCandy + matchedMePda + unpriced

      for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100)
        const { error } = await (supabaseAdmin as any)
          .from("candy_offers")
          .upsert(batch, { onConflict: "pda_address" })
        if (error) {
          writeErrors.push(`candy_offers upsert: ${error.message}`)
          skipped += batch.length
        } else written += batch.length
      }

      // ── 5. Evidence-based retirement of unseen OpenSea bids ───────────────
      let statusChecked = 0
      let statusUnknown = 0
      let statusTerminal = 0
      let retireCandidates: number | null = null
      const { data: stale, error: staleErr } = await (supabaseAdmin as any)
        .from("candy_offers")
        .select("pda_address, venue_order_id, auction_house")
        .eq("venue", "opensea")
        .eq("is_active", true)
        .lt("last_seen_at", startedAtIso)
        // Oldest-first; `status_unknown` is the watch for rows that never resolve.
        .order("last_seen_at", { ascending: true })
        .order("pda_address", { ascending: true })
        .limit(MAX_STATUS_CHECKS)
      if (staleErr) {
        writeErrors.push(`stale opensea read: ${staleErr.message}`)
      } else {
        retireCandidates = (stale ?? []).length
        const dead: string[] = []
        for (const r of (stale ?? []) as Array<{ pda_address: string; venue_order_id: string | null; auction_house: string | null }>) {
          if (Date.now() - startedMs > SWEEP_BUDGET_MS) break
          if (!r.venue_order_id || !r.auction_house) {
            statusUnknown++
            continue
          }
          const status = await fetchOrderStatus(r.auction_house, r.venue_order_id, apiKey)
          if (status == null) {
            statusUnknown++
            continue
          }
          statusChecked++
          if (OS_TERMINAL_STATUSES.has(status)) dead.push(r.pda_address)
        }
        statusTerminal = dead.length
        for (let i = 0; i < dead.length; i += 200) {
          const { data: gone, error: goneErr } = await (supabaseAdmin as any)
            .from("candy_offers")
            .update({ is_active: false })
            .eq("venue", "opensea")
            .eq("is_active", true)
            .in("pda_address", dead.slice(i, i + 200))
            .lt("last_seen_at", startedAtIso)
            .select("pda_address")
          if (goneErr) writeErrors.push(`candy_offers retire: ${goneErr.message}`)
          else retired += (gone ?? []).length
        }
      }

      await logRun(
        startedAtIso,
        found,
        written,
        skipped,
        writeErrors.length === 0,
        writeErrors.length ? `${writeErrors.length} rejected write(s): ${writeErrors.slice(0, 3).join(" | ")}`.slice(0, 500) : null,
        {
          slug,
          slug_discovery: d.how,
          raw_offers_seen: rawSeen,
          offers_found: found,
          offers_upserted: written,
          not_active: notActive,
          collection_offers: collectionOffers,
          no_identity: noIdentity,
          not_candy_card: notCandy,
          matched_me_pda: matchedMePda,
          unpriced,
          protocols,
          retire_candidates: retireCandidates,
          status_checked: statusChecked,
          status_unknown: statusUnknown,
          status_terminal: statusTerminal,
          retired,
          write_errors: writeErrors.length,
          sweep_complete: sweepComplete,
          budget_exhausted: budgetExhausted,
          pages_walked: pages,
          sol_usd: rate,
          duration_ms: Date.now() - startedMs,
        },
      )
    } catch (e) {
      await logRun(startedAtIso, found, written, skipped, false, e instanceof Error ? e.message : String(e), {
        slug,
        offers_found: found,
        offers_upserted: written,
        retired,
        sweep_complete: sweepComplete,
        pages_walked: pages,
        duration_ms: Date.now() - startedMs,
      })
    }
  })

  return NextResponse.json({ accepted: true, collection: CANDY_MLB_SLUG, started_at: startedAtIso }, { status: 202 })
}
