import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── On-chain Top Shot offers indexer ─────────────────────────────────────────
//
// Populates the rich `offers` table with per-offer intelligence the GQL
// offers-sweep can't see: bidder identity, exact amount, offer TYPE
// (edition / subedition / serial), and fill outcome (accepted vs cancelled).
// Reads Dapper's generic OffersV2 contract (0xb8ea91944fd51c43) — the same
// contract behind the AllDay offers indexer (cc8a3e7) — filtered to TopShot.NFT.
//
// Offer param shapes (verified on-chain via Cadence MCP + live event decode):
//   _type=TopShotEdition     -> setId, playId            => external_id "setId:playId"            (offer_type 'edition')
//   _type=TopShotSubedition  -> setId, playId, subeditionId => base external_id "setId:playId"     (offer_type 'subedition')
//   _type=NFT                -> nftId                     => moments.nft_id -> edition_id+serial    (offer_type 'serial')
//
// IMPORTANT — this does NOT write edition_offers. The GQL `offers-sweep` already
// provides a COMPLETE edition-level highestOffer; a forward-only on-chain indexer
// undercounts open offers until it has run for days, so taking that column over
// would regress the Best-offer cell. `offers` is purely additive. Whether GQL
// actually misses subedition/serial offers is the Phase-2 v_offer_sanity_flags
// reconciliation question (where highest_offer can be RAISED with GREATEST()).
//
// State model: the `offers` table doubles as the open set — status='open' rows
// ARE the live offers; OfferCompleted flips status to 'filled'/'cancelled'.
// Idempotent via the on-chain offer_id (unique). Forward-tracking from a ~8h
// backfill; open offers are a live snapshot so no deep backfill.
//
// Live cron (cron-job.org): POST /api/topshot-offers-indexer with
// Authorization: Bearer $INGEST_SECRET_TOKEN (or ?token=) every ~20 min on
// www.rippackscity.com.
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 300
export const dynamic = "force-dynamic"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const TS_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const PIPELINE_NAME = "topshot-offers-indexer"

const OFFER_AVAILABLE = "A.b8ea91944fd51c43.OffersV2.OfferAvailable"
const OFFER_COMPLETED = "A.b8ea91944fd51c43.OffersV2.OfferCompleted"
const TOPSHOT_NFT_TYPE_SUFFIX = ".TopShot.NFT"

const FLOW_REST = "https://rest-mainnet.onflow.org"
const CHUNK_SIZE = 250
const PER_TICK_RANGE = 15_000
const INITIAL_BACKFILL = 30_000
const INTER_CHUNK_DELAY_MS = 75
const DB_IN_CHUNK = 200
const UPSERT_BATCH = 500

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}
function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// Minimal JSON-CDC unwrapper (mirror of the AllDay sales/offers indexers).
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

type AvailOffer = {
  offerId: string
  txHash: string
  blockTs: string
  amount: number
  offerer: string | null
  offerType: "edition" | "subedition" | "serial"
  externalId: string | null // setId:playId (edition/subedition)
  nftId: string | null // serial
}

function parseAvailable(payload: Record<string, any>): Omit<AvailOffer, "txHash" | "blockTs"> | null {
  const offerId = payload?.offerId != null ? String(payload.offerId) : null
  if (!offerId) return null
  const amount = payload?.offerAmount != null ? Number(payload.offerAmount) : NaN
  if (!Number.isFinite(amount) || amount <= 0) return null
  const offerer = payload?.offerAddress != null ? String(payload.offerAddress) : null
  const ps = (payload?.offerParamsString ?? {}) as Record<string, unknown>
  const t = String(ps._type ?? ps["_type"] ?? "")
  if (t === "TopShotEdition") {
    if (ps.setId == null || ps.playId == null) return null
    return { offerId, amount, offerer, offerType: "edition", externalId: `${ps.setId}:${ps.playId}`, nftId: null }
  }
  if (t === "TopShotSubedition") {
    if (ps.setId == null || ps.playId == null) return null
    // No 3-part subedition edition rows exist (verified): roll up to the base
    // edition, tagged 'subedition' so depth/fill can break it out.
    return { offerId, amount, offerer, offerType: "subedition", externalId: `${ps.setId}:${ps.playId}`, nftId: null }
  }
  if (t === "NFT") {
    if (ps.nftId == null) return null
    return { offerId, amount, offerer, offerType: "serial", externalId: null, nftId: String(ps.nftId) }
  }
  return null // unknown TS offer type
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
  let offersWritten = 0
  let offersFilled = 0
  let offersCancelled = 0
  let unresolved = 0
  const byType: Record<string, number> = { edition: 0, subedition: 0, serial: 0 }
  let fetchError: string | null = null

  try {
    const { data: cursorRow, error: cursorErr } = await (supabaseAdmin as any)
      .from("event_cursor")
      .select("last_processed_block")
      .eq("id", "topshot_offers")
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
      await logRun(startTime, 0, 0, true, null, cursorBefore, cursorAfter, { message: "already up to date", current_height: currentHeight })
      return NextResponse.json({ ok: true, message: "already up to date", lastBlock, currentHeight })
    }
    const targetHeight = Math.min(lastBlock + maxRange, currentHeight)

    // 1. scan: collect Available + Completed across the tick.
    const availById = new Map<string, AvailOffer>()
    const filledIds = new Set<string>()
    const cancelledIds = new Set<string>()

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
            if (!extractNftTypeId(payload?.nftType)?.endsWith(TOPSHOT_NFT_TYPE_SUFFIX)) continue
            const p = parseAvailable(payload)
            if (!p) continue
            availById.set(p.offerId, { ...p, txHash: evt.transaction_id, blockTs: blk.block_timestamp })
          } catch { /* skip malformed */ }
        }
      }
      for (const blk of completedBlocks) {
        for (const evt of blk.events ?? []) {
          try {
            const payload = unwrapCdc(JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))) as Record<string, any>
            if (!extractNftTypeId(payload?.nftType)?.endsWith(TOPSHOT_NFT_TYPE_SUFFIX)) continue
            const offerId = payload?.offerId != null ? String(payload.offerId) : null
            if (!offerId) continue
            if (payload?.purchased === true) filledIds.add(offerId)
            else cancelledIds.add(offerId)
          } catch { /* skip malformed */ }
        }
      }
      if (e < targetHeight) await delay(INTER_CHUNK_DELAY_MS)
    }

    // 2. resolve edition_id (uuid) for edition/subedition (setId:playId) and
    //    moment for serial (nftId). Batch the lookups.
    const avail = Array.from(availById.values())
    const extKeys = Array.from(new Set(avail.filter((o) => o.externalId).map((o) => o.externalId!)))
    const nftIds = Array.from(new Set(avail.filter((o) => o.nftId).map((o) => o.nftId!)))

    const editionIdByExt = new Map<string, string>()
    for (let i = 0; i < extKeys.length; i += DB_IN_CHUNK) {
      const chunk = extKeys.slice(i, i + DB_IN_CHUNK)
      const { data } = await (supabaseAdmin as any)
        .from("editions")
        .select("external_id, id")
        .eq("collection_id", TS_COLLECTION_ID)
        .in("external_id", chunk)
      for (const r of (data as Array<{ external_id: string; id: string }> | null) ?? []) editionIdByExt.set(r.external_id, r.id)
    }

    const momentByNft = new Map<string, { momentId: string; editionId: string; serial: number | null }>()
    for (let i = 0; i < nftIds.length; i += DB_IN_CHUNK) {
      const chunk = nftIds.slice(i, i + DB_IN_CHUNK)
      const { data } = await (supabaseAdmin as any)
        .from("moments")
        .select("nft_id, id, edition_id, serial_number")
        .in("nft_id", chunk)
      for (const r of (data as Array<{ nft_id: string; id: string; edition_id: string; serial_number: number | null }> | null) ?? [])
        momentByNft.set(r.nft_id, { momentId: r.id, editionId: r.edition_id, serial: r.serial_number })
    }

    // 3. build offer rows (skip same-tick create+complete — they're not "open";
    //    completion below would no-op on an absent row otherwise).
    const rows: Array<Record<string, unknown>> = []
    for (const o of avail) {
      if (filledIds.has(o.offerId) || cancelledIds.has(o.offerId)) continue
      let editionId: string | null = null
      let momentId: string | null = null
      let serial: number | null = null
      if (o.externalId) {
        editionId = editionIdByExt.get(o.externalId) ?? null
      } else if (o.nftId) {
        const m = momentByNft.get(o.nftId)
        if (m) { editionId = m.editionId; momentId = m.momentId; serial = m.serial }
      }
      if (!editionId) { unresolved++; continue }
      byType[o.offerType]++
      rows.push({
        offer_id: o.offerId,
        tx_hash: o.txHash,
        collection_id: TS_COLLECTION_ID,
        edition_id: editionId,
        moment_id: momentId,
        serial_number: serial,
        offer_amount_usd: o.amount,
        buyer_address: o.offerer,
        offer_type: o.offerType,
        source: "onchain",
        status: "open",
        created_at: o.blockTs,
      })
    }
    for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
      const batch = rows.slice(i, i + UPSERT_BATCH)
      const { error } = await (supabaseAdmin as any).from("offers").upsert(batch, { onConflict: "offer_id" })
      if (error) console.log(`[${PIPELINE_NAME}] offers upsert error:`, error.message)
      else offersWritten += batch.length
    }

    // 4. resolve completions: flip status on existing rows (no-op if we never
    //    recorded the open offer). Grouped update by outcome.
    const nowIso = new Date().toISOString()
    const applyStatus = async (ids: string[], status: string) => {
      for (let i = 0; i < ids.length; i += DB_IN_CHUNK) {
        const chunk = ids.slice(i, i + DB_IN_CHUNK)
        const { error, count } = await (supabaseAdmin as any)
          .from("offers")
          .update({ status, resolved_at: nowIso }, { count: "exact" })
          .eq("collection_id", TS_COLLECTION_ID)
          .eq("status", "open")
          .in("offer_id", chunk)
        if (error) console.log(`[${PIPELINE_NAME}] status=${status} update error:`, error.message)
        else if (status === "filled") offersFilled += count ?? 0
        else offersCancelled += count ?? 0
      }
    }
    await applyStatus(Array.from(filledIds), "filled")
    await applyStatus(Array.from(cancelledIds), "cancelled")

    // 5. advance cursor.
    await (supabaseAdmin as any)
      .from("event_cursor")
      .update({ last_processed_block: targetHeight, updated_at: new Date().toISOString() })
      .eq("id", "topshot_offers")
    cursorAfter = String(targetHeight)
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err)
    console.log(`[${PIPELINE_NAME}] error:`, fetchError)
  }

  await logRun(startTime, offersWritten, offersWritten, fetchError === null, fetchError, cursorBefore, cursorAfter, {
    pages,
    offers_written: offersWritten,
    by_type: byType,
    offers_filled: offersFilled,
    offers_cancelled: offersCancelled,
    unresolved,
    duration_ms: Date.now() - startTime,
  })

  return NextResponse.json({
    ok: fetchError === null,
    pages,
    offersWritten,
    byType,
    offersFilled,
    offersCancelled,
    unresolved,
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
      p_collection_slug: "nba_top_shot",
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
    .from("offers")
    .select("offer_id", { count: "exact", head: true })
    .eq("collection_id", TS_COLLECTION_ID)
    .eq("status", "open")
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, note: "POST with Bearer INGEST_SECRET_TOKEN to run the indexer", openTopShotOffers: count })
}
