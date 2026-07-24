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
const ME_LIMIT = 500
const MAX_PAGES = 40

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

async function fetchListings(offset: number): Promise<MeListing[]> {
  const url = `${ME_BASE}/collections/${encodeURIComponent(CANDY_MLB_ME_SYMBOL)}/listings?offset=${offset}&limit=${ME_LIMIT}`
  const resp = await fetch(url, { headers: meHeaders() })
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
    let sweepComplete = false
    try {
      const rate = await solUsd()
      // tokenMint → edition_id|null (Candy) or false (not a Candy mint) miss cache.
      const editionByMint = new Map<string, string | null | false>()
      const rows: Record<string, unknown>[] = []
      const seenPdas = new Set<string>()

      let page = 0
      for (; page < MAX_PAGES; page++) {
        const listings = await fetchListings(page * ME_LIMIT)
        if (listings.length === 0) {
          sweepComplete = true
          break
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
          if (edition === false) continue // non-Candy listing
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

      // Deactivate listings the sweep did not see — ONLY on a complete sweep.
      const nowIso = new Date().toISOString()
      if (sweepComplete) {
        const { data: gone } = await (supabaseAdmin as any)
          .from("candy_listings")
          .update({ is_active: false })
          .eq("is_active", true)
          .lt("last_seen_at", startedAtIso)
          .select("pda_address")
        deactivated += (gone ?? []).length
      }
      // Expired listings are dead regardless of sweep completeness.
      const { data: expired } = await (supabaseAdmin as any)
        .from("candy_listings")
        .update({ is_active: false })
        .eq("is_active", true)
        .lt("expiry", nowIso)
        .select("pda_address")
      deactivated += (expired ?? []).length

      await logRun(startedAtIso, found, written, skipped, true, null, {
        listings_found: found,
        listings_upserted: written,
        skipped,
        deactivated,
        sweep_complete: sweepComplete,
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
