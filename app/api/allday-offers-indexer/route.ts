import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── On-chain NFL All Day offers indexer ──────────────────────────────────────
//
// NFL All Day's marketplace GQL exposes NO offer/bid data (confirmed exhaustively
// 2026-06-01 H4), so the only AllDay "best offer" source is on-chain: Dapper's
// generic offers contract OffersV2 at 0xb8ea91944fd51c43 (the same contract that
// carries Top Shot offers). Recon (2026-06-03) found ~78 AllDay OfferAvailable
// across 57 distinct editions per ~4h window — real, ongoing volume.
//
// AllDay offers are `_type = "EDITION"`: OfferAvailable.offerParamsString carries
// `editionId` directly (== AllDay editions.external_id), so NO consumer-GQL
// nftID->edition resolution is needed (unlike sales). The offer targets an
// edition, not a specific serial.
//
// Lifecycle (verified on-chain via Cadence MCP against the deployed OffersV2):
//   OfferAvailable(offerId, nftType, offerAmount, offerParamsString{_type,editionId}, ...)
//   OfferCompleted(offerId, purchased, nftId?, ... same params)        // accepted OR cancelled
// Open offer = an OfferAvailable whose offerId has no later OfferCompleted.
//
// State model: allday_open_offers (offer_id PK, edition_id, amount) is the live
// open set. Per tick we insert on Available, delete on Completed, then recompute
// edition_offers.highest_offer = max(amount) per touched edition. When an
// edition's last open offer clears, its edition_offers row is deleted so the
// "Best offer" cell (get_edition_high_offer -> edition_offers) hides again.
// low_ask is never written here (AllDay ask is surfaced separately via
// get_edition_detail.cross_market_ask); omitting it from the upsert preserves
// any existing value.
//
// v1 is forward-tracking from a ~12h backfill — it builds the open set going
// forward and converges over a day or two; offers created before the indexer
// started are only reflected once they're re-observed. Open offers are a live
// snapshot, so this is sufficient (no deep backfill).
//
// Live cron (cron-job.org): POST /api/allday-offers-indexer with
// Authorization: Bearer $INGEST_SECRET_TOKEN (or ?token=) every ~20 min, on
// www.rippackscity.com (apex 308-redirects).
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 300
export const dynamic = "force-dynamic"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const PIPELINE_NAME = "allday-offers-indexer"

const OFFER_AVAILABLE = "A.b8ea91944fd51c43.OffersV2.OfferAvailable"
const OFFER_COMPLETED = "A.b8ea91944fd51c43.OffersV2.OfferCompleted"
const ALLDAY_NFT_TYPE_SUFFIX = ".AllDay.NFT"

const FLOW_REST = "https://rest-mainnet.onflow.org"
const CHUNK_SIZE = 250
// Blocks advanced per tick. ~20-min cron => ~1,400 blocks of chain between ticks
// (Flow ~0.85s/block), so 15k gives ample catch-up headroom while keeping a tick
// to ~60 chunk-pairs (~10-15s), comfortably under cron-job.org's 30s wait.
const PER_TICK_RANGE = 15_000
// First run only: start this far back so the initial open set is meaningful
// (~12h). Each tick still advances at most PER_TICK_RANGE, so the backfill is
// walked over a few ticks (~1h) rather than one giant scan.
const INITIAL_BACKFILL = 50_000
const INTER_CHUNK_DELAY_MS = 75
const DB_IN_CHUNK = 200
const UPSERT_BATCH = 500

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// Minimal JSON-CDC unwrapper (mirror of the AllDay sales indexer). Returns a
// plain object keyed by event field name; Type fields collapse to {staticType}.
function unwrapCdc(node: unknown): unknown {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(unwrapCdc)
  if (typeof node !== "object") return node
  const { type, value } = node as { type?: string; value?: unknown }
  if (type !== undefined && value !== undefined) {
    switch (type) {
      case "Optional":
        return value === null ? null : unwrapCdc(value)
      case "Array":
        return (value as unknown[]).map(unwrapCdc)
      case "Dictionary": {
        const out: Record<string, unknown> = {}
        for (const kv of value as Array<{ key: unknown; value: unknown }>) {
          out[String(unwrapCdc(kv.key))] = unwrapCdc(kv.value)
        }
        return out
      }
      case "Struct":
      case "Resource":
      case "Event":
      case "Contract":
      case "Enum": {
        const out: Record<string, unknown> = {}
        const fields = (value as { fields?: Array<{ name: string; value: unknown }> }).fields ?? []
        for (const f of fields) out[f.name] = unwrapCdc(f.value)
        return out
      }
      case "Type":
        return { staticType: (value as { staticType?: unknown }).staticType }
      default:
        // Scalars (Bool / String / Address / all Int|UInt|Word|Fix variants):
        // value is already the JS-usable primitive (numbers arrive as strings).
        return value
    }
  }
  return node
}

function extractNftTypeId(field: unknown): string | undefined {
  if (typeof field === "string") return field
  if (field && typeof field === "object") {
    const st = (field as Record<string, unknown>).staticType
    if (typeof st === "string") return st
    if (st && typeof st === "object") {
      const id = (st as Record<string, unknown>).typeID
      if (typeof id === "string") return id
    }
  }
  return undefined
}

interface FlowEventBlock {
  block_height: string
  block_timestamp: string
  events?: Array<{ type: string; transaction_id: string; payload: string; event_index: number }>
}

async function fetchEventRange(type: string, start: number, end: number): Promise<FlowEventBlock[]> {
  const url = `${FLOW_REST}/v1/events?type=${encodeURIComponent(type)}&start_height=${start}&end_height=${end}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) {
    console.log(`[${PIPELINE_NAME}] events ${start}-${end} ${type.split(".").pop()} HTTP ${res.status}`)
    return []
  }
  const json = (await res.json()) as FlowEventBlock[]
  return Array.isArray(json) ? json : []
}

async function getLatestSealedHeight(): Promise<number> {
  const res = await fetch(`${FLOW_REST}/v1/blocks?height=sealed`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`blocks sealed HTTP ${res.status}`)
  const json = (await res.json()) as Array<{ header: { height: string } }>
  return Number(json[0]?.header?.height ?? 0)
}

type OpenOffer = { offerId: string; editionId: string; amount: number }

function parseOffer(payload: Record<string, any>): { offerId: string; editionId: string | null; amount: number } | null {
  const offerId = payload?.offerId != null ? String(payload.offerId) : null
  if (!offerId) return null
  const params = (payload?.offerParamsString ?? {}) as Record<string, unknown>
  const isEdition = (params._type ?? params["_type"]) === "EDITION"
  const editionId = isEdition && params.editionId != null ? String(params.editionId) : null
  const amount = payload?.offerAmount != null ? Number(payload.offerAmount) : NaN
  return { offerId, editionId, amount: Number.isFinite(amount) ? amount : NaN }
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) return unauthorized()

  const startTime = Date.now()
  const rangeParam = Number(req.nextUrl.searchParams.get("range") ?? PER_TICK_RANGE)
  const maxRange = Math.min(Math.max(rangeParam || PER_TICK_RANGE, CHUNK_SIZE), 100_000)

  let cursorBefore: string | null = null
  let cursorAfter: string | null = null
  let pages = 0
  let offersSeen = 0
  let offersCompleted = 0
  let editionsWritten = 0
  let editionsCleared = 0
  let fetchError: string | null = null

  try {
    // 1. cursor
    const { data: cursorRow, error: cursorErr } = await (supabaseAdmin as any)
      .from("event_cursor")
      .select("last_processed_block")
      .eq("id", "allday_offers")
      .single()
    if (cursorErr) throw new Error(`cursor read error: ${cursorErr.message}`)

    let lastBlock = Number(cursorRow?.last_processed_block ?? 0)
    const currentHeight = await getLatestSealedHeight()
    if (lastBlock === 0) {
      lastBlock = Math.max(currentHeight - INITIAL_BACKFILL, 0)
      console.log(`[${PIPELINE_NAME}] first run, starting from block ${lastBlock}`)
    }
    cursorBefore = String(lastBlock)

    if (lastBlock >= currentHeight) {
      cursorAfter = String(lastBlock)
      await logRun(startTime, 0, 0, true, null, cursorBefore, cursorAfter, {
        message: "already up to date",
        current_height: currentHeight,
      })
      return NextResponse.json({ ok: true, message: "already up to date", lastBlock, currentHeight })
    }

    const targetHeight = Math.min(lastBlock + maxRange, currentHeight)

    // 2. scan: collect Available (insert) + Completed (delete) across the tick.
    const availById = new Map<string, OpenOffer>()
    const completedIds = new Set<string>()
    const touched = new Set<string>()

    for (let s = lastBlock + 1; s <= targetHeight; s += CHUNK_SIZE) {
      const e = Math.min(s + CHUNK_SIZE - 1, targetHeight)
      const [availBlocks, completedBlocks] = await Promise.all([
        fetchEventRange(OFFER_AVAILABLE, s, e),
        fetchEventRange(OFFER_COMPLETED, s, e),
      ])
      pages++

      for (const blk of availBlocks) {
        for (const evt of blk.events ?? []) {
          try {
            const payload = unwrapCdc(JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))) as Record<string, any>
            if (!extractNftTypeId(payload?.nftType)?.endsWith(ALLDAY_NFT_TYPE_SUFFIX)) continue
            const o = parseOffer(payload)
            if (!o || !o.editionId || !Number.isFinite(o.amount) || o.amount <= 0) continue
            offersSeen++
            availById.set(o.offerId, { offerId: o.offerId, editionId: o.editionId, amount: o.amount })
            touched.add(o.editionId)
          } catch { /* skip malformed payload */ }
        }
      }

      for (const blk of completedBlocks) {
        for (const evt of blk.events ?? []) {
          try {
            const payload = unwrapCdc(JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))) as Record<string, any>
            if (!extractNftTypeId(payload?.nftType)?.endsWith(ALLDAY_NFT_TYPE_SUFFIX)) continue
            const o = parseOffer(payload)
            if (!o) continue
            offersCompleted++
            completedIds.add(o.offerId)
            if (o.editionId) touched.add(o.editionId)
          } catch { /* skip malformed payload */ }
        }
      }

      if (e < targetHeight) await delay(INTER_CHUNK_DELAY_MS)
    }

    // 3a. insert/refresh open offers seen this tick.
    const availRows = Array.from(availById.values())
      // If an offer was created AND completed within this same tick, skip the
      // insert entirely (the delete below would otherwise race it; cleaner to
      // never write it).
      .filter((o) => !completedIds.has(o.offerId))
      .map((o) => ({ offer_id: o.offerId, edition_id: o.editionId, amount: o.amount, updated_at: new Date().toISOString() }))
    for (let i = 0; i < availRows.length; i += UPSERT_BATCH) {
      const batch = availRows.slice(i, i + UPSERT_BATCH)
      const { error } = await (supabaseAdmin as any)
        .from("allday_open_offers")
        .upsert(batch, { onConflict: "offer_id" })
      if (error) console.log(`[${PIPELINE_NAME}] open_offers upsert error:`, error.message)
    }

    // 3b. completed offers: capture their edition_ids (for editions created in a
    // prior tick where we only have the row, not this tick's Available), then
    // delete. Process delete AFTER the insert so same-tick create+complete nets
    // to "not open".
    const completedArr = Array.from(completedIds)
    for (let i = 0; i < completedArr.length; i += DB_IN_CHUNK) {
      const chunk = completedArr.slice(i, i + DB_IN_CHUNK)
      const { data: rows } = await (supabaseAdmin as any)
        .from("allday_open_offers")
        .select("edition_id")
        .in("offer_id", chunk)
      for (const r of (rows as Array<{ edition_id: string }> | null) ?? []) touched.add(r.edition_id)
      const { error } = await (supabaseAdmin as any)
        .from("allday_open_offers")
        .delete()
        .in("offer_id", chunk)
      if (error) console.log(`[${PIPELINE_NAME}] open_offers delete error:`, error.message)
    }

    // 3c. recompute edition_offers.highest_offer for every touched edition.
    const touchedArr = Array.from(touched)
    const maxByEdition = new Map<string, number>()
    for (let i = 0; i < touchedArr.length; i += DB_IN_CHUNK) {
      const chunk = touchedArr.slice(i, i + DB_IN_CHUNK)
      const { data: rows } = await (supabaseAdmin as any)
        .from("allday_open_offers")
        .select("edition_id, amount")
        .in("edition_id", chunk)
      for (const r of (rows as Array<{ edition_id: string; amount: number }> | null) ?? []) {
        const prev = maxByEdition.get(r.edition_id)
        const amt = Number(r.amount)
        if (prev === undefined || amt > prev) maxByEdition.set(r.edition_id, amt)
      }
    }

    // Editions that still have an open offer -> upsert max; editions with none
    // left -> delete the row so the "Best offer" cell hides again.
    const upsertRows = touchedArr
      .filter((eid) => maxByEdition.has(eid))
      .map((eid) => ({
        collection_id: ALLDAY_COLLECTION_ID,
        external_id: eid,
        highest_offer: maxByEdition.get(eid)!,
        updated_at: new Date().toISOString(),
      }))
    for (let i = 0; i < upsertRows.length; i += UPSERT_BATCH) {
      const batch = upsertRows.slice(i, i + UPSERT_BATCH)
      const { error } = await (supabaseAdmin as any)
        .from("edition_offers")
        .upsert(batch, { onConflict: "collection_id,external_id" })
      if (error) console.log(`[${PIPELINE_NAME}] edition_offers upsert error:`, error.message)
      else editionsWritten += batch.length
    }

    const clearedEditions = touchedArr.filter((eid) => !maxByEdition.has(eid))
    for (let i = 0; i < clearedEditions.length; i += DB_IN_CHUNK) {
      const chunk = clearedEditions.slice(i, i + DB_IN_CHUNK)
      const { error } = await (supabaseAdmin as any)
        .from("edition_offers")
        .delete()
        .eq("collection_id", ALLDAY_COLLECTION_ID)
        .in("external_id", chunk)
      if (error) console.log(`[${PIPELINE_NAME}] edition_offers clear error:`, error.message)
      else editionsCleared += chunk.length
    }

    // 4. advance cursor.
    await (supabaseAdmin as any)
      .from("event_cursor")
      .update({ last_processed_block: targetHeight, updated_at: new Date().toISOString() })
      .eq("id", "allday_offers")
    cursorAfter = String(targetHeight)
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err)
    console.log(`[${PIPELINE_NAME}] error:`, fetchError)
  }

  await logRun(startTime, offersSeen, editionsWritten, fetchError === null, fetchError, cursorBefore, cursorAfter, {
    pages,
    offers_seen: offersSeen,
    offers_completed: offersCompleted,
    editions_written: editionsWritten,
    editions_cleared: editionsCleared,
    duration_ms: Date.now() - startTime,
  })

  return NextResponse.json({
    ok: fetchError === null,
    pages,
    offersSeen,
    offersCompleted,
    editionsWritten,
    editionsCleared,
    cursorBefore,
    cursorAfter,
    error: fetchError,
    durationMs: Date.now() - startTime,
  })
}

async function logRun(
  startTime: number,
  rowsFound: number,
  rowsWritten: number,
  ok: boolean,
  error: string | null,
  cursorBefore: string | null,
  cursorAfter: string | null,
  extra: Record<string, unknown>
) {
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: new Date(startTime).toISOString(),
      p_rows_found: rowsFound,
      p_rows_written: rowsWritten,
      p_rows_skipped: 0,
      p_ok: ok,
      p_error: error,
      p_collection_slug: "nfl_all_day",
      p_cursor_before: cursorBefore,
      p_cursor_after: cursorAfter,
      p_extra: extra,
    })
  } catch (e) {
    console.log(`[${PIPELINE_NAME}] log_pipeline_run failed (non-fatal):`, e instanceof Error ? e.message : String(e))
  }
}

export async function GET() {
  const { count, error } = await (supabaseAdmin as any)
    .from("edition_offers")
    .select("external_id", { count: "exact", head: true })
    .eq("collection_id", ALLDAY_COLLECTION_ID)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, note: "POST with Bearer INGEST_SECRET_TOKEN to run the indexer", allDayOfferRows: count })
}
