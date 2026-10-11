import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseOfferCompletedFill, buildOfferFillSales, insertOfferFillSales, type OfferFillEvent } from "@/lib/chains/flow/topshot-offer-fill"
import { unwrapCdc, parseOfferAvailable as parseAvailable, resolveOfferTargets, type AvailOffer } from "@/lib/chains/flow/topshot-offer-available"

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
  let offersSeen = 0 // R123: rows_found is what the range PRODUCED, not what landed
  let offersWritten = 0
  let offersFilled = 0
  let offersCancelled = 0
  let unresolved = 0
  let completedSameTick = 0 // offers created AND completed inside this tick, written with their final status
  let viaCheckpoint = 0 // serial offers placed through checkpoint_nft_meta (subedition known)
  let viaWalletCache = 0 // serial offers placed through wallet_moments_cache (moments lacked the nft)
  const unresolvedByType: Record<string, number> = { edition: 0, subedition: 0, serial: 0 }
  // Up to 10 nft ids no source could place — so the next fallback is chosen from
  // evidence (new mints? a set nothing catalogs?), not guessed.
  const unresolvedSerialSample: string[] = []
  let aliased = 0 // #175: offers whose API key resolved through topshot_edition_aliases
  let salesWritten = 0
  let salesDuped = 0
  let salesUnresolved = 0
  let salesParallelRedirects = 0
  let fillsSeen = 0
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
    // Accepted offers are real secondary sales. The OfferCompleted event carries
    // buyer (offerAddress), seller (acceptingAddress), price (offerAmount), and
    // the exact nftId — enough to write a sale with no tx decode.
    const fills: OfferFillEvent[] = []
    const fillTxByOfferId = new Map<string, string>()
    // Completion block ts per offer, so a same-tick create+complete row (step 3)
    // carries WHEN it resolved rather than when this tick happened to run.
    const completedAtById = new Map<string, string>()

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
            completedAtById.set(offerId, blk.block_timestamp)
            if (payload?.purchased === true) {
              filledIds.add(offerId)
              const fill = parseOfferCompletedFill(payload, evt.transaction_id, blk.block_timestamp, Number(blk.block_height) || null)
              if (fill) {
                fills.push(fill)
                fillTxByOfferId.set(offerId, fill.fillTx)
              }
            } else cancelledIds.add(offerId)
          } catch { /* skip malformed */ }
        }
      }
      if (e < targetHeight) await delay(INTER_CHUNK_DELAY_MS)
    }

    // 2. resolve edition_id (uuid) for edition/subedition (setId:playId) and
    //    moment for serial (nftId). Batch the lookups.
    const avail = Array.from(availById.values())
    // 2a. (#175) Top Shot's offer contract names some printings by an API key that
    //     is an ALIAS of the chain's key; 2b. editions by external_id (subedition
    //     "::" keys fall back to their base pair); 2c. serial offers via `moments`,
    //     then (2026-10-10) via wallet_moments_cache — a serial offer on an nft
    //     `moments` lacks used to be DROPPED here: 415 of ~2,360 offers in one day.
    //     All of it lives in resolveOfferTargets, shared with the history backfill.
    //     ⚠ Every read there THROWS on error: a swallowed read made every offer
    //     look uncataloged, fell into `unresolved++`, and the cursor advanced past
    //     them for good. The throw aborts the tick before the cursor moves.
    const resolved = await resolveOfferTargets(avail)
    aliased = resolved.aliased
    viaWalletCache = resolved.viaWalletCache
    viaCheckpoint = resolved.viaCheckpoint

    // 3. build offer rows. A same-tick create+complete is written with its FINAL
    //    status — never as "open", and never dropped. ⚠ It used to be skipped
    //    ("not open"), and the step-4 flip then no-op'd on the absent row, so an
    //    offer accepted or cancelled within one ~20-min tick was NEVER recorded:
    //    ~25 % of every Top Shot offer_fill sale since June had no offers row
    //    (24k fills; 20 of 369 on the founder's wallet). The fill SALE still
    //    landed via 4b, which is why nothing reported it.
    const rows: Array<Record<string, unknown>> = []
    for (const o of avail) {
      const finalStatus = filledIds.has(o.offerId) ? "filled" : cancelledIds.has(o.offerId) ? "cancelled" : null
      const target = resolved.byOfferId.get(o.offerId)
      if (!target) {
        unresolved++
        unresolvedByType[o.offerType]++
        if (o.nftId && unresolvedSerialSample.length < 10) unresolvedSerialSample.push(o.nftId)
        continue
      }
      const { editionId, momentId, serial } = target
      byType[o.offerType]++
      if (finalStatus) completedSameTick++
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
        status: finalStatus ?? "open",
        created_at: o.blockTs,
        // Explicit on EVERY row (null for open) so one bulk upsert never mixes
        // column sets across its rows.
        resolved_at: finalStatus ? completedAtById.get(o.offerId) ?? new Date().toISOString() : null,
        fill_tx_hash: finalStatus === "filled" ? fillTxByOfferId.get(o.offerId) ?? null : null,
      })
    }
    offersSeen = rows.length
    for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
      const batch = rows.slice(i, i + UPSERT_BATCH)
      const { error } = await (supabaseAdmin as any).from("offers").upsert(batch, { onConflict: "offer_id" })
      // R123 (2026-09-20): a rejected batch used to be console.logged and the cursor
      // then advanced past the range — those offers were never indexed and the run
      // row said ok=true. Throw (the rule the lookups above already follow): the
      // outer catch logs ok:false and the cursor stays for an idempotent re-scan.
      if (error) throw new Error(`offers upsert failed: ${error.message}`)
      offersWritten += batch.length
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
        // R123: a rejected flip leaves a filled/cancelled offer "open" forever once
        // the cursor passes its completion event. Abort before the advance.
        if (error) throw new Error(`status=${status} update failed: ${error.message}`)
        if (status === "filled") offersFilled += count ?? 0
        else offersCancelled += count ?? 0
      }
    }
    await applyStatus(Array.from(filledIds), "filled")
    await applyStatus(Array.from(cancelledIds), "cancelled")

    // 4b. capture accepted offers as sales (source='offer_fill'). The fill tx is
    //     OfferCompleted's tx (NOT offers.tx_hash, the creation tx) — that's the
    //     gap. Idempotent via the sales transaction_hash unique index.
    fillsSeen = fills.length
    if (fills.length > 0) {
      const built = await buildOfferFillSales(fills)
      salesUnresolved = built.unresolved
      salesParallelRedirects = built.parallelRedirects
      const ins = await insertOfferFillSales(built.rows)
      salesWritten = ins.inserted
      salesDuped = ins.duped
    }

    // 4c. stamp the fill tx onto the offer row for provenance (best-effort,
    //     only where still null). Idempotency does not depend on this.
    for (const [offerId, txHash] of fillTxByOfferId) {
      const { error } = await (supabaseAdmin as any)
        .from("offers")
        .update({ fill_tx_hash: txHash })
        .eq("collection_id", TS_COLLECTION_ID)
        .eq("offer_id", offerId)
        .is("fill_tx_hash", null)
      if (error) { console.log(`[${PIPELINE_NAME}] fill_tx_hash stamp error:`, error.message); break }
    }

    // 5. advance cursor.
    const { error: cursorWriteErr } = await (supabaseAdmin as any)
      .from("event_cursor")
      .update({ last_processed_block: targetHeight, updated_at: new Date().toISOString() })
      .eq("id", "topshot_offers")
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

  // Refresh the age of the bid each edition DISPLAYS. This lives here rather than
  // on its own cron because this route is the only writer of the timestamps it
  // reads (offers.created_at = the OfferAvailable block ts), so it is exactly when
  // the answer can have changed. It is a no-op write when nothing moved (the
  // function guards with IS DISTINCT FROM: a second call right after the first
  // wrote 0 rows), and it is deliberately OUTSIDE the try above — a failure here
  // must not mark the offer walk itself failed, and must be VISIBLE rather than
  // swallowed into a silent zero. See audit_20260914 + lib/market/bid-age.ts.
  let bidAgeRowsWritten: number | null = null
  let bidAgeError: string | null = null
  try {
    const { data, error } = await (supabaseAdmin as any).rpc("sync_edition_offers_best_offer_at")
    if (error) throw new Error(error.message)
    bidAgeRowsWritten = typeof data === "number" ? data : null
  } catch (e) {
    bidAgeError = e instanceof Error ? e.message : String(e)
    console.log(`[${PIPELINE_NAME}] best_offer_at sync failed (non-fatal):`, bidAgeError)
  }

  await logRun(startTime, offersSeen, offersWritten, fetchError === null, fetchError, cursorBefore, cursorAfter, {
    // Paired count + error, so a 0 here cannot be read as "nothing to do" when it
    // was actually "the call failed" — the null-instrument shape this repo keeps
    // finding in `rows_written`.
    bid_age_rows_written: bidAgeRowsWritten,
    bid_age_error: bidAgeError,
    pages,
    offers_written: offersWritten,
    by_type: byType,
    offers_filled: offersFilled,
    offers_cancelled: offersCancelled,
    offers_completed_same_tick: completedSameTick,
    unresolved,
    aliased_to_canonical: aliased,
    unresolved_by_type: unresolvedByType,
    resolved_via_wallet_cache: viaWalletCache,
    resolved_via_checkpoint: viaCheckpoint,
    unresolved_serial_nft_sample: unresolvedSerialSample,
    fills_seen: fillsSeen,
    sales_written: salesWritten,
    sales_duped: salesDuped,
    sales_unresolved: salesUnresolved,
    sales_parallel_redirects: salesParallelRedirects,
    duration_ms: Date.now() - startTime,
  })

  return NextResponse.json({
    ok: fetchError === null,
    pages,
    offersWritten,
    byType,
    offersFilled,
    offersCancelled,
    offersCompletedSameTick: completedSameTick,
    unresolved,
    fillsSeen,
    salesWritten,
    salesDuped,
    salesUnresolved,
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
