// app/api/candy-sales-indexer/route.ts
//
// Item 4 — Candy (Solana) secondary-sales indexer. Polls Magic Eden's
// collection `activities` feed (newest-first), resolves each sale's mint to an
// RPC edition via DAS, and writes a `sales` row in USD.
//
// INERT until discovery: short-circuits to a clean no-op until
// CANDY_MLB_ME_SYMBOL is filled (Item 0). Do NOT wire a cron / watchlist until
// the symbol is set and one manual run has verified counts.
//
// Incremental cursor: ME activities are newest-first, so we stop once we cross
// the most-recent already-recorded Candy sale (`sold_at`). The unique tx-hash
// index on sales_2026 is the dedup backstop (23505 swallowed).

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getAsset, solUsd } from "@/lib/chains/solana/das"
import {
  CANDY_MLB_ME_SYMBOL,
  CANDY_MLB_SLUG,
  CANDY_MLB_UUID,
  candyMeSymbolReady,
  editionKeyFromAsset,
  normalizeSerial,
} from "@/lib/chains/solana/normalize"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "candy-sales-indexer"
const ME_BASE = "https://api-mainnet.magiceden.dev/v2"
const ME_LIMIT = 500
const MAX_PAGES = 40
// Bound DAS getAsset() calls per tick (edition + serial resolution) so a large
// backlog can't blow the lambda budget — unresolved sales are retried next tick.
const ASSET_FETCH_BUDGET = 400

interface MeActivity {
  signature: string
  type: string
  tokenMint?: string
  buyer?: string | null
  seller?: string | null
  price?: number // SOL
  blockTime?: number // unix seconds
  source?: string
}

// Sale activity types ME emits for a completed purchase. "list" is a listing,
// not a sale — excluded.
const SALE_TYPES = new Set(["buyNow", "buyNowFill", "acceptBid"])

async function fetchActivities(offset: number): Promise<MeActivity[]> {
  const headers: Record<string, string> = { Accept: "application/json" }
  const key = process.env.MAGIC_EDEN_API_KEY
  if (key) headers["Authorization"] = `Bearer ${key}`
  const url = `${ME_BASE}/collections/${encodeURIComponent(CANDY_MLB_ME_SYMBOL)}/activities?offset=${offset}&limit=${ME_LIMIT}`
  const resp = await fetch(url, { headers })
  if (!resp.ok) {
    throw new Error(`ME activities HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`)
  }
  const json = await resp.json()
  return Array.isArray(json) ? (json as MeActivity[]) : []
}

async function logRun(
  startedAtIso: string,
  rowsFound: number,
  rowsWritten: number,
  rowsSkipped: number,
  ok: boolean,
  error: string | null,
  cursorBefore: string | null,
  cursorAfter: string | null,
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
      p_cursor_before: cursorBefore,
      p_cursor_after: cursorAfter,
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

  if (!candyMeSymbolReady()) {
    await logRun(startedAtIso, 0, 0, 0, true, null, null, null, {
      skip_reason: "discovery_pending",
      note: "CANDY_MLB_ME_SYMBOL is a TODO placeholder",
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
    let assetFetches = 0
    let cursorAfter: string | null = null
    try {
      // Incremental high-water mark: the most recent Candy sale we already have.
      const { data: latest } = await (supabaseAdmin as any)
        .from("sales")
        .select("sold_at")
        .eq("collection_id", CANDY_MLB_UUID)
        .order("sold_at", { ascending: false })
        .limit(1)
      const cursorBeforeMs: number = latest?.[0]?.sold_at
        ? new Date(latest[0].sold_at).getTime()
        : 0
      const cursorBefore = cursorBeforeMs ? new Date(cursorBeforeMs).toISOString() : null

      const rate = await solUsd()
      // edition_key → editions.id cache (so repeat keys cost one query).
      const edIdByKey = new Map<string, string | null>()

      let reachedKnown = false
      for (let page = 0; page < MAX_PAGES && !reachedKnown; page++) {
        const acts = await fetchActivities(page * ME_LIMIT)
        if (acts.length === 0) break

        const salesRows: Record<string, unknown>[] = []
        for (const a of acts) {
          const tMs = (a.blockTime ?? 0) * 1000
          // Stop once we cross into already-recorded territory (with the page
          // still processed up to the boundary; DB dedup covers any overlap).
          if (cursorBeforeMs && tMs <= cursorBeforeMs) {
            reachedKnown = true
            continue
          }
          if (!SALE_TYPES.has(a.type) || !a.tokenMint || !a.signature) continue
          found++
          if (tMs > (cursorAfter ? new Date(cursorAfter).getTime() : 0)) {
            cursorAfter = new Date(tMs).toISOString()
          }

          if (rate == null || a.price == null || a.price <= 0) {
            skipped++
            continue
          }
          if (assetFetches >= ASSET_FETCH_BUDGET) {
            skipped++
            continue
          }

          // Resolve mint → edition via DAS.
          let asset
          try {
            asset = await getAsset(a.tokenMint)
            assetFetches++
          } catch {
            skipped++
            continue
          }
          const key = editionKeyFromAsset(asset)
          const serial = normalizeSerial(asset).serial_number
          if (!key || serial == null) {
            skipped++
            continue
          }

          let editionId = edIdByKey.get(key)
          if (editionId === undefined) {
            const { data: edRow } = await (supabaseAdmin as any)
              .from("editions")
              .select("id")
              .eq("external_id", key)
              .eq("collection_id", CANDY_MLB_UUID)
              .limit(1)
            editionId = edRow?.[0]?.id ?? null
            edIdByKey.set(key, editionId ?? null)
          }
          if (!editionId) {
            // Edition not ingested yet — skip; the editions ingest fills it,
            // then this sale resolves on a later tick.
            skipped++
            continue
          }

          salesRows.push({
            id: crypto.randomUUID(),
            edition_id: editionId,
            collection_id: CANDY_MLB_UUID,
            collection: CANDY_MLB_SLUG,
            nft_id: a.tokenMint,
            serial_number: serial,
            price_usd: Number((a.price * rate).toFixed(2)),
            price_native: a.price,
            currency: "SOL",
            marketplace: "magic_eden",
            source: "solana_das",
            transaction_hash: a.signature,
            sold_at: new Date(tMs).toISOString(),
            buyer_address: a.buyer ?? null,
            seller_address: a.seller ?? null,
            ingested_at: new Date().toISOString(),
          })
        }

        for (let i = 0; i < salesRows.length; i += 100) {
          const batch = salesRows.slice(i, i + 100)
          const { error } = await (supabaseAdmin as any).from("sales").insert(batch)
          if (error) {
            if (error.code === "23505") {
              // dupes — already recorded
            } else {
              console.log(`[${PIPELINE_NAME}] sales insert err: ${error.message}`)
              for (const row of batch) {
                const { error: se } = await (supabaseAdmin as any).from("sales").insert(row)
                if (!se) written++
              }
            }
          } else {
            written += batch.length
          }
        }

        if (acts.length < ME_LIMIT) break
      }

      await logRun(startedAtIso, found, written, skipped, true, null, cursorBefore, cursorAfter, {
        sales_found: found,
        sales_written: written,
        skipped,
        asset_fetches: assetFetches,
        sol_usd: rate,
        duration_ms: Date.now() - startedMs,
      })
    } catch (e) {
      await logRun(startedAtIso, found, written, skipped, false, e instanceof Error ? e.message : String(e), null, cursorAfter, {
        sales_found: found,
        sales_written: written,
        skipped,
      })
    }
  })

  return NextResponse.json(
    { accepted: true, collection: CANDY_MLB_SLUG, started_at: startedAtIso },
    { status: 202 }
  )
}
