import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { decodeV1SaleTx } from "@/lib/dapper-v1-tx-decode"
import crypto from "crypto"

// ─────────────────────────────────────────────────────────────────────────────
// UFC Strike sales-history backfill — closes the native pre-indexer gap.
//
// Program: docs/handoff-2026-06-24-historical-sales-capture-program.md (priority #4)
//
// The forward ufc-sales-indexer only ever walked FORWARD; its earliest captured
// native sale is ~block 148,804,766. This route walks the same three storefront
// event sources BACKWARD from that ceiling toward the current spork floor,
// decoding + resolving exactly like the forward indexer, inserting the missing
// historical sales so moment/edition pages show deep Recent Sales.
//
// Mirror of allday-sales-history-backfill (see that file for full feasibility +
// safety-rail rationale). Differences are collection-specific only: UFC contract
// (0x329feb3ab062d289), nftType suffix (.UFC_NFT.NFT), and the edition-key
// derivation — UFC editions are keyed by slug(editionName, max), so the Cadence
// borrow returns [name, max, serial] and we slug it client-side (same derivation
// as seed-ufc-editions / ufc-sales-indexer). UFC is tiny (~0 forward native
// sales) so this is lowest-priority/lightweight, but mechanically identical.
//
// SAFETY RAILS (mirrors allday/topshot-sales-history-backfill):
//   • SYNCHRONOUS, no after()/waitUntil. Self-budgets to ~200s under the ~300s cap.
//   • Self-throttle on >15 recent non-self pipeline fails.
//   • Idempotent dedup on transaction_hash. REVERT is one bounded DELETE:
//       DELETE FROM sales WHERE collection_id='9b4824a8-…' AND block_height < 148804766;
//       (+ same on unmapped_sales)
//   • Dynamic spork-floor detection (404 "is less than" → stop + report).
//
// Kill switch: disable the cron OR set UFC_SALES_HISTORY_BACKFILL_DISABLED=1
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic"
export const maxDuration = 300

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const UFC_COLLECTION_ID = "9b4824a8-736d-4a96-b450-8dcc0c46b023"
const COLLECTION_SLUG = "ufc_strike"
const PIPELINE_NAME = "ufc-sales-history-backfill"
const CURSOR_ID = "ufc_sales_v1_backfill"

const CEILING_INIT = 148_804_766
const SPORK_FLOOR_HINT = 137_390_146

const V1_LISTING_COMPLETED = "A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted"
const V2_DAPPER_LISTING_COMPLETED = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"
const V2_FLOWTY_LISTING_COMPLETED = "A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted"

const UFC_NFT_TYPE_SUFFIX = ".UFC_NFT.NFT"
const UFC_DEPOSIT_EVENT = "A.329feb3ab062d289.UFC_NFT.Deposit"
const UFC_WITHDRAW_EVENT = "A.329feb3ab062d289.UFC_NFT.Withdraw"

const FLOW_REST = "https://rest-mainnet.onflow.org"
const CHUNK_SIZE = 250
const SCAN_RANGE = 40_000
const INTER_CHUNK_DELAY_MS = 60
const SCRIPT_TIMEOUT_MS = 12_000

const ELAPSED_BUDGET_MS = 200_000
const HARD_CAP_MS = 250_000

const V1_TX_DECODE_MAX = 250
const V1_TX_DECODE_DELAY_MS = 60
const CADENCE_FALLBACK_MAX = 100
const CADENCE_DELAY_MS = 90

const SATURATION_FAIL_THRESHOLD = 15

const EXCLUDED_ADDRESSES = new Set<string>([
  "0x3cdbb3d569211ff3",
  "0x18eb4ee6b3c026d2",
  "0xead892083b3e2c6c",
])

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}
function normalizeAddress(raw: string): string {
  const hex = raw.trim().toLowerCase().replace(/^0x/, "")
  return `0x${hex.padStart(16, "0")}`
}
function slugifyUfcEdition(name: string, max: number | null): string {
  const clean = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return max !== null ? `${clean}-${max}` : clean
}
function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
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
      if (!belowFloor) {
        console.log(`[${PIPELINE_NAME}] events ${start}-${end} ${type.split(".").pop()} HTTP ${res.status}: ${body}`)
      }
      return { blocks: [], belowFloor }
    }
    const json = (await res.json()) as FlowEventBlock[]
    return { blocks: Array.isArray(json) ? json : [], belowFloor: false }
  } catch (e) {
    console.log(`[${PIPELINE_NAME}] events ${start}-${end} err: ${e instanceof Error ? e.message : String(e)}`)
    return { blocks: [], belowFloor: false }
  }
}

async function fetchTxBuyers(txId: string): Promise<string[]> {
  try {
    const clean = txId.replace(/^0x/, "")
    const res = await fetch(`${FLOW_REST}/v1/transactions/${clean}`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return []
    const json = (await res.json()) as {
      proposal_key?: { address?: string }
      authorizers?: string[]
      payer?: string
    }
    const candidates = new Set<string>()
    if (json.proposal_key?.address) candidates.add(normalizeAddress(json.proposal_key.address))
    for (const a of json.authorizers ?? []) candidates.add(normalizeAddress(a))
    if (json.payer) candidates.add(normalizeAddress(json.payer))
    return Array.from(candidates).filter((a) => !EXCLUDED_ADDRESSES.has(a))
  } catch {
    return []
  }
}

const BORROW_EDITION_SCRIPT = `
import NonFungibleToken from 0x1d7e57aa55817448
import MetadataViews from 0x1d7e57aa55817448
access(all) fun main(owners: [Address], id: UInt64): [String] {
  for owner in owners {
    let col = getAccount(owner).capabilities
      .borrow<&{NonFungibleToken.Collection}>(/public/UFC_NFTCollection)
    if col == nil { continue }
    let nft = col!.borrowNFT(id)
    if nft == nil { continue }
    if let editions = nft!.resolveView(Type<MetadataViews.Editions>()) {
      let e = editions as! MetadataViews.Editions
      if e.infoList.length > 0 {
        let info = e.infoList[0]
        let name = info.name ?? ""
        let serial = info.number.toString()
        let maxStr = info.max != nil ? info.max!.toString() : ""
        return [name, maxStr, serial]
      }
    }
  }
  return []
}
`

async function runScript(code: string, args: Array<{ type: string; value: unknown }>): Promise<unknown> {
  const body = {
    script: Buffer.from(code, "utf8").toString("base64"),
    arguments: args.map((a) => Buffer.from(JSON.stringify(a), "utf8").toString("base64")),
  }
  const res = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SCRIPT_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`script HTTP ${res.status}`)
  const json = (await res.json()) as { value?: string } | string
  const b64 = typeof json === "string" ? json : String(json.value ?? "")
  if (!b64) return null
  const decoded = JSON.parse(Buffer.from(b64, "base64").toString("utf8"))
  return unwrapCdc(decoded)
}

type SaleSource = "v1_dapper" | "v2_dapper" | "v2_flowty"
interface Sale {
  saleSource: SaleSource
  blockHeight: number
  blockTimestamp: string
  transactionId: string
  nftID: string
  listingResourceID: string
  salePrice: string | null
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
    const [v1, v2d, v2f] = await Promise.all([
      fetchEventRange(V1_LISTING_COMPLETED, s, e),
      fetchEventRange(V2_DAPPER_LISTING_COMPLETED, s, e),
      fetchEventRange(V2_FLOWTY_LISTING_COMPLETED, s, e),
    ])
    if (v1.belowFloor || v2d.belowFloor || v2f.belowFloor) {
      belowFloor = true
      break
    }

    for (const blk of v1.blocks) {
      const bh = Number(blk.block_height)
      const bts = blk.block_timestamp
      for (const evt of blk.events ?? []) {
        counters.rawV1 = (counters.rawV1 ?? 0) + 1
        try {
          const payload = unwrapCdc(JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))) as Record<string, any>
          const typeId = extractNftTypeId(payload?.nftType)
          if (!typeId || !typeId.endsWith(UFC_NFT_TYPE_SUFFIX)) continue
          if (payload.purchased !== true) continue
          sales.push({
            saleSource: "v1_dapper",
            blockHeight: bh,
            blockTimestamp: bts,
            transactionId: evt.transaction_id,
            nftID: String(payload.nftID),
            listingResourceID: String(payload.listingResourceID ?? ""),
            salePrice: null,
            seller: null,
            buyer: null,
          })
          counters.v1In = (counters.v1In ?? 0) + 1
        } catch {
          /* skip */
        }
      }
    }

    for (const blk of v2f.blocks) {
      const bh = Number(blk.block_height)
      const bts = blk.block_timestamp
      for (const evt of blk.events ?? []) {
        counters.rawV2Flowty = (counters.rawV2Flowty ?? 0) + 1
        try {
          const payload = unwrapCdc(JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))) as Record<string, any>
          const typeId = extractNftTypeId(payload?.nftType)
          if (!typeId || !typeId.endsWith(UFC_NFT_TYPE_SUFFIX)) continue
          if (payload.purchased !== true) continue
          sales.push({
            saleSource: "v2_flowty",
            blockHeight: bh,
            blockTimestamp: bts,
            transactionId: evt.transaction_id,
            nftID: String(payload.nftID),
            listingResourceID: String(payload.listingResourceID ?? ""),
            salePrice: String(payload.salePrice ?? "0"),
            seller: null,
            buyer: typeof payload.commissionReceiver === "string" ? payload.commissionReceiver : null,
          })
          counters.v2FlowtyIn = (counters.v2FlowtyIn ?? 0) + 1
        } catch {
          /* skip */
        }
      }
    }

    for (const blk of v2d.blocks) {
      const bh = Number(blk.block_height)
      const bts = blk.block_timestamp
      for (const evt of blk.events ?? []) {
        counters.rawV2Dapper = (counters.rawV2Dapper ?? 0) + 1
        try {
          const payload = unwrapCdc(JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))) as Record<string, any>
          const typeId = extractNftTypeId(payload?.nftType)
          if (!typeId || !typeId.endsWith(UFC_NFT_TYPE_SUFFIX)) continue
          if (payload.purchased !== true) continue
          sales.push({
            saleSource: "v2_dapper",
            blockHeight: bh,
            blockTimestamp: bts,
            transactionId: evt.transaction_id,
            nftID: String(payload.nftID),
            listingResourceID: String(payload.listingResourceID ?? ""),
            salePrice: String(payload.salePrice ?? "0"),
            seller: null,
            buyer: null,
          })
          counters.v2DapperIn = (counters.v2DapperIn ?? 0) + 1
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
    process.env.UFC_SALES_HISTORY_BACKFILL_DISABLED === "1" ||
    process.env.UFC_SALES_HISTORY_BACKFILL_DISABLED === "true"
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

  let ceiling = CEILING_INIT
  if (!dryRun) {
    const { data: cursorRow } = await supabaseAdmin
      .from("event_cursor")
      .select("last_processed_block")
      .eq("id", CURSOR_ID)
      .maybeSingle()
    if (cursorRow && Number(cursorRow.last_processed_block) > 0) {
      ceiling = Number(cursorRow.last_processed_block)
    }
  } else {
    const c = Number(req.nextUrl.searchParams.get("ceiling") ?? CEILING_INIT)
    if (Number.isFinite(c) && c > 0) ceiling = c
  }

  const end = ceiling - 1
  const start = Math.max(SPORK_FLOOR_HINT, ceiling - scanWindow)
  const cursorBefore = String(ceiling)

  if (end < SPORK_FLOOR_HINT) {
    await logRun(startedAt, startedMs, true, 0, 0, 0, null, cursorBefore, cursorBefore, {
      note: "reached_spork_floor_hint",
      next: "deeper history (<2025-12-29) needs spork-proxy",
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
        if (s.saleSource === "v1_dapper") {
          const d = await decodeV1SaleTx(s.transactionId, {
            depositEventType: UFC_DEPOSIT_EVENT,
            withdrawEventType: UFC_WITHDRAW_EVENT,
            nftId: s.nftID,
          })
          sample.push({ src: s.saleSource, nft: s.nftID, date: s.blockTimestamp.slice(0, 10), price: d.priceDuc, certain: d.priceCertain, buyer: d.buyer, seller: d.seller })
        } else {
          sample.push({ src: s.saleSource, nft: s.nftID, date: s.blockTimestamp.slice(0, 10), price: s.salePrice, buyer: s.buyer })
        }
        await delay(V1_TX_DECODE_DELAY_MS)
      }
      return NextResponse.json(
        { ok: true, mode: "dryRun", scanned: `${start}-${end}`, blocks: end - start + 1, found: sales.length, counters, belowFloor, sample },
        { status: 200 },
      )
    }

    const v1Sales = sales.filter((s) => s.saleSource === "v1_dapper")
    const v2DapperSales = sales.filter((s) => s.saleSource === "v2_dapper")
    const uncertainTx = new Map<string, { reason: string; samples: number[] }>()
    let v1Decoded = 0
    for (const sale of v1Sales) {
      if (Date.now() > startedMs + ELAPSED_BUDGET_MS) break
      if (v1Decoded >= V1_TX_DECODE_MAX) {
        uncertainTx.set(sale.transactionId, { reason: "v1_tx_decode_budget_exhausted", samples: [] })
        continue
      }
      v1Decoded++
      const d = await decodeV1SaleTx(sale.transactionId, {
        depositEventType: UFC_DEPOSIT_EVENT,
        withdrawEventType: UFC_WITHDRAW_EVENT,
        nftId: sale.nftID,
      })
      sale.buyer = d.buyer ?? null
      sale.seller = d.seller ?? null
      if (d.priceCertain && d.priceDuc != null) sale.salePrice = String(d.priceDuc)
      else uncertainTx.set(sale.transactionId, { reason: d.priceReason, samples: d.sampleAmounts })
      await delay(V1_TX_DECODE_DELAY_MS)
    }
    let v2Decoded = 0
    for (const sale of v2DapperSales) {
      if (Date.now() > startedMs + ELAPSED_BUDGET_MS) break
      if (v2Decoded >= 25) break
      v2Decoded++
      const d = await decodeV1SaleTx(sale.transactionId, {
        depositEventType: UFC_DEPOSIT_EVENT,
        withdrawEventType: UFC_WITHDRAW_EVENT,
        nftId: sale.nftID,
      })
      sale.buyer = d.buyer ?? null
      sale.seller = d.seller ?? null
      await delay(V1_TX_DECODE_DELAY_MS)
    }

    const uniqueNftIds = [...new Set(sales.map((s) => s.nftID))]
    const nftToEditionKey = new Map<string, string>()
    const nftToSerial = new Map<string, number>()
    for (let i = 0; i < uniqueNftIds.length; i += 500) {
      const batch = uniqueNftIds.slice(i, i + 500)
      const { data } = await supabaseAdmin
        .from("wallet_moments_cache")
        .select("moment_id, edition_key, serial_number")
        .eq("collection_id", UFC_COLLECTION_ID)
        .in("moment_id", batch)
      for (const row of (data ?? []) as Array<{ moment_id: string; edition_key: string | null; serial_number: number | null }>) {
        if (row.edition_key) nftToEditionKey.set(row.moment_id, row.edition_key)
        const serial = Number(row.serial_number)
        if (Number.isFinite(serial) && serial > 0) nftToSerial.set(row.moment_id, serial)
      }
    }
    const stillUnmapped = uniqueNftIds.filter((id) => !nftToEditionKey.has(id))
    for (let i = 0; i < stillUnmapped.length; i += 500) {
      const batch = stillUnmapped.slice(i, i + 500)
      const { data } = await supabaseAdmin
        .from("nft_edition_map")
        .select("nft_id, edition_external_id, serial_number")
        .eq("collection_id", UFC_COLLECTION_ID)
        .in("nft_id", batch)
      for (const row of (data ?? []) as Array<{ nft_id: string; edition_external_id: string | null; serial_number: number | null }>) {
        if (row.edition_external_id) nftToEditionKey.set(row.nft_id, row.edition_external_id)
        const serial = Number(row.serial_number)
        if (Number.isFinite(serial) && serial > 0) nftToSerial.set(row.nft_id, serial)
      }
    }

    const newlyResolved: Array<{ nft_id: string; edition_external_id: string; serial_number: number }> = []
    const seen = new Set<string>()
    let cadenceAttempts = 0
    for (const sale of sales) {
      if (Date.now() > startedMs + ELAPSED_BUDGET_MS) break
      if (cadenceAttempts >= CADENCE_FALLBACK_MAX) break
      if (seen.has(sale.nftID) || nftToEditionKey.has(sale.nftID)) continue
      seen.add(sale.nftID)
      cadenceAttempts++

      const candidates: string[] = []
      if (sale.buyer) candidates.push(normalizeAddress(sale.buyer))
      if (candidates.length === 0) {
        for (const b of await fetchTxBuyers(sale.transactionId)) candidates.push(b)
      }
      if (candidates.length === 0) continue

      try {
        const result = (await runScript(BORROW_EDITION_SCRIPT, [
          { type: "Array", value: candidates.map((a) => ({ type: "Address", value: a })) },
          { type: "UInt64", value: sale.nftID },
        ])) as unknown[] | null
        if (Array.isArray(result) && result.length >= 3) {
          const name = String(result[0] ?? "")
          const maxStr = String(result[1] ?? "")
          const serial = Number(result[2])
          if (!name) continue
          const max = maxStr === "" ? null : Number(maxStr)
          const editionKey = slugifyUfcEdition(name, Number.isFinite(max as number) ? (max as number) : null)
          nftToEditionKey.set(sale.nftID, editionKey)
          if (Number.isFinite(serial) && serial > 0) nftToSerial.set(sale.nftID, serial)
          newlyResolved.push({ nft_id: sale.nftID, edition_external_id: editionKey, serial_number: Number.isFinite(serial) ? serial : 0 })
        }
      } catch {
        /* borrow failed (buyer moved the moment) — falls through to unmapped */
      }
      await delay(CADENCE_DELAY_MS)
    }

    if (newlyResolved.length > 0) {
      const { error: mapErr } = await supabaseAdmin
        .from("nft_edition_map")
        .upsert(
          newlyResolved.map((r) => ({ collection_id: UFC_COLLECTION_ID, ...r })),
          { onConflict: "collection_id,nft_id", ignoreDuplicates: true },
        )
      if (mapErr) console.log(`[${PIPELINE_NAME}] nft_edition_map upsert err: ${mapErr.message}`)
    }

    const editionKeyToId = new Map<string, string>()
    const editionKeys = [...new Set(nftToEditionKey.values())]
    for (let i = 0; i < editionKeys.length; i += 500) {
      const batch = editionKeys.slice(i, i + 500)
      const { data } = await supabaseAdmin
        .from("editions")
        .select("id, external_id")
        .eq("collection_id", UFC_COLLECTION_ID)
        .in("external_id", batch)
      for (const row of (data ?? []) as Array<{ id: string; external_id: string }>) editionKeyToId.set(row.external_id, row.id)
    }

    const ingestedAt = new Date().toISOString()
    const salesRows: any[] = []
    const unmappedRows: any[] = []
    for (const s of sales) {
      const editionKey = nftToEditionKey.get(s.nftID) ?? null
      const editionId = editionKey ? editionKeyToId.get(editionKey) : null
      const priceCertain = !uncertainTx.has(s.transactionId)
      const price = priceCertain && s.salePrice !== null ? parseFloat(s.salePrice) || 0 : 0
      const marketplace = s.saleSource === "v2_flowty" ? "flowty" : "ufcstrike"
      const source =
        s.saleSource === "v1_dapper" ? "onchain_dapper_v1" : s.saleSource === "v2_dapper" ? "onchain_dapper_v2" : "onchain"

      if (editionId && priceCertain) {
        salesRows.push({
          id: crypto.randomUUID(),
          edition_id: editionId,
          collection_id: UFC_COLLECTION_ID,
          collection: COLLECTION_SLUG,
          nft_id: s.nftID,
          price_usd: price,
          serial_number: nftToSerial.get(s.nftID) ?? 0,
          sold_at: s.blockTimestamp,
          marketplace,
          source,
          block_height: s.blockHeight,
          transaction_hash: s.transactionId,
          buyer_address: s.buyer,
          seller_address: s.seller,
          ingested_at: ingestedAt,
        })
      } else {
        const hint: Record<string, unknown> = { nft_id: s.nftID, sale_source: s.saleSource, backfill: "ufc_v1_history" }
        if (editionKey) hint.edition_id = editionKey
        if (!priceCertain) {
          const u = uncertainTx.get(s.transactionId)
          if (u) {
            hint.price_extraction = u.reason
            hint.sample_duc_amounts = u.samples
          }
        }
        unmappedRows.push({
          id: crypto.randomUUID(),
          collection_id: UFC_COLLECTION_ID,
          nft_id: s.nftID,
          serial_number: 0,
          price_usd: priceCertain && s.salePrice !== null ? price : 0,
          marketplace,
          transaction_hash: s.transactionId,
          block_height: s.blockHeight,
          sold_at: s.blockTimestamp,
          ingested_at: ingestedAt,
          source,
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
    extra.blocks = end - start + 1
    extra.v1_decoded = v1Decoded
    extra.cadence_attempts = cadenceAttempts
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
        await supabaseAdmin.rpc("promote_unmapped_sales", { p_collection_id: UFC_COLLECTION_ID })
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
