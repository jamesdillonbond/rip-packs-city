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

// ── Backfill: recover Top Shot offers completed inside one indexer tick ──────
//
// Until 2026-10-10 the live topshot-offers-indexer SKIPPED any offer created and
// completed (accepted or cancelled) within the same ~20-min tick, so it never got
// an `offers` row. ~25 % of every offer_fill sale since 2026-06-03 had no offer
// row behind it (24k fills). The forward fix writes those with their final status;
// this route walks the historical range once to recover them.
//
// Per call it reads OfferAvailable over [start - LOOKBACK, end] and OfferCompleted
// over [start, end], and writes ONLY offers that both (a) completed in range and
// (b) are ABSENT from `offers`:
//   - never an "open" row: an offer this walk sees created but not completed
//     may have completed after `end`, so writing it open would fabricate a live
//     bid. Live offers are the forward indexer's job.
//   - never an overwrite: insert with ON CONFLICT (offer_id) DO NOTHING, so an
//     existing row (with its forward-indexer status) is never touched.
// LOOKBACK ≥ the forward indexer's PER_TICK_RANGE, so an offer created just before
// `start` and completed inside the range is still matched.
//
// POST /api/admin/backfill-topshot-offers   Bearer $INGEST_SECRET_TOKEN
//   ?start_block=N  (one-time override of the cursor start)
//   ?range=N        (max blocks this call; default 60000, cap 200000)
// Driven by .github/workflows/topshot-offers-history-backfill.yml (sync).
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 300
export const dynamic = "force-dynamic"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const PIPELINE_NAME = "backfill-topshot-offers"
const CURSOR_ID = "topshot_offers_history_backfill"
const TS_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

const OFFER_AVAILABLE = "A.b8ea91944fd51c43.OffersV2.OfferAvailable"
const OFFER_COMPLETED = "A.b8ea91944fd51c43.OffersV2.OfferCompleted"
const TOPSHOT_NFT_TYPE_SUFFIX = ".TopShot.NFT"
const FLOW_REST = "https://rest-mainnet.onflow.org"

const CHUNK_SIZE = 250
const PARALLEL_CHUNKS = 4
const LOOKBACK = 15_000 // = the forward indexer's PER_TICK_RANGE
const DEFAULT_RANGE = 60_000
const RANGE_CAP = 200_000
const BUDGET_MS = 170_000
const INSERT_BATCH = 500
// ~block at the earliest TS offer (2026-06-03); same start as the offer-fill backfill.
const DEFAULT_START = 153_600_000
// The walk ENDS here, not at the chain head: the forward fix (same-tick offers
// written with their final status) was live well before this block, so nothing
// above it needs recovering. Without an end the walk would chase the head forever.
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
  // Flow's access node answers 429 under this walk's parallel reads (seen
  // 2026-10-10 at block 163.13M). Back off and retry a 429 only; any other
  // non-2xx, or a 429 that outlasts the retries, still THROWS below.
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

function decode(evt: { payload: string }): Record<string, any> | null {
  try {
    return unwrapCdc(JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))) as Record<string, any>
  } catch {
    return null
  }
}

function chunksOf(start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let s = start; s <= end; s += CHUNK_SIZE) out.push([s, Math.min(s + CHUNK_SIZE - 1, end)])
  return out
}

type Completion = { status: "filled" | "cancelled"; at: string; fillTx: string | null }

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
  let completedSeen = 0
  let matched = 0
  let unresolved = 0
  const unresolvedByType: Record<string, number> = { edition: 0, subedition: 0, serial: 0 }
  let resolvedViaSale = 0
  let alreadyPresent = 0
  let inserted = 0
  let aliased = 0
  const insertedByStatus = { filled: 0, cancelled: 0 }
  let done = false
  let fetchError: string | null = null

  try {
    const { data: cursorRow, error: cursorErr } = await (supabaseAdmin as any)
      .from("event_cursor")
      .select("last_processed_block")
      .eq("id", CURSOR_ID)
      .maybeSingle()
    // A failed cursor read is NOT "no cursor yet" — falling through to
    // DEFAULT_START would rewind a walk that had advanced.
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
      const start = lastBlock + 1
      const targetHeight = Math.min(lastBlock + maxRange, currentHeight)

      const availById = new Map<string, AvailOffer>()
      const completions = new Map<string, Completion>()

      const scanAvailable = (blocks: FlowEventBlock[]) => {
        for (const blk of blocks) {
          for (const evt of blk.events ?? []) {
            const payload = decode(evt)
            if (!payload || !extractNftTypeId(payload.nftType)?.endsWith(TOPSHOT_NFT_TYPE_SUFFIX)) continue
            const p = parseOfferAvailable(payload)
            if (p) availById.set(p.offerId, { ...p, txHash: evt.transaction_id, blockTs: blk.block_timestamp })
          }
        }
      }

      // 1a. lookback: OfferAvailable only, before `start`.
      const lookbackChunks = chunksOf(Math.max(start - LOOKBACK, 0), start - 1)
      for (let i = 0; i < lookbackChunks.length; i += PARALLEL_CHUNKS) {
        const group = lookbackChunks.slice(i, i + PARALLEL_CHUNKS)
        const results = await Promise.all(group.map(([s, e]) => fetchEventRange(OFFER_AVAILABLE, s, e)))
        pages += group.length
        for (const blocks of results) scanAvailable(blocks)
      }

      // 1b. the range itself: both event types, time-bounded. processedTo only
      //     ever names the end of a group that was FULLY fetched.
      let processedTo = lastBlock
      const rangeChunks = chunksOf(start, targetHeight)
      for (let i = 0; i < rangeChunks.length; i += PARALLEL_CHUNKS) {
        const group = rangeChunks.slice(i, i + PARALLEL_CHUNKS)
        const results = await Promise.all(
          group.map(async ([s, e]) => {
            const [a, c] = await Promise.all([
              fetchEventRange(OFFER_AVAILABLE, s, e),
              fetchEventRange(OFFER_COMPLETED, s, e),
            ])
            return { a, c }
          }),
        )
        pages += group.length * 2
        for (const { a, c } of results) {
          scanAvailable(a)
          for (const blk of c) {
            for (const evt of blk.events ?? []) {
              const payload = decode(evt)
              if (!payload || !extractNftTypeId(payload.nftType)?.endsWith(TOPSHOT_NFT_TYPE_SUFFIX)) continue
              const offerId = payload.offerId != null ? String(payload.offerId) : null
              if (!offerId) continue
              completions.set(offerId, {
                status: payload.purchased === true ? "filled" : "cancelled",
                at: blk.block_timestamp,
                fillTx: payload.purchased === true ? evt.transaction_id : null,
              })
            }
          }
        }
        processedTo = group[group.length - 1][1]
        if (Date.now() - startTime > BUDGET_MS) break
      }
      completedSeen = completions.size

      // 2. candidates: completed in range AND creation seen.
      const candidates = Array.from(completions.keys())
        .map((id) => availById.get(id))
        .filter((o): o is AvailOffer => o != null)
      matched = candidates.length

      // 3. drop the ones already in `offers` (cheap pre-filter; the insert's
      //    ON CONFLICT DO NOTHING is what actually guarantees no overwrite).
      const present = new Set<string>()
      const ids = candidates.map((o) => o.offerId)
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await (supabaseAdmin as any)
          .from("offers")
          .select("offer_id")
          .eq("collection_id", TS_COLLECTION_ID)
          .in("offer_id", ids.slice(i, i + 200))
        if (error) throw new Error(`offers presence read: ${error.message}`)
        for (const r of (data as Array<{ offer_id: string }> | null) ?? []) present.add(r.offer_id)
      }
      alreadyPresent = present.size
      const missing = candidates.filter((o) => !present.has(o.offerId))

      // 4. resolve + build.
      const resolved = await resolveOfferTargets(missing)
      aliased = resolved.aliased
      // 4b. a FILLED offer the catalog cannot place (most often a serial offer
      //     on an nft absent from `moments`) takes its edition + serial from its
      //     own fill sale — the same fill tx, already resolved by the sale builder.
      const fillTxs = missing
        .filter((o) => !resolved.byOfferId.has(o.offerId) && completions.get(o.offerId)?.fillTx)
        .map((o) => completions.get(o.offerId)!.fillTx!)
      const saleByTx = new Map<string, { editionId: string; serial: number | null }>()
      for (let i = 0; i < fillTxs.length; i += 200) {
        const { data, error } = await (supabaseAdmin as any)
          .from("sales")
          .select("transaction_hash, edition_id, serial_number")
          .eq("collection_id", TS_COLLECTION_ID)
          .eq("source", "offer_fill")
          .in("transaction_hash", fillTxs.slice(i, i + 200))
        if (error) throw new Error(`fill-sale lookup: ${error.message}`)
        for (const r of (data as Array<{ transaction_hash: string; edition_id: string; serial_number: number | null }> | null) ?? [])
          if (r.edition_id) saleByTx.set(r.transaction_hash, { editionId: r.edition_id, serial: r.serial_number })
      }

      const rows: Array<Record<string, unknown>> = []
      for (const o of missing) {
        let t = resolved.byOfferId.get(o.offerId)
        if (!t) {
          const tx = completions.get(o.offerId)?.fillTx
          const sale = tx ? saleByTx.get(tx) : undefined
          if (sale) {
            t = { editionId: sale.editionId, momentId: null, serial: o.offerType === "serial" ? sale.serial : null }
            resolvedViaSale++
          }
        }
        if (!t) { unresolved++; unresolvedByType[o.offerType]++; continue }
        const c = completions.get(o.offerId)!
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
          // Distinct from the live indexer's "onchain" so every row this walk
          // wrote is identifiable (and revertible) by one predicate. No reader
          // filters offers on `source`.
          source: "onchain_backfill",
          status: c.status,
          created_at: o.blockTs,
          resolved_at: c.at,
          fill_tx_hash: c.fillTx,
        })
      }

      // 5. insert-only. `inserted` counts rows the DB RETURNED as written.
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        const batch = rows.slice(i, i + INSERT_BATCH)
        const { data, error } = await (supabaseAdmin as any)
          .from("offers")
          .upsert(batch, { onConflict: "offer_id", ignoreDuplicates: true })
          .select("offer_id, status")
        if (error) throw new Error(`offers insert failed: ${error.message}`)
        for (const r of (data as Array<{ status: string }> | null) ?? []) {
          inserted++
          if (r.status === "filled") insertedByStatus.filled++
          else if (r.status === "cancelled") insertedByStatus.cancelled++
        }
      }

      // 6. advance — only after every write above landed.
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
    completed_seen: completedSeen,
    matched_available: matched,
    already_present: alreadyPresent,
    unresolved,
    unresolved_by_type: unresolvedByType,
    resolved_via_fill_sale: resolvedViaSale,
    aliased_to_canonical: aliased,
    inserted,
    inserted_filled: insertedByStatus.filled,
    inserted_cancelled: insertedByStatus.cancelled,
    done,
    duration_ms: Date.now() - startTime,
  }
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: new Date(startTime).toISOString(),
      p_rows_found: matched,
      p_rows_written: inserted,
      p_rows_skipped: alreadyPresent + unresolved,
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

  return NextResponse.json({
    ok: fetchError === null,
    error: fetchError,
    cursor_before: cursorBefore,
    cursor_after: cursorAfter,
    ...extra,
  })
}

export async function GET() {
  const { data, error } = await boundedRead(
    (supabaseAdmin as any)
      .from("event_cursor")
      .select("last_processed_block, updated_at")
      .eq("id", CURSOR_ID)
      .maybeSingle(),
    "api/admin/backfill-topshot-offers/cursor",
  )
  if (error) return apiErrorResponse(error, "api/admin/backfill-topshot-offers")
  return NextResponse.json({
    ok: true,
    note: "POST with Bearer INGEST_SECRET_TOKEN to drain the Top Shot offers history backfill",
    cursor: data ?? null,
    defaultStart: DEFAULT_START,
    stopAt: STOP_AT,
  })
}
