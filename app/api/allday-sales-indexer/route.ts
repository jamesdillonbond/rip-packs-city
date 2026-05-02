import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { fireNextPipelineStep } from "@/lib/pipeline-chain"
import { hydrateAllDayEditions, toUpsertRow } from "@/lib/editions-hydrate"
import crypto from "crypto"

// ── On-chain NFL All Day sales indexer ───────────────────────────────────────
//
// Scans Flow NFTStorefrontV2.ListingCompleted events via the Flow REST API,
// filters to AllDay NFT purchases, maps nftID → edition via wallet_moments_cache
// (with a Cadence borrowMomentNFT fallback against the buyer wallet), and
// writes dedup'd rows into the partitioned `sales` table. Sales whose buyer
// wallet no longer holds the NFT (relisted instantly) fall through to
// `unmapped_sales` for later promotion. Every run logs both the scanner and
// the edition-resolver via pipeline_runs so silent failures surface.
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const COLLECTION_SLUG = "nfl_all_day"
const PIPELINE_NAME = "allday-sales-indexer"
const RESOLVER_PIPELINE_NAME = "allday-edition-resolver"
// Flowty's NFTStorefrontV2 fork (0x3cdbb3d569211ff3) is where AllDay moments
// actually trade — the Dapper StorefrontV2 (0x4eb8a10cb9f87357) only carries
// TopShot PackNFT / Pinnacle / MFL packs. Flowty's fork also emits `nftType`
// as a plain String (not a Type), so payload parsing differs.
const STOREFRONT_EVENT = "A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted"
const FLOW_REST = "https://rest-mainnet.onflow.org"
const CHUNK_SIZE = 250
const DEFAULT_SCAN_RANGE = 50_000
const MAX_SCAN_RANGE = 100_000
const INTER_CHUNK_DELAY_MS = 75
// Cap Cadence borrow attempts per run. Flow REST shares a 20 req/s budget
// across the project, and each unresolved sale costs 1-2 script calls
// (borrow + optional getEditionData), so 5 keeps us well under the ceiling.
const CADENCE_FALLBACK_MAX = 5
const CADENCE_DELAY_MS = 150
const SCRIPT_TIMEOUT_MS = 15_000

// Addresses that appear in every Flowty purchase envelope but are never the
// buyer. Normalised to 0x + 16-hex-chars for set lookups.
const EXCLUDED_ADDRESSES = new Set<string>([
  "0x3cdbb3d569211ff3", // Flowty storefront escrow / seller
  "0x18eb4ee6b3c026d2", // Flowty fee payer
  "0xead892083b3e2c6c", // Dapper DUC co-signer
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

function unwrapCdc(node: unknown): unknown {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(unwrapCdc)
  if (typeof node !== "object") return node
  const { type, value } = node as { type?: string; value?: unknown }
  if (type !== undefined && value !== undefined) {
    switch (type) {
      case "Optional":
        return value === null ? null : unwrapCdc(value)
      case "Bool":
        return value
      case "String":
      case "Address":
      case "Path":
      case "Character":
        return value
      case "Int":
      case "UInt":
      case "Int8":
      case "Int16":
      case "Int32":
      case "Int64":
      case "Int128":
      case "Int256":
      case "UInt8":
      case "UInt16":
      case "UInt32":
      case "UInt64":
      case "UInt128":
      case "UInt256":
      case "Word8":
      case "Word16":
      case "Word32":
      case "Word64":
      case "Fix64":
      case "UFix64":
        return value
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

async function fetchEventRange(type: string, start: number, end: number): Promise<FlowEventBlock[]> {
  const url = `${FLOW_REST}/v1/events?type=${encodeURIComponent(type)}&start_height=${start}&end_height=${end}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) {
    console.log(`[allday-sales-indexer] events ${start}-${end} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
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

// Real-buyer resolution: when the storefront event payload doesn't carry an
// explicit `buyer` field, fall back to the tx's proposer / authorizers /
// payer. After filtering out the known infra addresses, whatever remains is
// the wallet that now holds the NFT.
async function fetchTxBuyers(txId: string): Promise<string[]> {
  try {
    const clean = txId.replace(/^0x/, "")
    const res = await fetch(`${FLOW_REST}/v1/transactions/${clean}`, {
      signal: AbortSignal.timeout(8000),
    })
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

// AllDay-typed borrow: the public capability at /public/AllDayNFTCollection is
// published as a `&AllDay.Collection` (the contract's concrete collection
// resource), not as the generic `&{NonFungibleToken.Collection}` interface.
// Borrowing the concrete type lets us call the AllDay-specific
// `borrowMomentNFT(id:)` accessor, which returns `&AllDay.NFT?` directly with
// editionID, serialNumber, and mintingDate fields exposed — no unsafe cast
// needed. Returns nil if the wallet doesn't hold the NFT (e.g. relisted
// instantly post-sale), in which case we fall through to unmapped_sales.
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

// Stateless edition-data fetch — used when the editions table doesn't already
// have a row for the resolved editionID. Pulls play / set / series metadata
// inline so we can upsert a populated edition without a second round trip.
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
  // Flow REST returns either a quoted base64 JSON-string body or an object
  // with `value`. Normalize: trim surrounding quotes, base64-decode, JSON.parse.
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

function buildOnChainEditionRow(
  editionID: string,
  data: Record<string, string>,
  now: string,
): Record<string, unknown> {
  const playerName = (data.playerName ?? "").trim() || null
  const setName = (data.setName ?? "").trim() || null
  const teamName = (data.teamName ?? "").trim() || null
  const numMinted = Number(data.numMinted)
  const maxMint = Number(data.maxMintSize)
  const circulation = Number.isFinite(maxMint) && maxMint > 0
    ? maxMint
    : Number.isFinite(numMinted) && numMinted > 0
    ? numMinted
    : null
  const seriesID = Number(data.seriesID)
  const setIdOnchain = Number(data.setID)
  const playIdOnchain = Number(data.playID)
  const dateRaw = data.dateOfMoment ? String(data.dateOfMoment).slice(0, 10) : null
  const gameDate = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null
  const composedName =
    playerName && setName ? `${playerName} — ${setName}` : playerName ?? setName

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

export async function POST(req: NextRequest) {
  const start = Date.now()
  const startedAt = new Date().toISOString()

  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) return unauthorized()

  const chain = req.nextUrl.searchParams.get("chain") === "true"
  const rangeParam = Number(req.nextUrl.searchParams.get("range") ?? DEFAULT_SCAN_RANGE)
  const maxRange = Math.min(Math.max(rangeParam || DEFAULT_SCAN_RANGE, CHUNK_SIZE), MAX_SCAN_RANGE)

  after(async () => {
    let rowsFound = 0
    let rowsWritten = 0
    let rowsSkipped = 0
    let cursorBefore: string | null = null
    let cursorAfter: string | null = null
    let ok = true
    let errorMsg: string | null = null
    const extra: Record<string, unknown> = {}

    // Edition-resolver counters — separate pipeline_runs row so we can monitor
    // the borrowMomentNFT path independent of the scanner's totals.
    const resolverStartedAt = new Date().toISOString()
    let resolverAttempted = 0
    let resolverResolved = 0
    let resolverSkipped = 0
    let resolverNewEditionsHydrated = 0
    let resolverNewEditionsOnchain = 0

    try {
      const { data: cursorRow, error: cursorErr } = await (supabaseAdmin as any)
        .from("event_cursor")
        .select("last_processed_block")
        .eq("id", "allday_sales")
        .single()

      if (cursorErr) {
        throw new Error(`cursor read error: ${cursorErr.message}`)
      }

      let lastBlock = Number(cursorRow?.last_processed_block ?? 0)
      const currentHeight = await getLatestSealedHeight()

      if (lastBlock === 0) {
        lastBlock = Math.max(currentHeight - maxRange, 0)
        console.log(`[allday-sales-indexer] first run, starting from block ${lastBlock}`)
      }

      cursorBefore = String(lastBlock)
      const targetHeight = Math.min(lastBlock + maxRange, currentHeight)
      cursorAfter = String(lastBlock)

      if (lastBlock >= currentHeight) {
        await fireNextPipelineStep("/api/fmv-recalc", chain)
        extra.message = "already up to date"
        return
      }

      console.log(`[allday-sales-indexer] scanning ${lastBlock + 1} → ${targetHeight} (${targetHeight - lastBlock} blocks)`)

      interface Sale {
        blockHeight: number
        blockTimestamp: string
        transactionId: string
        nftID: string
        salePrice: string
        storefrontResourceID?: string
        seller: string | null
        buyer: string | null
      }

      const sales: Sale[] = []

      let rawEventsSeen = 0
      for (let s = lastBlock + 1; s <= targetHeight; s += CHUNK_SIZE) {
        const e = Math.min(s + CHUNK_SIZE - 1, targetHeight)
        try {
          const blocks = await fetchEventRange(STOREFRONT_EVENT, s, e)
          for (const blk of blocks) {
            const bh = Number(blk.block_height)
            const bts = blk.block_timestamp
            for (const evt of blk.events ?? []) {
              rawEventsSeen++
              try {
                const raw = JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))
                const payload = unwrapCdc(raw) as Record<string, any>
                const nftTypeField = payload?.nftType
                let typeID: string | undefined
                if (typeof nftTypeField === "string") typeID = nftTypeField
                else if (nftTypeField && typeof nftTypeField === "object") {
                  const st = (nftTypeField as Record<string, unknown>).staticType
                  if (typeof st === "string") typeID = st
                  else if (st && typeof st === "object")
                    typeID = (st as Record<string, unknown>).typeID as string | undefined
                }
                if (!typeID || !typeID.includes("AllDay")) continue
                if (payload.purchased !== true) continue

                // storefrontAddress and buyer are both Optional<Address> in the
                // ListingCompleted payload — unwrapCdc resolves them to either
                // the bare address string or null. These are the canonical
                // seller/buyer for Flowty AllDay sales; commissionReceiver is
                // the Flowty fee router (0x3cdbb3d569211ff3), not the buyer.
                const sellerVal = payload.storefrontAddress
                const buyerVal = payload.buyer
                sales.push({
                  blockHeight: bh,
                  blockTimestamp: bts,
                  transactionId: evt.transaction_id,
                  nftID: String(payload.nftID),
                  salePrice: String(payload.salePrice ?? "0"),
                  storefrontResourceID: payload.storefrontResourceID
                    ? String(payload.storefrontResourceID)
                    : undefined,
                  seller: typeof sellerVal === "string" ? sellerVal : null,
                  buyer: typeof buyerVal === "string" ? buyerVal : null,
                })
              } catch (err) {
                console.log(
                  "[allday-sales-indexer] decode err:",
                  err instanceof Error ? err.message : String(err)
                )
              }
            }
          }
        } catch (err) {
          console.log(
            `[allday-sales-indexer] chunk ${s}-${e} error:`,
            err instanceof Error ? err.message : String(err)
          )
        }
        if (s + CHUNK_SIZE <= targetHeight) await delay(INTER_CHUNK_DELAY_MS)
      }

      rowsFound = sales.length
      console.log(
        `[allday-sales-indexer] contract=${STOREFRONT_EVENT} range=${lastBlock + 1}-${targetHeight} rawEvents=${rawEventsSeen} found=${sales.length}`
      )

      // Resolve nftID → edition_key (+ serial_number) via wallet_moments_cache
      const uniqueNftIds = [...new Set(sales.map((s) => s.nftID))]
      const nftToEditionKey = new Map<string, string>()
      const nftToSerial = new Map<string, number>()
      if (uniqueNftIds.length > 0) {
        for (let i = 0; i < uniqueNftIds.length; i += 500) {
          const batch = uniqueNftIds.slice(i, i + 500)
          const { data } = await (supabaseAdmin as any)
            .from("wallet_moments_cache")
            .select("moment_id, edition_key, serial_number")
            .eq("collection_id", ALLDAY_COLLECTION_ID)
            .in("moment_id", batch)
          for (const row of data ?? []) {
            if (row.edition_key) nftToEditionKey.set(row.moment_id, row.edition_key)
            const serial = Number(row.serial_number)
            if (Number.isFinite(serial) && serial > 0) nftToSerial.set(row.moment_id, serial)
          }
        }
      }

      // Cadence borrow fallback: for sales that missed wallet_moments_cache,
      // call borrowMomentNFT against the buyer wallet (authoritative from the
      // event payload). Buyer-side borrow is reliable because the buyer holds
      // the NFT post-sale by definition; the only failure mode is an instant
      // relist that moves the NFT back into a Flowty escrow before the next
      // sealed block — those fall through to unmapped_sales.
      const unresolvedSales = sales.filter((s) => !nftToEditionKey.has(s.nftID))
      const newlyResolved: Array<{
        nft_id: string
        edition_external_id: string
        serial_number: number
      }> = []
      const seen = new Set<string>()
      const editionsToHydrate = new Set<string>()
      const editionsByExternalId = new Map<string, string>() // external_id → uuid (newly inserted)

      for (const sale of unresolvedSales) {
        if (resolverAttempted >= CADENCE_FALLBACK_MAX) break
        if (seen.has(sale.nftID) || nftToEditionKey.has(sale.nftID)) continue
        seen.add(sale.nftID)
        resolverAttempted++

        // Prefer the event-payload buyer; fall back to tx authorizers/proposer
        // when the event didn't carry one (rare with Flowty's fork but possible
        // for direct storefront purchases).
        const candidates: string[] = []
        if (sale.buyer) candidates.push(normalizeAddress(sale.buyer))
        if (candidates.length === 0) {
          const txBuyers = await fetchTxBuyers(sale.transactionId)
          for (const b of txBuyers) candidates.push(b)
        }
        if (candidates.length === 0) {
          resolverSkipped++
          continue
        }

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
          } catch (err) {
            console.log(
              `[allday-sales-indexer] borrow err nft=${sale.nftID} buyer=${buyer}:`,
              err instanceof Error ? err.message : String(err)
            )
          }
          await delay(CADENCE_DELAY_MS)
        }

        if (!resolvedEditionID) {
          // Buyer no longer holds the NFT (instant relist) — fall through to
          // unmapped_sales for later promotion via promote_unmapped_sales.
          resolverSkipped++
          continue
        }

        nftToEditionKey.set(sale.nftID, resolvedEditionID)
        if (resolvedSerial > 0) nftToSerial.set(sale.nftID, resolvedSerial)
        newlyResolved.push({
          nft_id: sale.nftID,
          edition_external_id: resolvedEditionID,
          serial_number: resolvedSerial,
        })
        editionsToHydrate.add(resolvedEditionID)
        resolverResolved++
        await delay(CADENCE_DELAY_MS)
      }

      if (newlyResolved.length > 0) {
        const { error: mapErr } = await (supabaseAdmin as any)
          .from("nft_edition_map")
          .upsert(
            newlyResolved.map((r) => ({ collection_id: ALLDAY_COLLECTION_ID, ...r })),
            { onConflict: "collection_id,nft_id", ignoreDuplicates: true }
          )
        if (mapErr) {
          console.log(`[allday-sales-indexer] nft_edition_map upsert err: ${mapErr.message}`)
        }
      }

      // Resolve edition_key → edition UUID (existing rows)
      const editionKeys = [...new Set(nftToEditionKey.values())]
      const editionKeyToId = new Map<string, string>()
      if (editionKeys.length > 0) {
        for (let i = 0; i < editionKeys.length; i += 500) {
          const batch = editionKeys.slice(i, i + 500)
          const { data } = await (supabaseAdmin as any)
            .from("editions")
            .select("id, external_id")
            .eq("collection_id", ALLDAY_COLLECTION_ID)
            .in("external_id", batch)
          for (const row of data ?? []) editionKeyToId.set(row.external_id, row.id)
        }
      }

      // For newly resolved editions that aren't in the editions table yet,
      // hydrate via the AllDay GraphQL relay first; if that returns ok=false
      // (relay hasn't ingested the edition yet), fall back to a stateless
      // on-chain getEditionData call. Either way, upsert and pick up the UUID.
      const missingExternalIds = [...editionsToHydrate].filter((k) => !editionKeyToId.has(k))
      if (missingExternalIds.length > 0) {
        const now = new Date().toISOString()
        const upsertRows: Record<string, unknown>[] = []
        let hydratedHits: HydratedHit[] = []
        try {
          const hydrated = await hydrateAllDayEditions(missingExternalIds)
          for (const r of hydrated) {
            if (r.ok) {
              upsertRows.push(toUpsertRow(r))
              hydratedHits.push({ external_id: r.external_id, ok: true })
              resolverNewEditionsHydrated++
            } else {
              hydratedHits.push({ external_id: r.external_id, ok: false })
            }
          }
        } catch (err) {
          console.log(
            `[allday-sales-indexer] hydrateAllDayEditions err:`,
            err instanceof Error ? err.message : String(err)
          )
        }

        const stillMissing = missingExternalIds.filter(
          (k) => !hydratedHits.some((h) => h.external_id === k && h.ok)
        )
        for (const editionID of stillMissing) {
          try {
            const data = (await runScript(GET_EDITION_DATA_SCRIPT, [
              { type: "UInt64", value: editionID },
            ])) as Record<string, string> | null
            if (data && typeof data === "object") {
              upsertRows.push(buildOnChainEditionRow(editionID, data, now))
              resolverNewEditionsOnchain++
            } else {
              console.log(`[allday-sales-indexer] getEditionData nil for ${editionID}`)
            }
          } catch (err) {
            console.log(
              `[allday-sales-indexer] getEditionData err edition=${editionID}:`,
              err instanceof Error ? err.message : String(err)
            )
          }
          await delay(CADENCE_DELAY_MS)
        }

        if (upsertRows.length > 0) {
          const { data: inserted, error: upErr } = await (supabaseAdmin as any)
            .from("editions")
            .upsert(upsertRows, { onConflict: "external_id,collection_id", ignoreDuplicates: false })
            .select("id, external_id")
          if (upErr) {
            console.log(`[allday-sales-indexer] editions upsert err: ${upErr.message}`)
          }
          for (const row of inserted ?? []) {
            if (row.external_id && row.id) {
              editionKeyToId.set(row.external_id, row.id)
              editionsByExternalId.set(row.external_id, row.id)
            }
          }
        }
      }

      const salesRows: any[] = []
      const unmappedRows: any[] = []
      const unresolvedNftIds: string[] = []
      for (const s of sales) {
        const editionKey = nftToEditionKey.get(s.nftID) ?? null
        const editionId = editionKey ? editionKeyToId.get(editionKey) : null
        const price = parseFloat(s.salePrice) || 0
        if (editionId) {
          salesRows.push({
            id: crypto.randomUUID(),
            edition_id: editionId,
            collection_id: ALLDAY_COLLECTION_ID,
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
            ingested_at: new Date().toISOString(),
          })
        } else {
          unresolvedNftIds.push(s.nftID)
          const hint: Record<string, unknown> = { nft_id: s.nftID }
          if (editionKey) hint.edition_id = editionKey
          unmappedRows.push({
            id: crypto.randomUUID(),
            collection_id: ALLDAY_COLLECTION_ID,
            nft_id: s.nftID,
            serial_number: 0,
            price_usd: price,
            marketplace: "flowty",
            transaction_hash: s.transactionId,
            block_height: s.blockHeight,
            sold_at: s.blockTimestamp,
            ingested_at: new Date().toISOString(),
            source: "onchain",
            buyer_address: s.buyer,
            seller_address: s.seller,
            resolution_hint: hint,
          })
        }
      }

      // Insert resolved sales
      for (let i = 0; i < salesRows.length; i += 100) {
        const batch = salesRows.slice(i, i + 100)
        const { error } = await (supabaseAdmin as any).from("sales").insert(batch)
        if (error) {
          if (error.code === "23505") {
            // dupes — not new writes, not skipped
          } else {
            console.log("[allday-sales-indexer] sales batch insert err:", error.message)
            for (const row of batch) {
              const { error: se } = await (supabaseAdmin as any).from("sales").insert(row)
              if (!se) rowsWritten++
            }
          }
        } else {
          rowsWritten += batch.length
        }
      }

      // Insert unmapped sales (service_role only)
      for (let i = 0; i < unmappedRows.length; i += 100) {
        const batch = unmappedRows.slice(i, i + 100)
        const { error } = await (supabaseAdmin as any).from("unmapped_sales").insert(batch)
        if (error) {
          if (error.code === "23505") {
            // already recorded — don't count
          } else {
            console.log("[allday-sales-indexer] unmapped batch insert err:", error.message)
            for (const row of batch) {
              const { error: se } = await (supabaseAdmin as any).from("unmapped_sales").insert(row)
              if (!se) rowsSkipped++
            }
          }
        } else {
          rowsSkipped += batch.length
        }
      }

      // Advance cursor
      await (supabaseAdmin as any)
        .from("event_cursor")
        .update({ last_processed_block: targetHeight, updated_at: new Date().toISOString() })
        .eq("id", "allday_sales")
      cursorAfter = String(targetHeight)

      extra.blocks_scanned = targetHeight - lastBlock
      extra.cadence_resolved = resolverResolved
      extra.cadence_attempted = resolverAttempted
      extra.editions_hydrated_from_relay = resolverNewEditionsHydrated
      extra.editions_hydrated_from_chain = resolverNewEditionsOnchain
      extra.unresolved_sample = unresolvedNftIds.slice(0, 20)
      extra.elapsed_ms = Date.now() - start

      await fireNextPipelineStep("/api/fmv-recalc", chain)
    } catch (err) {
      ok = false
      errorMsg = err instanceof Error ? err.message : String(err)
      console.log(`[allday-sales-indexer] fatal:`, errorMsg)
    } finally {
      try {
        await (supabaseAdmin as any).rpc("promote_unmapped_sales", {
          p_collection_id: ALLDAY_COLLECTION_ID,
        })
      } catch (e) {
        console.log(
          `[allday-sales-indexer] promote_unmapped_sales err:`,
          e instanceof Error ? e.message : String(e)
        )
      }
      try {
        await (supabaseAdmin as any).rpc("log_pipeline_run", {
          p_pipeline: PIPELINE_NAME,
          p_started_at: startedAt,
          p_rows_found: rowsFound,
          p_rows_written: rowsWritten,
          p_rows_skipped: rowsSkipped,
          p_ok: ok,
          p_error: errorMsg,
          p_collection_slug: COLLECTION_SLUG,
          p_cursor_before: cursorBefore,
          p_cursor_after: cursorAfter,
          p_extra: Object.keys(extra).length > 0 ? extra : null,
        })
      } catch (e) {
        console.log(
          `[allday-sales-indexer] log_pipeline_run err:`,
          e instanceof Error ? e.message : String(e)
        )
      }

      // Independent observability for the borrowMomentNFT path. duration_ms
      // is a generated column on pipeline_runs, so omit it.
      try {
        const { error } = await (supabaseAdmin as any).from("pipeline_runs").insert({
          pipeline: RESOLVER_PIPELINE_NAME,
          collection_slug: COLLECTION_SLUG,
          started_at: resolverStartedAt,
          finished_at: new Date().toISOString(),
          rows_found: resolverAttempted,
          rows_written: resolverResolved,
          rows_skipped: resolverSkipped,
          ok,
          error: errorMsg,
          extra: {
            editions_hydrated_from_relay: resolverNewEditionsHydrated,
            editions_hydrated_from_chain: resolverNewEditionsOnchain,
            cadence_fallback_max: CADENCE_FALLBACK_MAX,
          },
        })
        if (error) {
          console.log(
            `[allday-edition-resolver] pipeline_runs insert error: code=${(error as any).code ?? "?"} msg=${(error.message ?? "?").slice(0, 200)}`
          )
        }
      } catch (e) {
        console.log(
          `[allday-edition-resolver] pipeline_runs insert threw: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
  })

  return NextResponse.json({ ok: true, message: "indexing started" })
}

interface HydratedHit {
  external_id: string
  ok: boolean
}

export async function GET(req: NextRequest) {
  return POST(req)
}
