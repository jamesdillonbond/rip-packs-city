import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { fireNextPipelineStep } from "@/lib/pipeline-chain"
import { hydrateAllDayEditions, toUpsertRow } from "@/lib/editions-hydrate"
import { decodeV1SaleTx } from "@/lib/dapper-v1-tx-decode"
import crypto from "crypto"

// ─────────────────────────────────────────────────────────────────────────────
// NFL All Day sales-history backfill — closes the native pre-indexer gap.
//
// Program: docs/handoff-2026-06-24-historical-sales-capture-program.md (priority #1)
//
// The forward allday-sales-indexer only ever walked FORWARD; its earliest
// captured native sale is block 148,653,524 (2026-04-16). Everything below that
// is un-indexed AllDay secondary-sales history. This route walks the same three
// storefront event sources BACKWARD from that ceiling toward the current spork
// floor, decoding + resolving exactly like the forward indexer, and inserts the
// missing historical sales so moment/edition pages show deep Recent Sales + FMV.
//
// FEASIBILITY (tested live 2026-06-24, NOT assumed):
//   • AllDay marketplace GQL (mechanism A in the handoff) is DEAD — both the
//     worker's Cloudflare egress and a residential IP get an nginx path-level
//     404 on public-api.nflallday.com/graphql, and the consumer endpoint is
//     CF-blocked (403). So AllDay history is recoverable only on-chain.
//   • The un-blocked current-spork REST node (rest-mainnet.onflow.org, the same
//     node the V1 decoder already uses) serves AllDay V1/V2 ListingCompleted
//     events from the current spork floor (height ~137,390,146 = 2025-12-29)
//     forward — so the window 2025-12-29 → 2026-04-16 (~11.3M blocks) is fully
//     backfillable here with NO spork-proxy. The deeper 2021→2025-12-29 tail is
//     below the spork floor → needs the operator-gated spork-proxy (separate
//     workstream; this route stops + reports when it hits the floor).
//   • Verified the capture chain end-to-end on real gap data: a 2026-05-16 V1
//     sale decoded buyer/seller/price (DUC split-sum certain) and resolved its
//     edition via on-chain borrow.
//
// SAFETY RAILS (mirrors topshot-sales-history-backfill):
//   • SYNCHRONOUS, no after()/waitUntil (those tails die silently on Vercel).
//     The platform's HARD ~300s response cap is the limiter, so the loop self-
//     budgets to ~200s and finalizes with margin.
//   • Self-throttle: >15 non-self pipeline_runs fails in the last 30 min → skip.
//   • Idempotent: dedup by transaction_hash against existing sales/unmapped + a
//     23505 row-by-row fallback. The forward indexer never wrote below block
//     148,653,524, so this backfill owns the block range exclusively →
//     REVERT is one bounded DELETE:
//       DELETE FROM sales WHERE collection_id='dee28451-…'
//         AND block_height < 148653524;  (+ same on unmapped_sales)
//   • Shares the Flow REST ~20 req/s project budget — per-decode + inter-chunk
//     delays keep it gentle.
//
// Kill switch: disable the cron (one click) OR set env
//   ALLDAY_SALES_HISTORY_BACKFILL_DISABLED=1
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic"
export const maxDuration = 300

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const COLLECTION_SLUG = "nfl_all_day"
const PIPELINE_NAME = "allday-sales-history-backfill"
const CURSOR_ID = "allday_sales_v1_backfill"

// The forward indexer's earliest captured native block (min(block_height) over
// onchain_dapper_v1/v2/onchain). The backfill walks DOWN from here. Nothing
// below this was ever indexed, so the backfill owns it exclusively.
const CEILING_INIT = 148_653_524
// Current spork floor (height of the first block the live REST node serves).
// Used as a sanity lower bound; the real stop is dynamic 404 detection so a
// future spork roll-forward can't strand the walk above the true floor.
const SPORK_FLOOR_HINT = 137_390_146

const V1_LISTING_COMPLETED = "A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted"
const V2_DAPPER_LISTING_COMPLETED = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"
const V2_FLOWTY_LISTING_COMPLETED = "A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted"

const ALLDAY_NFT_TYPE_SUFFIX = ".AllDay.NFT"
const ALLDAY_DEPOSIT_EVENT = "A.e4cf4bdc1751c65d.AllDay.Deposit"
const ALLDAY_WITHDRAW_EVENT = "A.e4cf4bdc1751c65d.AllDay.Withdraw"

const FLOW_REST = "https://rest-mainnet.onflow.org"
const CHUNK_SIZE = 250
// Blocks scanned per tick walking downward. Under the forward indexer's 50k so a
// synchronous run finishes decode+resolve+write under the ~200s budget.
const SCAN_RANGE = 30_000
const INTER_CHUNK_DELAY_MS = 60
const SCRIPT_TIMEOUT_MS = 15_000

// Per-tick work budget (synchronous response). Loop checks this between phases.
const ELAPSED_BUDGET_MS = 200_000
const HARD_CAP_MS = 250_000

// Inline-decode budgets per tick (each costs ~1 Flow REST call). Historical V1
// sales are not in cached_listings_v2, so essentially every V1 sale needs a full
// decodeV1SaleTx — the binding constraint. Generous vs the forward indexer's 25
// because this is a dedicated backfill, but still gentle on the shared budget.
const V1_TX_DECODE_MAX = 300
const V1_TX_DECODE_DELAY_MS = 60
// Cadence borrow attempts (edition resolution for cache-missed nfts). Each ~1-2
// script calls; resolution succeeds when the historical buyer still holds.
const CADENCE_FALLBACK_MAX = 120
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
function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Cadence JSON unwrap (duplicated from the forward indexer; pure helper) ─────
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

// Returns {blocks, belowFloor}. A 404 "is less than" from the REST node means we
// walked below the served spork root → signal the caller to stop (deeper history
// needs spork-proxy).
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

const BORROW_MOMENT_SCRIPT = `
import AllDay from 0xe4cf4bdc1751c65d
access(all) fun main(buyer: Address, id: UInt64): {String: String}? {
  let col = getAccount(buyer).capabilities.borrow<&AllDay.Collection>(/public/AllDayNFTCollection)
  if col == nil { return nil }
  let nft = col!.borrowMomentNFT(id: id)
  if nft == nil { return nil }
  return {
    "id": nft!.id.toString(),
    "editionID": nft!.editionID.toString(),
    "serialNumber": nft!.serialNumber.toString(),
    "mintingDate": nft!.mintingDate.toString()
  }
}
`

const GET_EDITION_DATA_SCRIPT = `
import AllDay from 0xe4cf4bdc1751c65d
access(all) fun main(editionID: UInt64): {String: String}? {
  let edOpt = AllDay.getEditionData(id: editionID)
  if edOpt == nil { return nil }
  let ed = edOpt!
  let result: {String: String} = {
    "playID": ed.playID.toString(),
    "setID": ed.setID.toString(),
    "tier": ed.tier ?? "COMMON",
    "maxMintSize": ed.maxMintSize?.toString() ?? "",
    "numMinted": ed.numMinted.toString()
  }
  let playOpt = AllDay.getPlayData(id: ed.playID)
  if playOpt != nil {
    let meta = playOpt!.metadata
    result["playerName"] = meta["playerFullName"] ?? meta["playerName"] ?? ""
    result["teamName"] = meta["teamName"] ?? ""
    result["playType"] = meta["playType"] ?? ""
    result["dateOfMoment"] = meta["dateOfMoment"] ?? ""
    result["awayTeamName"] = meta["awayTeamName"] ?? ""
    result["homeTeamName"] = meta["homeTeamName"] ?? ""
  }
  let setOpt = AllDay.getSetData(id: ed.setID)
  if setOpt != nil {
    result["setName"] = setOpt!.name
    result["seriesID"] = setOpt!.seriesID.toString()
    let seriesOpt = AllDay.getSeriesData(id: setOpt!.seriesID)
    if seriesOpt != nil {
      result["seriesName"] = seriesOpt!.name
    }
  }
  return result
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
  let raw: string
  if (typeof json === "string") raw = json
  else raw = String(json.value ?? "")
  if (!raw) return null
  const trimmed = raw.trim().replace(/^"|"$/g, "")
  const decoded = JSON.parse(Buffer.from(trimmed, "base64").toString("utf8"))
  return unwrapCdc(decoded)
}

function normalizeTier(raw: string | undefined | null): string | null {
  if (!raw) return null
  const t = String(raw).toUpperCase()
  if (t.includes("ULTIMATE")) return "ULTIMATE"
  if (t.includes("LEGENDARY")) return "LEGENDARY"
  if (t.includes("RARE")) return "RARE"
  if (t.includes("COMMON")) return "COMMON"
  return null
}

function buildOnChainEditionRow(editionID: string, data: Record<string, string>, now: string): Record<string, unknown> {
  const playerName = (data.playerName ?? "").trim() || null
  const setName = (data.setName ?? "").trim() || null
  const teamName = (data.teamName ?? "").trim() || null
  const numMinted = Number(data.numMinted)
  const maxMint = Number(data.maxMintSize)
  const circulation =
    Number.isFinite(maxMint) && maxMint > 0
      ? maxMint
      : Number.isFinite(numMinted) && numMinted > 0
        ? numMinted
        : null
  const seriesID = Number(data.seriesID)
  const setIdOnchain = Number(data.setID)
  const playIdOnchain = Number(data.playID)
  const dateRaw = data.dateOfMoment ? String(data.dateOfMoment).slice(0, 10) : null
  const gameDate = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null
  const composedName = playerName && setName ? `${playerName} — ${setName}` : playerName ?? setName
  return {
    external_id: editionID,
    collection_id: ALLDAY_COLLECTION_ID,
    collection: COLLECTION_SLUG,
    name: composedName,
    player_name: playerName,
    set_name: setName,
    team_name: teamName,
    tier: normalizeTier(data.tier),
    series: Number.isFinite(seriesID) && seriesID > 0 ? seriesID : null,
    circulation_count: circulation,
    set_id_onchain: Number.isFinite(setIdOnchain) ? setIdOnchain : null,
    play_id_onchain: Number.isFinite(playIdOnchain) ? playIdOnchain : null,
    play_type: (data.playType ?? "").trim() || null,
    game_date: gameDate,
    home_team: (data.homeTeamName ?? "").trim() || null,
    away_team: (data.awayTeamName ?? "").trim() || null,
    updated_at: now,
  }
}

type SaleSource = "v1_dapper" | "v2_dapper" | "v2_flowty"
interface Sale {
  saleSource: SaleSource
  blockHeight: number
  blockTimestamp: string
  transactionId: string
  nftID: string
  listingResourceID: string
  customID: string | null
  salePrice: string | null
  seller: string | null
  buyer: string | null
}

interface HydratedHit {
  external_id: string
  ok: boolean
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

// Scan [start,end] for the three storefront sources, returning AllDay purchased
// sales + whether we dropped below the spork floor.
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
          if (!typeId || !typeId.endsWith(ALLDAY_NFT_TYPE_SUFFIX)) continue
          if (payload.purchased !== true) continue
          sales.push({
            saleSource: "v1_dapper",
            blockHeight: bh,
            blockTimestamp: bts,
            transactionId: evt.transaction_id,
            nftID: String(payload.nftID),
            listingResourceID: String(payload.listingResourceID),
            customID: typeof payload.customID === "string" ? payload.customID : null,
            salePrice: null,
            seller: null,
            buyer: null,
          })
          counters.v1In = (counters.v1In ?? 0) + 1
        } catch {
          /* skip undecodable event */
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
          if (!typeId || !typeId.endsWith(ALLDAY_NFT_TYPE_SUFFIX)) continue
          if (payload.purchased !== true) continue
          const sellerVal = payload.storefrontAddress
          const buyerVal = payload.buyer
          sales.push({
            saleSource: "v2_flowty",
            blockHeight: bh,
            blockTimestamp: bts,
            transactionId: evt.transaction_id,
            nftID: String(payload.nftID),
            listingResourceID: String(payload.listingResourceID ?? ""),
            customID: typeof payload.customID === "string" ? payload.customID : null,
            salePrice: String(payload.salePrice ?? "0"),
            seller: typeof sellerVal === "string" ? sellerVal : null,
            buyer: typeof buyerVal === "string" ? buyerVal : null,
          })
          counters.v2FlowtyIn = (counters.v2FlowtyIn ?? 0) + 1
        } catch {
          /* skip */
        }
      }
    }

    // V2 Dapper historically carried packs (MFL/Pinnacle/TopShot PackNFT), not
    // AllDay moments — kept armed (zero-cost) in case a window surfaces one.
    for (const blk of v2d.blocks) {
      const bh = Number(blk.block_height)
      const bts = blk.block_timestamp
      for (const evt of blk.events ?? []) {
        counters.rawV2Dapper = (counters.rawV2Dapper ?? 0) + 1
        try {
          const payload = unwrapCdc(JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))) as Record<string, any>
          const typeId = extractNftTypeId(payload?.nftType)
          if (!typeId || !typeId.endsWith(ALLDAY_NFT_TYPE_SUFFIX)) continue
          if (payload.purchased !== true) continue
          sales.push({
            saleSource: "v2_dapper",
            blockHeight: bh,
            blockTimestamp: bts,
            transactionId: evt.transaction_id,
            nftID: String(payload.nftID),
            listingResourceID: String(payload.listingResourceID ?? ""),
            customID: typeof payload.customID === "string" ? payload.customID : null,
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
  // Auth: Bearer INGEST_SECRET_TOKEN (cron-job.org / GHA) OR Bearer CRON_SECRET
  // (Vercel cron — injected automatically, no secret typed by an operator). Both
  // also accepted as ?token= for browser-fired probes. Mirrors the dual-auth
  // precedent in app/api/admin/drain-topshot-misattribution (the Vercel-cron drain).
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
    process.env.ALLDAY_SALES_HISTORY_BACKFILL_DISABLED === "1" ||
    process.env.ALLDAY_SALES_HISTORY_BACKFILL_DISABLED === "true"
  if (disabled) {
    await logRun(startedAt, startedMs, true, 0, 0, 0, null, null, null, { skipped: "disabled" })
    return NextResponse.json({ ok: true, skipped: "disabled", pipeline: PIPELINE_NAME }, { status: 200 })
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "true"
  const rangeOverride = Number(req.nextUrl.searchParams.get("range") ?? SCAN_RANGE)
  const scanWindow = Math.min(Math.max(rangeOverride || SCAN_RANGE, CHUNK_SIZE), 60_000)

  // ── Self-throttle ──────────────────────────────────────────────────────────
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

  // ── Resolve the backward cursor ──────────────────────────────────────────────
  // last_processed_block = the LOWEST block already scanned. Next tick scans
  // [last_processed_block - scanRange, last_processed_block - 1]. Init = ceiling.
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

    // ── dryRun: decode a few + report, write nothing ──────────────────────────
    if (dryRun) {
      const sample: any[] = []
      for (const s of sales.slice(0, 5)) {
        if (s.saleSource === "v1_dapper") {
          const d = await decodeV1SaleTx(s.transactionId, {
            depositEventType: ALLDAY_DEPOSIT_EVENT,
            withdrawEventType: ALLDAY_WITHDRAW_EVENT,
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

    // ── V1 enrichment: price + buyer + seller via decodeV1SaleTx ───────────────
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
        depositEventType: ALLDAY_DEPOSIT_EVENT,
        withdrawEventType: ALLDAY_WITHDRAW_EVENT,
        nftId: sale.nftID,
      })
      sale.buyer = d.buyer ?? null
      sale.seller = d.seller ?? null
      if (d.priceCertain && d.priceDuc != null) sale.salePrice = String(d.priceDuc)
      else uncertainTx.set(sale.transactionId, { reason: d.priceReason, samples: d.sampleAmounts })
      await delay(V1_TX_DECODE_DELAY_MS)
    }
    // V2 Dapper buyer/seller (salePrice inline) — rare historically.
    let v2Decoded = 0
    for (const sale of v2DapperSales) {
      if (Date.now() > startedMs + ELAPSED_BUDGET_MS) break
      if (v2Decoded >= 25) break
      v2Decoded++
      const d = await decodeV1SaleTx(sale.transactionId, {
        depositEventType: ALLDAY_DEPOSIT_EVENT,
        withdrawEventType: ALLDAY_WITHDRAW_EVENT,
        nftId: sale.nftID,
      })
      sale.buyer = d.buyer ?? null
      sale.seller = d.seller ?? null
      await delay(V1_TX_DECODE_DELAY_MS)
    }

    // ── Resolve nftID → edition_key (+ serial) via wmc ─────────────────────────
    const uniqueNftIds = [...new Set(sales.map((s) => s.nftID))]
    const nftToEditionKey = new Map<string, string>()
    const nftToSerial = new Map<string, number>()
    for (let i = 0; i < uniqueNftIds.length; i += 500) {
      const batch = uniqueNftIds.slice(i, i + 500)
      const { data } = await supabaseAdmin
        .from("wallet_moments_cache")
        .select("moment_id, edition_key, serial_number")
        .eq("collection_id", ALLDAY_COLLECTION_ID)
        .in("moment_id", batch)
      for (const row of (data ?? []) as Array<{ moment_id: string; edition_key: string | null; serial_number: number | null }>) {
        if (row.edition_key) nftToEditionKey.set(row.moment_id, row.edition_key)
        const serial = Number(row.serial_number)
        if (Number.isFinite(serial) && serial > 0) nftToSerial.set(row.moment_id, serial)
      }
    }
    // Persistent nft→edition map (accumulated by the forward resolver).
    const stillUnmapped = uniqueNftIds.filter((id) => !nftToEditionKey.has(id))
    for (let i = 0; i < stillUnmapped.length; i += 500) {
      const batch = stillUnmapped.slice(i, i + 500)
      const { data } = await supabaseAdmin
        .from("nft_edition_map")
        .select("nft_id, edition_external_id, serial_number")
        .eq("collection_id", ALLDAY_COLLECTION_ID)
        .in("nft_id", batch)
      for (const row of (data ?? []) as Array<{ nft_id: string; edition_external_id: string | null; serial_number: number | null }>) {
        if (row.edition_external_id) nftToEditionKey.set(row.nft_id, row.edition_external_id)
        const serial = Number(row.serial_number)
        if (Number.isFinite(serial) && serial > 0) nftToSerial.set(row.nft_id, serial)
      }
    }

    // ── Cadence borrow fallback (succeeds when the historical buyer still holds) ─
    const newlyResolved: Array<{ nft_id: string; edition_external_id: string; serial_number: number }> = []
    const editionsToHydrate = new Set<string>()
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

      let resolvedEditionID: string | null = null
      let resolvedSerial = 0
      for (const buyer of candidates) {
        try {
          const result = (await runScript(BORROW_MOMENT_SCRIPT, [
            { type: "Address", value: buyer },
            { type: "UInt64", value: sale.nftID },
          ])) as Record<string, string> | null
          if (result && typeof result === "object" && result.editionID) {
            resolvedEditionID = String(result.editionID)
            const serial = Number(result.serialNumber)
            resolvedSerial = Number.isFinite(serial) ? serial : 0
            break
          }
        } catch {
          /* borrow failed (buyer moved the moment) — fall through to unmapped */
        }
        await delay(CADENCE_DELAY_MS)
      }
      if (!resolvedEditionID) continue
      nftToEditionKey.set(sale.nftID, resolvedEditionID)
      if (resolvedSerial > 0) nftToSerial.set(sale.nftID, resolvedSerial)
      newlyResolved.push({ nft_id: sale.nftID, edition_external_id: resolvedEditionID, serial_number: resolvedSerial })
      editionsToHydrate.add(resolvedEditionID)
      await delay(CADENCE_DELAY_MS)
    }

    if (newlyResolved.length > 0) {
      const { error: mapErr } = await supabaseAdmin
        .from("nft_edition_map")
        .upsert(
          newlyResolved.map((r) => ({ collection_id: ALLDAY_COLLECTION_ID, ...r })),
          { onConflict: "collection_id,nft_id", ignoreDuplicates: true },
        )
      if (mapErr) console.log(`[${PIPELINE_NAME}] nft_edition_map upsert err: ${mapErr.message}`)
    }

    // ── Resolve edition_key → edition UUID, hydrating missing editions ─────────
    const editionKeyToId = new Map<string, string>()
    const editionKeys = [...new Set(nftToEditionKey.values())]
    for (let i = 0; i < editionKeys.length; i += 500) {
      const batch = editionKeys.slice(i, i + 500)
      const { data } = await supabaseAdmin
        .from("editions")
        .select("id, external_id")
        .eq("collection_id", ALLDAY_COLLECTION_ID)
        .in("external_id", batch)
      for (const row of (data ?? []) as Array<{ id: string; external_id: string }>) editionKeyToId.set(row.external_id, row.id)
    }
    const missingExternalIds = [...editionsToHydrate].filter((k) => !editionKeyToId.has(k))
    if (missingExternalIds.length > 0 && Date.now() < startedMs + ELAPSED_BUDGET_MS) {
      const now = new Date().toISOString()
      const upsertRows: Record<string, unknown>[] = []
      const hydratedHits: HydratedHit[] = []
      try {
        const hydrated = await hydrateAllDayEditions(missingExternalIds)
        for (const r of hydrated) {
          if (r.ok) {
            upsertRows.push(toUpsertRow(r))
            hydratedHits.push({ external_id: r.external_id, ok: true })
          } else {
            hydratedHits.push({ external_id: r.external_id, ok: false })
          }
        }
      } catch (e) {
        console.log(`[${PIPELINE_NAME}] hydrateAllDayEditions err: ${e instanceof Error ? e.message : String(e)}`)
      }
      const stillMissing = missingExternalIds.filter((k) => !hydratedHits.some((h) => h.external_id === k && h.ok))
      for (const editionID of stillMissing) {
        if (Date.now() > startedMs + ELAPSED_BUDGET_MS) break
        try {
          const data = (await runScript(GET_EDITION_DATA_SCRIPT, [{ type: "UInt64", value: editionID }])) as Record<string, string> | null
          if (data && typeof data === "object") upsertRows.push(buildOnChainEditionRow(editionID, data, now))
        } catch {
          /* skip */
        }
        await delay(CADENCE_DELAY_MS)
      }
      if (upsertRows.length > 0) {
        const { data: inserted, error: upErr } = await supabaseAdmin
          .from("editions")
          .upsert(upsertRows, { onConflict: "external_id,collection_id", ignoreDuplicates: false })
          .select("id, external_id")
        if (upErr) console.log(`[${PIPELINE_NAME}] editions upsert err: ${upErr.message}`)
        for (const row of (inserted ?? []) as Array<{ id: string; external_id: string }>) {
          if (row.external_id && row.id) editionKeyToId.set(row.external_id, row.id)
        }
      }
    }

    // ── Build + insert sales / unmapped ────────────────────────────────────────
    const ingestedAt = new Date().toISOString()
    const salesRows: any[] = []
    const unmappedRows: any[] = []
    for (const s of sales) {
      const editionKey = nftToEditionKey.get(s.nftID) ?? null
      const editionId = editionKey ? editionKeyToId.get(editionKey) : null
      const priceCertain = !uncertainTx.has(s.transactionId)
      const price = priceCertain && s.salePrice !== null ? parseFloat(s.salePrice) || 0 : 0
      const marketplace = s.saleSource === "v2_flowty" ? "flowty" : "nflallday"
      const source =
        s.saleSource === "v1_dapper" ? "onchain_dapper_v1" : s.saleSource === "v2_dapper" ? "onchain_dapper_v2" : "onchain"

      if (editionId && priceCertain) {
        salesRows.push({
          id: crypto.randomUUID(),
          edition_id: editionId,
          collection_id: ALLDAY_COLLECTION_ID,
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
        const hint: Record<string, unknown> = { nft_id: s.nftID, sale_source: s.saleSource, backfill: "allday_v1_history" }
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
          collection_id: ALLDAY_COLLECTION_ID,
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

    // ── Advance the backward cursor ────────────────────────────────────────────
    const newLow = belowFloor ? start : start
    await supabaseAdmin
      .from("event_cursor")
      .upsert(
        { id: CURSOR_ID, last_processed_block: newLow, updated_at: new Date().toISOString() },
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
        await supabaseAdmin.rpc("promote_unmapped_sales", { p_collection_id: ALLDAY_COLLECTION_ID })
      } catch (e) {
        console.log(`[${PIPELINE_NAME}] promote err: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  if (!dryRun) {
    const cursorAfter = String(Math.max(SPORK_FLOOR_HINT, ceiling - scanWindow))
    await logRun(startedAt, startedMs, ok, rowsFound, rowsWritten, rowsSkipped, errorMsg, cursorBefore, cursorAfter, extra)
    // Resolve any newly-written unmapped rows + reprice via the existing chain.
    await fireNextPipelineStep("/api/cron/allday-resolve-unmapped", true)
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
