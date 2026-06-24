import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { decodeTopShotSaleTx } from "@/lib/chains/flow/dapper-v1-tx-decode"
import crypto from "crypto"

// ─────────────────────────────────────────────────────────────────────────────
// Top Shot FLOWTY-venue sales-history backfill — closes the Flowty pre-indexer gap.
//
// Program: docs/handoff-2026-06-24-historical-sales-capture-program.md (priority #3)
//
// Top Shot NATIVE history is already complete (618k sales back to 2020 via the GQL
// ts_history_backfill_v1). The remaining TS gap is the FLOWTY venue: the forward
// indexer only captured TS Flowty-fork sales from 2026-03-31 onward (1,323 rows).
// This route walks the Flowty fork (A.3cdbb3d569211ff3.NFTStorefrontV2.
// ListingCompleted) BACKWARD, filtered to TopShot, from the block at ~2026-03-31
// (bisected once, cached in the cursor) down to the current spork floor
// (2025-12-29). The deep 2022→2025-12-29 Flowty tail is below the floor →
// spork-proxy (separate gated workstream; this route stops + reports at the floor).
//
// Edition resolution is holder-independent: getMintedMoment(nftID) via the
// topshot-proxy returns set.flowId:play.flowID for ANY minted moment regardless
// of who holds it now — the robust path for historical sales. Buyer/seller come
// from decodeTopShotSaleTx (TopShot.Deposit.to / TopShot.Withdraw.from); the
// Flowty event's own `buyer` is the fee router, not the real buyer.
//
// SAFETY RAILS (mirrors allday/topshot-sales-history-backfill):
//   • SYNCHRONOUS, no after()/waitUntil. Self-budgets to ~200s under the ~300s cap.
//   • Self-throttle on >15 recent non-self pipeline fails.
//   • Idempotent dedup on transaction_hash. Existing TS Flowty rows carry
//     block_height NULL (verified 2026-06-24); every backfilled row SETS
//     block_height, so REVERT is one bounded DELETE:
//       DELETE FROM sales WHERE collection_id='95f28a17-…' AND marketplace='flowty'
//         AND block_height IS NOT NULL;  (+ same on unmapped_sales)
//   • Dynamic spork-floor detection (404 "is less than" → stop + report).
//
// Kill switch: disable the cron OR set TOPSHOT_FLOWTY_HISTORY_BACKFILL_DISABLED=1
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic"
export const maxDuration = 300

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const COLLECTION_SLUG = "nba_top_shot"
const PIPELINE_NAME = "topshot-flowty-sales-history-backfill"
const CURSOR_ID = "topshot_flowty_backfill"

// The forward indexer's earliest captured TS Flowty sale is 2026-03-31; find the
// block just above that (overlap is dedup-safe) once via bisect, cache in cursor.
const CEILING_DATE_ISO = "2026-04-01T00:00:00Z"
const SPORK_FLOOR_HINT = 137_390_146

const V2_FLOWTY_LISTING_COMPLETED = "A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted"
const TOPSHOT_DEPOSIT_EVENT = "A.0b2a3299cc857e29.TopShot.Deposit"
const TOPSHOT_WITHDRAW_EVENT = "A.0b2a3299cc857e29.TopShot.Withdraw"

const FLOW_REST = "https://rest-mainnet.onflow.org"
const CHUNK_SIZE = 250
const SCAN_RANGE = 30_000
const INTER_CHUNK_DELAY_MS = 60

const ELAPSED_BUDGET_MS = 200_000
const HARD_CAP_MS = 250_000

const TX_DECODE_MAX = 250
const TX_DECODE_DELAY_MS = 60
const GET_MINTED_MAX = 250
const GET_MINTED_DELAY_MS = 70

const SATURATION_FAIL_THRESHOLD = 15

// Only trust canonical int-pair edition_keys (set:play optionally ::sub). A wmc
// row keyed to a UUID-form (inert dupe) must NOT be trusted (mirrors sales-indexer).
const CANONICAL_KEY = /^[0-9]+:[0-9]+(::[0-9]+)?$/

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}
function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function isTopShotNft(nftType: unknown): boolean {
  if (typeof nftType === "string") return nftType.includes("TopShot")
  if (nftType && typeof nftType === "object") {
    const st = (nftType as Record<string, unknown>).staticType
    if (typeof st === "string") return st.includes("TopShot")
    if (st && typeof st === "object") {
      const id = (st as Record<string, unknown>).typeID
      if (typeof id === "string") return id.includes("TopShot")
    }
  }
  return false
}

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

interface FlowEventBlock {
  block_id: string
  block_height: string
  block_timestamp: string
  events?: Array<{ type: string; transaction_id: string; payload: string; event_index: number }>
}

async function fetchEventRange(
  type: string,
  start: number,
  end: number,
): Promise<{ blocks: FlowEventBlock[]; belowFloor: boolean }> {
  const url = `${FLOW_REST}/v1/events?type=${encodeURIComponent(type)}&start_height=${start}&end_height=${end}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200)
      const belowFloor = res.status === 404 && /is less than/i.test(body)
      if (!belowFloor) console.log(`[${PIPELINE_NAME}] events ${start}-${end} HTTP ${res.status}: ${body}`)
      return { blocks: [], belowFloor }
    }
    const json = (await res.json()) as FlowEventBlock[]
    return { blocks: Array.isArray(json) ? json : [], belowFloor: false }
  } catch (e) {
    console.log(`[${PIPELINE_NAME}] events ${start}-${end} err: ${e instanceof Error ? e.message : String(e)}`)
    return { blocks: [], belowFloor: false }
  }
}

async function getLatestSealedHeight(): Promise<number> {
  const res = await fetch(`${FLOW_REST}/v1/blocks?height=sealed`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`blocks sealed HTTP ${res.status}`)
  const json = (await res.json()) as Array<{ header: { height: string } }>
  return Number(json[0]?.header?.height ?? 0)
}

async function blockTimestampMs(height: number): Promise<number | null> {
  try {
    const res = await fetch(`${FLOW_REST}/v1/blocks?height=${height}`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const json = (await res.json()) as Array<{ header?: { timestamp?: string } }>
    const ts = json[0]?.header?.timestamp
    return ts ? Date.parse(ts) : null
  } catch {
    return null
  }
}

async function bisectBlockForDate(targetIso: string): Promise<number> {
  const targetMs = Date.parse(targetIso)
  let lo = SPORK_FLOOR_HINT
  let hi = await getLatestSealedHeight()
  let iter = 0
  while (lo < hi && iter < 40) {
    iter++
    const mid = Math.floor((lo + hi) / 2)
    const ts = await blockTimestampMs(mid)
    if (ts === null) {
      lo = mid + 1
      continue
    }
    if (ts < targetMs) lo = mid + 1
    else hi = mid
  }
  return lo
}

// getMintedMoment(nftID) via the topshot-proxy → canonical edition_key + serial.
// Holder-independent, so it resolves historical sales whose buyer has since moved
// the moment. Mirrors the sales-indexer GQL fallback.
async function getMintedEdition(nftId: string): Promise<{ editionKey: string; serial: number } | null> {
  try {
    const proxyUrl = process.env.TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"
    const gqlQuery =
      "query($id:ID!){getMintedMoment(momentId:$id){data{...on MintedMoment{flowSerialNumber play{...on Play{flowID}}set{...on Set{flowId}}}}}}"
    const res = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.TS_PROXY_SECRET ? { "X-Proxy-Secret": process.env.TS_PROXY_SECRET } : {}),
      },
      body: JSON.stringify({ query: gqlQuery, variables: { id: nftId } }),
      signal: AbortSignal.timeout(12000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as any
    const data = json?.data?.getMintedMoment?.data
    const setFlowId = data?.set?.flowId
    const playFlowId = data?.play?.flowID
    if (setFlowId === undefined || setFlowId === null || !playFlowId) return null
    const serial = Number(data?.flowSerialNumber)
    return { editionKey: `${setFlowId}:${playFlowId}`, serial: Number.isFinite(serial) && serial > 0 ? serial : 0 }
  } catch {
    return null
  }
}

interface Sale {
  blockHeight: number
  blockTimestamp: string
  transactionId: string
  nftID: string
  salePrice: string
  seller: string | null
  buyer: string | null
}

async function logRun(
  startedAt: string,
  startedMs: number,
  ok: boolean,
  found: number,
  written: number,
  skipped: number,
  errMsg: string | null,
  cursorBefore: string | null,
  cursorAfter: string | null,
  extra: Record<string, unknown>,
) {
  try {
    await supabaseAdmin.rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAt,
      p_rows_found: found,
      p_rows_written: written,
      p_rows_skipped: skipped,
      p_ok: ok,
      p_error: errMsg,
      p_collection_slug: COLLECTION_SLUG,
      p_cursor_before: cursorBefore,
      p_cursor_after: cursorAfter,
      p_extra: { ...extra, duration_ms: Date.now() - startedMs },
    })
  } catch (e) {
    console.log(`[${PIPELINE_NAME}] log_pipeline_run err: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function scanRange(
  start: number,
  end: number,
  deadlineMs: number,
  counters: Record<string, number>,
): Promise<{ sales: Sale[]; belowFloor: boolean }> {
  const sales: Sale[] = []
  let belowFloor = false
  for (let s = start; s <= end; s += CHUNK_SIZE) {
    if (Date.now() > deadlineMs) break
    const e = Math.min(s + CHUNK_SIZE - 1, end)
    const res = await fetchEventRange(V2_FLOWTY_LISTING_COMPLETED, s, e)
    if (res.belowFloor) {
      belowFloor = true
      break
    }
    for (const blk of res.blocks) {
      const bh = Number(blk.block_height)
      const bts = blk.block_timestamp
      for (const evt of blk.events ?? []) {
        counters.raw = (counters.raw ?? 0) + 1
        try {
          const payload = unwrapCdc(JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))) as Record<string, any>
          if (!isTopShotNft(payload?.nftType)) continue
          if (payload.purchased !== true) continue
          sales.push({
            blockHeight: bh,
            blockTimestamp: bts,
            transactionId: evt.transaction_id,
            nftID: String(payload.nftID),
            salePrice: String(payload.salePrice ?? "0"),
            seller: null,
            buyer: null,
          })
          counters.tsIn = (counters.tsIn ?? 0) + 1
        } catch {
          /* skip */
        }
      }
    }
    if (s + CHUNK_SIZE <= end) await delay(INTER_CHUNK_DELAY_MS)
  }
  return { sales, belowFloor }
}

async function run(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  const CRON = process.env.CRON_SECRET ?? ""
  const authedOk =
    (TOKEN.length > 0 && (bearer === TOKEN || urlToken === TOKEN)) ||
    (CRON.length > 0 && (bearer === CRON || urlToken === CRON))
  if (!authedOk) return unauthorized()

  const startedAt = new Date().toISOString()
  const startedMs = Date.now()

  const disabled =
    process.env.TOPSHOT_FLOWTY_HISTORY_BACKFILL_DISABLED === "1" ||
    process.env.TOPSHOT_FLOWTY_HISTORY_BACKFILL_DISABLED === "true"
  if (disabled) {
    await logRun(startedAt, startedMs, true, 0, 0, 0, null, null, null, { skipped: "disabled" })
    return NextResponse.json({ ok: true, skipped: "disabled", pipeline: PIPELINE_NAME }, { status: 200 })
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "true"
  const rangeOverride = Number(req.nextUrl.searchParams.get("range") ?? SCAN_RANGE)
  const scanWindow = Math.min(Math.max(rangeOverride || SCAN_RANGE, CHUNK_SIZE), 60_000)

  if (!dryRun) {
    try {
      const since = new Date(Date.now() - 30 * 60 * 1000).toISOString()
      const { count } = await supabaseAdmin
        .from("pipeline_runs")
        .select("id", { count: "exact", head: true })
        .eq("ok", false)
        .neq("pipeline", PIPELINE_NAME)
        .gte("finished_at", since)
      if ((count ?? 0) > SATURATION_FAIL_THRESHOLD) {
        await logRun(startedAt, startedMs, true, 0, 0, 0, null, null, null, { skipped: "saturation", recent_fails: count })
        return NextResponse.json({ ok: true, skipped: "saturation", recent_fails: count }, { status: 200 })
      }
    } catch (e) {
      await logRun(startedAt, startedMs, false, 0, 0, 0, `throttle_read: ${e instanceof Error ? e.message : String(e)}`, null, null, {})
      return NextResponse.json({ ok: false, skipped: "throttle_error" }, { status: 200 })
    }
  }

  let ceiling: number
  if (dryRun) {
    const c = Number(req.nextUrl.searchParams.get("ceiling") ?? 0)
    ceiling = Number.isFinite(c) && c > 0 ? c : await bisectBlockForDate(CEILING_DATE_ISO)
  } else {
    const { data: cursorRow } = await supabaseAdmin
      .from("event_cursor")
      .select("last_processed_block")
      .eq("id", CURSOR_ID)
      .maybeSingle()
    if (cursorRow && Number(cursorRow.last_processed_block) > 0) {
      ceiling = Number(cursorRow.last_processed_block)
    } else {
      try {
        ceiling = await bisectBlockForDate(CEILING_DATE_ISO)
      } catch (e) {
        await logRun(startedAt, startedMs, false, 0, 0, 0, `bisect_failed: ${e instanceof Error ? e.message : String(e)}`, null, null, {})
        return NextResponse.json({ ok: false, error: "bisect_failed" }, { status: 200 })
      }
    }
  }

  const end = ceiling - 1
  const start = Math.max(SPORK_FLOOR_HINT, ceiling - scanWindow)
  const cursorBefore = String(ceiling)

  if (end < SPORK_FLOOR_HINT) {
    await logRun(startedAt, startedMs, true, 0, 0, 0, null, cursorBefore, cursorBefore, {
      note: "reached_spork_floor_hint",
      next: "deeper Flowty history (<2025-12-29) needs spork-proxy",
    })
    return NextResponse.json({ ok: true, note: "reached_spork_floor", floor: SPORK_FLOOR_HINT }, { status: 200 })
  }

  const counters: Record<string, number> = {}
  const hardDeadline = startedMs + HARD_CAP_MS
  let ok = true
  let errorMsg: string | null = null
  let rowsFound = 0
  let rowsWritten = 0
  let rowsSkipped = 0
  let belowFloor = false
  const extra: Record<string, unknown> = {}

  try {
    const scan = await scanRange(start, end, hardDeadline, counters)
    belowFloor = scan.belowFloor
    const sales = scan.sales
    rowsFound = sales.length

    if (dryRun) {
      const sample: any[] = []
      for (const s of sales.slice(0, 5)) {
        const ed = await getMintedEdition(s.nftID)
        sample.push({ nft: s.nftID, date: s.blockTimestamp.slice(0, 10), price: s.salePrice, edition: ed?.editionKey ?? null, serial: ed?.serial ?? null })
        await delay(GET_MINTED_DELAY_MS)
      }
      return NextResponse.json(
        { ok: true, mode: "dryRun", scanned: `${start}-${end}`, ceiling, blocks: end - start + 1, found: sales.length, counters, belowFloor, sample },
        { status: 200 },
      )
    }

    // ── Resolve nftID → edition_key (+ serial): wmc → nft_edition_map → getMinted ─
    const uniqueNftIds = [...new Set(sales.map((s) => s.nftID))]
    const nftToEditionKey = new Map<string, string>()
    const nftToSerial = new Map<string, number>()
    for (let i = 0; i < uniqueNftIds.length; i += 500) {
      const batch = uniqueNftIds.slice(i, i + 500)
      const { data } = await supabaseAdmin
        .from("wallet_moments_cache")
        .select("moment_id, edition_key, serial_number")
        .eq("collection_id", TOPSHOT_COLLECTION_ID)
        .in("moment_id", batch)
      for (const row of (data ?? []) as Array<{ moment_id: string; edition_key: string | null; serial_number: number | null }>) {
        if (row.edition_key && CANONICAL_KEY.test(row.edition_key)) nftToEditionKey.set(row.moment_id, row.edition_key)
        const serial = Number(row.serial_number)
        if (Number.isFinite(serial) && serial > 0) nftToSerial.set(row.moment_id, serial)
      }
    }
    const unmappedAfterWmc = uniqueNftIds.filter((id) => !nftToEditionKey.has(id))
    for (let i = 0; i < unmappedAfterWmc.length; i += 500) {
      const batch = unmappedAfterWmc.slice(i, i + 500)
      const { data } = await supabaseAdmin
        .from("nft_edition_map")
        .select("nft_id, edition_external_id, serial_number")
        .eq("collection_id", TOPSHOT_COLLECTION_ID)
        .in("nft_id", batch)
      for (const row of (data ?? []) as Array<{ nft_id: string; edition_external_id: string | null; serial_number: number | null }>) {
        if (row.edition_external_id && CANONICAL_KEY.test(row.edition_external_id)) nftToEditionKey.set(row.nft_id, row.edition_external_id)
        const serial = Number(row.serial_number)
        if (Number.isFinite(serial) && serial > 0 && !nftToSerial.has(row.nft_id)) nftToSerial.set(row.nft_id, serial)
      }
    }

    // getMintedMoment fallback (holder-independent) — budgeted.
    const newlyResolved: Array<{ nft_id: string; edition_external_id: string; serial_number: number }> = []
    let getMintedUsed = 0
    for (const id of uniqueNftIds) {
      if (Date.now() > startedMs + ELAPSED_BUDGET_MS) break
      if (getMintedUsed >= GET_MINTED_MAX) break
      if (nftToEditionKey.has(id)) continue
      getMintedUsed++
      const ed = await getMintedEdition(id)
      if (ed) {
        nftToEditionKey.set(id, ed.editionKey)
        if (ed.serial > 0 && !nftToSerial.has(id)) nftToSerial.set(id, ed.serial)
        newlyResolved.push({ nft_id: id, edition_external_id: ed.editionKey, serial_number: ed.serial })
      }
      await delay(GET_MINTED_DELAY_MS)
    }

    if (newlyResolved.length > 0) {
      const { error: mapErr } = await supabaseAdmin
        .from("nft_edition_map")
        .upsert(
          newlyResolved.map((r) => ({ collection_id: TOPSHOT_COLLECTION_ID, ...r })),
          { onConflict: "collection_id,nft_id", ignoreDuplicates: true },
        )
      if (mapErr) console.log(`[${PIPELINE_NAME}] nft_edition_map upsert err: ${mapErr.message}`)
    }

    // ── Buyer/seller via decodeTopShotSaleTx — budgeted ────────────────────────
    let txDecoded = 0
    const buyerByTx = new Map<string, { buyer: string | null; seller: string | null }>()
    for (const s of sales) {
      if (Date.now() > startedMs + ELAPSED_BUDGET_MS) break
      if (txDecoded >= TX_DECODE_MAX) break
      if (buyerByTx.has(s.transactionId)) continue
      txDecoded++
      try {
        const d = await decodeTopShotSaleTx(s.transactionId, s.nftID)
        buyerByTx.set(s.transactionId, { buyer: d.buyer ?? null, seller: d.seller ?? null })
      } catch {
        buyerByTx.set(s.transactionId, { buyer: null, seller: null })
      }
      await delay(TX_DECODE_DELAY_MS)
    }
    for (const s of sales) {
      const d = buyerByTx.get(s.transactionId)
      if (d) {
        s.buyer = d.buyer
        s.seller = d.seller
      }
    }

    // ── Resolve edition_key → edition UUID ─────────────────────────────────────
    const editionKeyToId = new Map<string, string>()
    const editionKeys = [...new Set(nftToEditionKey.values())]
    for (let i = 0; i < editionKeys.length; i += 500) {
      const batch = editionKeys.slice(i, i + 500)
      const { data } = await supabaseAdmin
        .from("editions")
        .select("id, external_id")
        .eq("collection_id", TOPSHOT_COLLECTION_ID)
        .in("external_id", batch)
      for (const row of (data ?? []) as Array<{ id: string; external_id: string }>) editionKeyToId.set(row.external_id, row.id)
    }

    // ── Build + insert sales / unmapped ────────────────────────────────────────
    const ingestedAt = new Date().toISOString()
    const salesRows: any[] = []
    const unmappedRows: any[] = []
    for (const s of sales) {
      const editionKey = nftToEditionKey.get(s.nftID) ?? null
      const editionId = editionKey ? editionKeyToId.get(editionKey) : null
      const price = parseFloat(s.salePrice) || 0

      if (editionId) {
        salesRows.push({
          id: crypto.randomUUID(),
          edition_id: editionId,
          collection_id: TOPSHOT_COLLECTION_ID,
          collection: COLLECTION_SLUG,
          nft_id: s.nftID,
          price_usd: price,
          serial_number: nftToSerial.get(s.nftID) ?? 0,
          sold_at: s.blockTimestamp,
          marketplace: "flowty",
          source: "onchain",
          block_height: s.blockHeight,
          transaction_hash: s.transactionId,
          buyer_address: s.buyer,
          seller_address: s.seller,
          ingested_at: ingestedAt,
        })
      } else {
        const hint: Record<string, unknown> = { nft_id: s.nftID, sale_source: "v2_flowty", backfill: "topshot_flowty_history" }
        if (editionKey) hint.edition_id = editionKey
        unmappedRows.push({
          id: crypto.randomUUID(),
          collection_id: TOPSHOT_COLLECTION_ID,
          nft_id: s.nftID,
          serial_number: 0,
          price_usd: price,
          marketplace: "flowty",
          transaction_hash: s.transactionId,
          block_height: s.blockHeight,
          sold_at: s.blockTimestamp,
          ingested_at: ingestedAt,
          source: "onchain",
          buyer_address: s.buyer,
          seller_address: s.seller,
          resolution_hint: hint,
        })
      }
    }

    for (let i = 0; i < salesRows.length; i += 100) {
      const batch = salesRows.slice(i, i + 100)
      const { error } = await supabaseAdmin.from("sales").insert(batch)
      if (!error) {
        rowsWritten += batch.length
      } else if (error.code === "23505" || error.message.includes("duplicate")) {
        for (const row of batch) {
          const { error: se } = await supabaseAdmin.from("sales").insert(row)
          if (!se) rowsWritten++
        }
      } else {
        console.log(`[${PIPELINE_NAME}] sales insert err: ${error.message}`)
      }
    }
    for (let i = 0; i < unmappedRows.length; i += 100) {
      const batch = unmappedRows.slice(i, i + 100)
      const { error } = await supabaseAdmin.from("unmapped_sales").insert(batch)
      if (!error) {
        rowsSkipped += batch.length
      } else if (error.code === "23505" || error.message.includes("duplicate")) {
        for (const row of batch) {
          const { error: se } = await supabaseAdmin.from("unmapped_sales").insert(row)
          if (!se) rowsSkipped++
        }
      } else {
        console.log(`[${PIPELINE_NAME}] unmapped insert err: ${error.message}`)
      }
    }

    await supabaseAdmin
      .from("event_cursor")
      .upsert(
        { id: CURSOR_ID, last_processed_block: start, updated_at: new Date().toISOString() },
        { onConflict: "id" },
      )

    extra.scanned = `${start}-${end}`
    extra.ceiling = ceiling
    extra.blocks = end - start + 1
    extra.get_minted_used = getMintedUsed
    extra.tx_decoded = txDecoded
    extra.editions_resolved = newlyResolved.length
    extra.below_floor = belowFloor
    Object.assign(extra, counters)
  } catch (err) {
    ok = false
    errorMsg = err instanceof Error ? err.message : String(err)
    console.log(`[${PIPELINE_NAME}] fatal: ${errorMsg}`)
  } finally {
    if (!dryRun) {
      try {
        await supabaseAdmin.rpc("promote_unmapped_sales", { p_collection_id: TOPSHOT_COLLECTION_ID })
      } catch (e) {
        console.log(`[${PIPELINE_NAME}] promote err: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  if (!dryRun) {
    const cursorAfter = String(Math.max(SPORK_FLOOR_HINT, ceiling - scanWindow))
    await logRun(startedAt, startedMs, ok, rowsFound, rowsWritten, rowsSkipped, errorMsg, cursorBefore, cursorAfter, extra)
  }

  return NextResponse.json(
    {
      ok,
      pipeline: PIPELINE_NAME,
      found: rowsFound,
      sales_written: rowsWritten,
      unmapped_written: rowsSkipped,
      below_floor: belowFloor,
      next_ceiling: Math.max(SPORK_FLOOR_HINT, ceiling - scanWindow),
      error: errorMsg,
    },
    { status: ok ? 200 : 500 },
  )
}

export async function POST(req: NextRequest) {
  return run(req)
}
export async function GET(req: NextRequest) {
  return run(req)
}
