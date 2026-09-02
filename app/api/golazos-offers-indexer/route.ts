import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── On-chain LaLiga Golazos offers indexer ───────────────────────────────────
//
// STATUS: INERT BY DECISION (recon run 2026-07-28). No cron calls this route, and
// none should be wired until Golazos offers actually print. It is a faithful
// mirror of the LIVE allday-offers-indexer, re-parameterized for Golazos.
//
// RECON RESULT — Golazos has NO DapperOffersV2 offers at all, of EITHER type.
// The gated POST returned ok:true / pages 60 / offersSeen 0 / offersCompleted 0
// (no error), and an independent Flow REST sweep from an egress-capable env found
// ZERO Golazos OfferAvailable events in a fully-covered contiguous 400,000-block
// window (~4 days, 14,495 offers total: TopShot 9,460, MFLPlayer 3,986, AllDay
// 775, MFLClub 274, Golazos 0, UFC 0), plus zero in six spot samples spanning
// 2026-02 -> 2026-07. Positive control on the same contract/code path in the same
// 24h: allday-offers-indexer 142 offers, topshot-offers-indexer 1,979.
//
// So this is NOT the "NFT-type offers" case the original staging comment
// hypothesized — there is no offer volume to resolve. The cause is demand:
// Golazos traded 123 moments in 30d (6 in the last 4 days) vs TopShot's 90,612.
//
// CORRECTION to the original premise: marketplace_offers' 284 Golazos rows are
// NOT evidence of DapperOffersV2 Golazos offers. That table is Flowty-extractor
// output (offer_state LISTED/CANCELLED/PURCHASED/EXPIRED keyed on
// listing_resource_id — Flowty storefront vocabulary, not the OffersV2
// OfferAvailable/OfferCompleted lifecycle), edition_id is NULL on all 100,771
// rows across all four collections, and it is frozen at Flowty's 2026-05-16
// shutdown.
//
// TO RE-TEST LATER: POST with Bearer INGEST_SECRET_TOKEN and read offersSeen.
// Wire a ~20-min cron-job.org entry ONLY if it comes back > 0 (then verify
// edition_offers gained Golazos rows and spot-check editionId against
// editions.external_id). See docs/handoff-2026-07-28-golazos-offers-indexer.md.
//
// Lifecycle (identical OffersV2 contract as AllDay/TopShot):
//   OfferAvailable(offerId, nftType, offerAmount, offerParamsString{_type,editionId}, ...)
//   OfferCompleted(offerId, ...)                       // accepted OR cancelled
// Open offer = an OfferAvailable whose offerId has no later OfferCompleted.
// State: golazos_open_offers (offer_id PK) is the live open set; per tick we
// insert on Available, delete on Completed, then recompute
// edition_offers.highest_offer = max(amount) per touched edition (row deleted
// when an edition's last open offer clears). low_ask is never written here.
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 300
export const dynamic = "force-dynamic"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const GOLAZOS_COLLECTION_ID = "06248cc4-b85f-47cd-af67-1855d14acd75"
const PIPELINE_NAME = "golazos-offers-indexer"

const OFFER_AVAILABLE = "A.b8ea91944fd51c43.OffersV2.OfferAvailable"
const OFFER_COMPLETED = "A.b8ea91944fd51c43.OffersV2.OfferCompleted"
const GOLAZOS_NFT_TYPE_SUFFIX = ".Golazos.NFT"

const FLOW_REST = "https://rest-mainnet.onflow.org"
const CHUNK_SIZE = 250
// Blocks advanced per tick. ~20-min cron => ~1,400 blocks of chain between ticks
// (Flow ~0.85s/block), so 15k gives ample catch-up headroom while keeping a tick
// to ~60 chunk-pairs (~10-15s), comfortably under cron-job.org's 30s wait.
const PER_TICK_RANGE = 15_000
// First run only: start this far back so the initial open set is meaningful (~12h).
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

// Minimal JSON-CDC unwrapper (mirror of the AllDay offers/sales indexers).
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
    // ⚠ THROW, DO NOT `return []`. Swallowing a non-2xx made the range read as
    // GENUINELY EMPTY: the chunk loop completed normally, step 4 below advanced
    // the cursor to targetHeight, and the run logged ok=true — over blocks that
    // nothing had read. Nothing revisits a block below the cursor, so every
    // offer in that range was lost permanently.
    //
    // Throwing is the whole fix here because the scan already sits inside one
    // try/catch whose catch fires BEFORE the cursor update: an aborted tick
    // leaves the cursor where it was and logs ok=false with the error, so the
    // range is re-scanned next tick. That is already how this route behaves for
    // a THROWN network error — the swallow was the only path that diverged.
    //
    // Same defect and same one-line fix as the 7 block-scan indexers repaired
    // 2026-08-21; found by the same day's sweep. See
    // docs/overnight/inbox/2026-08-21T1420Z-an-http-error-defeats-the-cursor-hold-in-7-of-8-indexers.md
    throw new Error(
      `events ${start}-${end} ${type.split(".").pop()} HTTP ${res.status}`
    )
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
    const { data: cursorRow, error: cursorErr } = await (supabaseAdmin as any)
      .from("event_cursor")
      .select("last_processed_block")
      .eq("id", "golazos_offers")
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
            if (!extractNftTypeId(payload?.nftType)?.endsWith(GOLAZOS_NFT_TYPE_SUFFIX)) continue
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
            if (!extractNftTypeId(payload?.nftType)?.endsWith(GOLAZOS_NFT_TYPE_SUFFIX)) continue
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

    const availRows = Array.from(availById.values())
      .filter((o) => !completedIds.has(o.offerId))
      .map((o) => ({ offer_id: o.offerId, edition_id: o.editionId, amount: o.amount, updated_at: new Date().toISOString() }))
    for (let i = 0; i < availRows.length; i += UPSERT_BATCH) {
      const batch = availRows.slice(i, i + UPSERT_BATCH)
      const { error } = await (supabaseAdmin as any)
        .from("golazos_open_offers")
        .upsert(batch, { onConflict: "offer_id" })
      if (error) console.log(`[${PIPELINE_NAME}] open_offers upsert error:`, error.message)
    }

    const completedArr = Array.from(completedIds)
    for (let i = 0; i < completedArr.length; i += DB_IN_CHUNK) {
      const chunk = completedArr.slice(i, i + DB_IN_CHUNK)
      const { data: rows, error: readErr } = await (supabaseAdmin as any)
        .from("golazos_open_offers")
        .select("edition_id")
        .in("offer_id", chunk)
      // ⛔ A FAILED READ HERE IS INDISTINGUISHABLE FROM "nothing matched", AND THE
      // CURSOR ADVANCES EITHER WAY. supabase-js RETURNS its errors, so the `?? []`
      // below published the failure as an empty result and the run moved past this
      // block range for good. Throwing reaches the outer catch, which marks the run
      // ok:false and leaves the cursor where it was, so the range is re-scanned.
      if (readErr) throw new Error(`golazos_open_offers read failed: ${readErr.message}`)
      for (const r of (rows as Array<{ edition_id: string }> | null) ?? []) touched.add(r.edition_id)
      const { error } = await (supabaseAdmin as any)
        .from("golazos_open_offers")
        .delete()
        .in("offer_id", chunk)
      if (error) console.log(`[${PIPELINE_NAME}] open_offers delete error:`, error.message)
    }

    const touchedArr = Array.from(touched)
    const maxByEdition = new Map<string, number>()
    for (let i = 0; i < touchedArr.length; i += DB_IN_CHUNK) {
      const chunk = touchedArr.slice(i, i + DB_IN_CHUNK)
      const { data: rows, error: readErr2 } = await (supabaseAdmin as any)
        .from("golazos_open_offers")
        .select("edition_id, amount")
        .in("edition_id", chunk)
      // Same shape as the read above: a failed read must not render as "no match".
      if (readErr2) throw new Error(`golazos_open_offers read failed: ${readErr2.message}`)
      for (const r of (rows as Array<{ edition_id: string; amount: number }> | null) ?? []) {
        const prev = maxByEdition.get(r.edition_id)
        const amt = Number(r.amount)
        if (prev === undefined || amt > prev) maxByEdition.set(r.edition_id, amt)
      }
    }

    const upsertRows = touchedArr
      .filter((eid) => maxByEdition.has(eid))
      .map((eid) => ({
        collection_id: GOLAZOS_COLLECTION_ID,
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
        .eq("collection_id", GOLAZOS_COLLECTION_ID)
        .in("external_id", chunk)
      if (error) console.log(`[${PIPELINE_NAME}] edition_offers clear error:`, error.message)
      else editionsCleared += chunk.length
    }

    const { error: cursorWriteErr } = await (supabaseAdmin as any)
      .from("event_cursor")
      .update({ last_processed_block: targetHeight, updated_at: new Date().toISOString() })
      .eq("id", "golazos_offers")
    // ⚠ A DISCARDED CURSOR-WRITE ERROR TURNS A FAILED ADVANCE INTO A LOGGED
    // MOVEMENT. `cursorAfter` is the only field an operator can read to see the
    // walk progressing, and it was assigned whether or not the write landed — so a
    // tick that could not persist its cursor reported the new block anyway, and the
    // next tick silently re-scanned the identical range. Throw instead: the outer
    // catch marks the run ok:false and leaves `cursorAfter` at its real value.
    if (cursorWriteErr) throw new Error(`cursor advance failed: ${cursorWriteErr.message}`)
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
      p_collection_slug: "laliga_golazos",
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
    .eq("collection_id", GOLAZOS_COLLECTION_ID)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({
    ok: true,
    note: "STAGED/INERT. POST with Bearer INGEST_SECRET_TOKEN to run the recon tick (needs Flow REST egress). See docs/handoff-2026-07-28-golazos-offers-indexer.md",
    golazosOfferRows: count,
  })
}
