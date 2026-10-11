import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { extractNftTypeId } from "@/lib/chains/flow/topshot-offer-fill"
import {
  unwrapCdc,
  parseOfferAvailable,
  resolveOfferTargets,
  type AvailOffer,
} from "@/lib/chains/flow/topshot-offer-available"

// ── Backfill: recover the offers row behind every accepted offer that has none ─
//
// Since 2026-10-10 every Top Shot offer_fill sale carries its on-chain offerId
// (sales.offer_id). 21,372 of them name an offer with NO `offers` row: the
// indexer never recorded its OfferAvailable. Those offer ids are snapshotted in
// `topshot_offer_fill_missing_offers` (migration 20261011044422) together with
// what the fill already proves (fill tx, time, buyer, price, sale edition).
//
// This walk reads OfferAvailable ALONE from the mainnet28 root (the oldest block
// rest-mainnet serves) and, for each event whose offerId is in that set, inserts
// the offers row the indexer missed:
//   status 'filled' · created_at = the OfferAvailable block time · resolved_at =
//   the fill sale's time · fill_tx_hash = the fill tx · type, amount and offerer
//   from the event itself · source 'onchain_backfill'.
// Edition: the shared resolver (catalog → moments → wallet cache → checkpoint);
// failing that, the fill sale's own edition + serial (the sale builder resolved
// the exact nft that filled it). Insert-only (ON CONFLICT DO NOTHING), so a
// re-walk is a no-op and an existing row is never touched.
//
// POST /api/admin/backfill-topshot-missing-fill-offers   Bearer $INGEST_SECRET_TOKEN
//   ?start_block=N  (one-time override)   ?range=N (default 200000, cap 300000)
// Driven by .github/workflows/topshot-offers-history-backfill.yml (mode input).
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 300
export const dynamic = "force-dynamic"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const PIPELINE_NAME = "backfill-topshot-missing-fill-offers"
const CURSOR_ID = "topshot_missing_fill_offers_walk"
const TS_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

const OFFER_AVAILABLE = "A.b8ea91944fd51c43.OffersV2.OfferAvailable"
const TOPSHOT_NFT_TYPE_SUFFIX = ".TopShot.NFT"
const FLOW_REST = "https://rest-mainnet.onflow.org"

const CHUNK_SIZE = 250
const PARALLEL_CHUNKS = 6
const DEFAULT_RANGE = 200_000
const RANGE_CAP = 300_000
const BUDGET_MS = 170_000
// mainnet28 root + 1: the oldest height rest-mainnet answers (mainnet27 ended at
// 137,390,145 — docs/reference/apis-and-cadence.md). Offers created before it are
// out of this walk's reach and stay unrecovered (reported, never guessed).
const DEFAULT_START = 137_390_146
// The newest missing fill is before this block; nothing above it needs reading.
const STOP_AT = 167_400_000

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

interface FlowEventBlock {
  block_height: string
  block_timestamp: string
  events?: Array<{ type: string; transaction_id: string; payload: string; event_index: number }>
}

async function fetchEventRange(type: string, start: number, end: number): Promise<FlowEventBlock[]> {
  const url = `${FLOW_REST}/v1/events?type=${encodeURIComponent(type)}&start_height=${start}&end_height=${end}`
  // Retry a 429 only (Flow rate-limits parallel reads); anything else THROWS below.
  let res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  for (let attempt = 1; res.status === 429 && attempt <= 4; attempt++) {
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  }
  // ⚠ THROW, DO NOT `return []` — an HTTP error read as an empty range would let
  // the cursor advance past blocks nothing fetched, and this walk never revisits.
  if (!res.ok) {
    throw new Error(`events ${start}-${end} ${type.split(".").pop()} HTTP ${res.status}`)
  }
  const json = (await res.json()) as FlowEventBlock[]
  return Array.isArray(json) ? json : []
}

async function getLatestSealedHeight(): Promise<number> {
  const res = await fetch(`${FLOW_REST}/v1/blocks?height=sealed`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`blocks sealed HTTP ${res.status}`)
  const json = (await res.json()) as Array<{ header: { height: string } }>
  const h = Number(json[0]?.header?.height ?? 0)
  if (!Number.isFinite(h) || h <= 0) throw new Error("blocks sealed: no height")
  return h
}

type Missing = {
  offer_id: string
  fill_tx: string
  sold_at: string
  edition_id: string | null
  serial_number: number | null
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) return unauthorized()

  const rangeParam = Number(req.nextUrl.searchParams.get("range") ?? DEFAULT_RANGE)
  const maxRange = Math.min(Math.max(rangeParam || DEFAULT_RANGE, CHUNK_SIZE), RANGE_CAP)
  const startBlockOverride = req.nextUrl.searchParams.get("start_block")

  const startTime = Date.now()
  let cursorBefore: string | null = null
  let cursorAfter: string | null = null
  let pages = 0
  let availSeen = 0
  let matched = 0
  let inserted = 0
  let viaFillSale = 0
  let unresolved = 0
  let done = false
  let fetchError: string | null = null

  try {
    const { data: cursorRow, error: cursorErr } = await (supabaseAdmin as any)
      .from("event_cursor")
      .select("last_processed_block")
      .eq("id", CURSOR_ID)
      .maybeSingle()
    if (cursorErr) throw new Error(`cursor read failed: ${cursorErr.message}`)

    let lastBlock = Number(cursorRow?.last_processed_block ?? 0)
    if (startBlockOverride != null && startBlockOverride !== "") {
      lastBlock = Math.max(Number(startBlockOverride) - 1, 0)
    } else if (lastBlock === 0) {
      lastBlock = DEFAULT_START - 1
    }
    cursorBefore = String(lastBlock)

    const currentHeight = Math.min(await getLatestSealedHeight(), STOP_AT)
    if (lastBlock >= currentHeight) {
      cursorAfter = cursorBefore
      done = true
    } else {
      const targetHeight = Math.min(lastBlock + maxRange, currentHeight)

      // 1. scan OfferAvailable, time-bounded; processedTo names only a fully read group.
      const availById = new Map<string, AvailOffer>()
      const chunks: Array<[number, number]> = []
      for (let s = lastBlock + 1; s <= targetHeight; s += CHUNK_SIZE) chunks.push([s, Math.min(s + CHUNK_SIZE - 1, targetHeight)])
      let processedTo = lastBlock
      for (let i = 0; i < chunks.length; i += PARALLEL_CHUNKS) {
        const group = chunks.slice(i, i + PARALLEL_CHUNKS)
        const results = await Promise.all(group.map(([s, e]) => fetchEventRange(OFFER_AVAILABLE, s, e)))
        pages += group.length
        for (const blocks of results) {
          for (const blk of blocks) {
            for (const evt of blk.events ?? []) {
              let payload: Record<string, any> | null = null
              try {
                payload = unwrapCdc(JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))) as Record<string, any>
              } catch { /* skip malformed */ }
              if (!payload || !extractNftTypeId(payload.nftType)?.endsWith(TOPSHOT_NFT_TYPE_SUFFIX)) continue
              const p = parseOfferAvailable(payload)
              if (p) availById.set(p.offerId, { ...p, txHash: evt.transaction_id, blockTs: blk.block_timestamp })
            }
          }
        }
        processedTo = group[group.length - 1][1]
        if (Date.now() - startTime > BUDGET_MS) break
      }
      availSeen = availById.size

      // 2. which of these are in the missing set (and still have no offers row).
      const ids = Array.from(availById.keys())
      const missing = new Map<string, Missing>()
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await (supabaseAdmin as any)
          .from("topshot_offer_fill_missing_offers")
          .select("offer_id, fill_tx, sold_at, edition_id, serial_number")
          .in("offer_id", ids.slice(i, i + 200))
        if (error) throw new Error(`missing-set read: ${error.message}`)
        for (const r of (data as Missing[] | null) ?? []) missing.set(r.offer_id, r)
      }
      matched = missing.size

      // 3. resolve + build (resolver first, the fill sale's edition as fallback).
      const candidates = Array.from(missing.keys()).map((id) => availById.get(id)!)
      const resolved = candidates.length > 0 ? await resolveOfferTargets(candidates) : { byOfferId: new Map() }
      const rows: Array<Record<string, unknown>> = []
      for (const o of candidates) {
        const m = missing.get(o.offerId)!
        let t = resolved.byOfferId.get(o.offerId) as { editionId: string; momentId: string | null; serial: number | null } | undefined
        if (!t && m.edition_id) {
          t = { editionId: m.edition_id, momentId: null, serial: o.offerType === "serial" ? m.serial_number : null }
          viaFillSale++
        }
        if (!t) { unresolved++; continue }
        rows.push({
          offer_id: o.offerId,
          tx_hash: o.txHash,
          collection_id: TS_COLLECTION_ID,
          edition_id: t.editionId,
          moment_id: t.momentId,
          serial_number: t.serial,
          offer_amount_usd: o.amount,
          buyer_address: o.offerer,
          offer_type: o.offerType,
          source: "onchain_backfill",
          status: "filled",
          created_at: o.blockTs,
          resolved_at: m.sold_at,
          fill_tx_hash: m.fill_tx,
        })
      }

      // 4. insert-only; `inserted` counts rows the DB RETURNED as written.
      for (let i = 0; i < rows.length; i += 500) {
        const { data, error } = await (supabaseAdmin as any)
          .from("offers")
          .upsert(rows.slice(i, i + 500), { onConflict: "offer_id", ignoreDuplicates: true })
          .select("offer_id")
        if (error) throw new Error(`offers insert failed: ${error.message}`)
        inserted += ((data as unknown[] | null) ?? []).length
      }

      // 5. advance — only after every write above landed.
      const { error: cursorWriteErr } = await (supabaseAdmin as any)
        .from("event_cursor")
        .upsert({ id: CURSOR_ID, last_processed_block: processedTo, updated_at: new Date().toISOString() }, { onConflict: "id" })
      if (cursorWriteErr) throw new Error(`cursor advance failed: ${cursorWriteErr.message}`)
      cursorAfter = String(processedTo)
      done = processedTo >= currentHeight
    }
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err)
    console.log(`[${PIPELINE_NAME}] error:`, fetchError)
  }

  const extra = {
    pages,
    available_seen: availSeen,
    matched_missing: matched,
    inserted,
    resolved_via_fill_sale: viaFillSale,
    unresolved,
    done,
    duration_ms: Date.now() - startTime,
  }
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: new Date(startTime).toISOString(),
      p_rows_found: matched,
      p_rows_written: inserted,
      p_rows_skipped: unresolved,
      p_ok: fetchError === null,
      p_error: fetchError,
      p_collection_slug: "nba_top_shot",
      p_cursor_before: cursorBefore,
      p_cursor_after: cursorAfter,
      p_extra: extra,
    })
  } catch (e) {
    console.log(`[${PIPELINE_NAME}] log_pipeline_run failed (non-fatal):`, e instanceof Error ? e.message : String(e))
  }

  return NextResponse.json({ ok: fetchError === null, error: fetchError, cursor_before: cursorBefore, cursor_after: cursorAfter, ...extra })
}

export async function GET() {
  const { data, error } = await boundedRead(
    (supabaseAdmin as any)
      .from("event_cursor")
      .select("last_processed_block, updated_at")
      .eq("id", CURSOR_ID)
      .maybeSingle(),
    "api/admin/backfill-topshot-missing-fill-offers/cursor",
  )
  if (error) return apiErrorResponse(error, "api/admin/backfill-topshot-missing-fill-offers")
  return NextResponse.json({ ok: true, cursor: data ?? null, defaultStart: DEFAULT_START, stopAt: STOP_AT })
}
