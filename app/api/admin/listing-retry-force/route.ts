// app/api/admin/listing-retry-force/route.ts
//
// POST /api/admin/listing-retry-force?id=<row_id>
// Authorization: Bearer <INGEST_SECRET_TOKEN | RPC_ADMIN_TOKEN>
//
// Force a single-row retry against listing_resolution_failures. Mirrors
// the resolver logic in app/api/allday-listings-retry/route.ts but for
// one row. Useful for debugging stuck rows from the /admin
// /listing-retry-queue drill-down table.
//
// AllDay-only today — the only collection currently writing to
// listing_resolution_failures. If/when Pinnacle / Golazos / UFC start
// queueing failures, this route will need a collection switch.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const maxDuration = 60
export const dynamic = "force-dynamic"

const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const FLOW_REST = "https://rest-mainnet.onflow.org"
const SCRIPT_TIMEOUT_MS = 15_000

const BORROW_MOMENT_SCRIPT = `
import AllDay from 0xe4cf4bdc1751c65d
access(all) fun main(seller: Address, id: UInt64): {String: String}? {
  let col = getAccount(seller).capabilities.borrow<&AllDay.Collection>(/public/AllDayNFTCollection)
  if col == nil { return nil }
  let nft = col!.borrowMomentNFT(id: id)
  if nft == nil { return nil }
  return {
    "id": nft!.id.toString(),
    "editionID": nft!.editionID.toString(),
    "serialNumber": nft!.serialNumber.toString()
  }
}
`

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? ""
  const ingest = process.env.INGEST_SECRET_TOKEN
  const admin = process.env.RPC_ADMIN_TOKEN
  if (ingest && auth === `Bearer ${ingest}`) return true
  if (admin && auth === `Bearer ${admin}`) return true
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
      case "Bool": case "String": case "Address": case "Path": case "Character":
        return value
      case "Int": case "UInt":
      case "Int8": case "Int16": case "Int32": case "Int64":
      case "UInt8": case "UInt16": case "UInt32": case "UInt64":
        return value
      case "Dictionary": {
        const arr = value as Array<{ key: unknown; value: unknown }>
        const out: Record<string, unknown> = {}
        for (const e of arr) out[String(unwrapCdc(e.key))] = unwrapCdc(e.value)
        return out
      }
      default:
        return value
    }
  }
  return node
}

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
  const raw = typeof json === "string" ? json : String(json.value ?? "")
  if (!raw) return null
  const trimmed = raw.trim().replace(/^"|"$/g, "")
  const decoded = JSON.parse(Buffer.from(trimmed, "base64").toString("utf8"))
  return unwrapCdc(decoded)
}

function deriveCurrency(vaultTypeId: string | undefined): string {
  if (!vaultTypeId) return "UNKNOWN"
  if (vaultTypeId.includes("DapperUtilityCoin")) return "DUC"
  if (vaultTypeId.includes("FlowUtilityToken")) return "FUT"
  if (vaultTypeId.includes("FlowToken")) return "FLOW"
  if (vaultTypeId.includes("FUSD")) return "FUSD"
  return vaultTypeId
}

function isUsdEquivalent(currency: string): boolean {
  return currency === "DUC" || currency === "FUT"
}

function epochSecondsToIso(raw: unknown): string | null {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n * 1000).toISOString()
}

interface EventPayload {
  blockHeight: number
  blockTimestamp: string
  txHash: string
  eventIndex: number
  listingResourceID: string
  storefrontAddress: string
  nftID: string
  salePrice: string
  salePaymentVaultType?: string
  customID?: string | null
  expiry?: string
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const url = new URL(req.url)
  const idParam = url.searchParams.get("id")
  if (!idParam || !/^\d+$/.test(idParam)) {
    return NextResponse.json({ error: "id (numeric) query param required" }, { status: 400 })
  }
  const id = Number(idParam)

  const { data: row, error: fetchErr } = await (supabaseAdmin as any)
    .from("listing_resolution_failures")
    .select("id, collection_id, flow_id, listing_resource_id, event_payload, retry_count, resolved_at")
    .eq("id", id)
    .maybeSingle()

  if (fetchErr) {
    return NextResponse.json({ error: `fetch: ${fetchErr.message}` }, { status: 500 })
  }
  if (!row) {
    return NextResponse.json({ error: "row not found" }, { status: 404 })
  }
  if (row.resolved_at) {
    return NextResponse.json({ ok: true, already_resolved: true, resolved_at: row.resolved_at })
  }
  if (row.collection_id !== ALLDAY_COLLECTION_ID) {
    return NextResponse.json(
      { error: `force-retry only supports AllDay today; row.collection_id=${row.collection_id}` },
      { status: 501 }
    )
  }

  const payload = row.event_payload as EventPayload
  const flowId = String(row.flow_id)

  // wmc lookup
  let externalId: string | null = null
  {
    const { data } = await (supabaseAdmin as any)
      .from("wallet_moments_cache")
      .select("edition_key")
      .eq("collection_id", ALLDAY_COLLECTION_ID)
      .eq("moment_id", flowId)
      .maybeSingle()
    if (data?.edition_key) externalId = String(data.edition_key)
  }
  // nft_edition_map fallback
  if (!externalId) {
    const { data } = await (supabaseAdmin as any)
      .from("nft_edition_map")
      .select("edition_external_id")
      .eq("collection_id", ALLDAY_COLLECTION_ID)
      .eq("nft_id", flowId)
      .maybeSingle()
    if (data?.edition_external_id) externalId = String(data.edition_external_id)
  }
  // Cadence borrow against the seller for this single row.
  let cadenceTried = false
  if (!externalId) {
    cadenceTried = true
    try {
      const result = (await runScript(BORROW_MOMENT_SCRIPT, [
        { type: "Address", value: payload.storefrontAddress },
        { type: "UInt64", value: flowId },
      ])) as Record<string, string> | null
      if (result && typeof result === "object" && result.editionID) {
        externalId = String(result.editionID)
      }
    } catch (err) {
      console.log(`[admin-listing-retry-force] borrow err id=${id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  let editionUuid: string | null = null
  if (externalId) {
    const { data } = await (supabaseAdmin as any)
      .from("editions")
      .select("id")
      .eq("collection_id", ALLDAY_COLLECTION_ID)
      .eq("external_id", externalId)
      .maybeSingle()
    if (data?.id) editionUuid = String(data.id)
  }

  const nowIso = new Date().toISOString()

  if (!editionUuid) {
    const { error: updErr } = await (supabaseAdmin as any)
      .from("listing_resolution_failures")
      .update({ retry_count: row.retry_count + 1, last_retry_at: nowIso })
      .eq("id", id)
    if (updErr) console.log(`[admin-listing-retry-force] retry-bump err: ${updErr.message}`)
    return NextResponse.json({
      ok: true,
      resolved: false,
      next_retry_count: row.retry_count + 1,
      cadence_tried: cadenceTried,
      external_id_found: externalId,
      reason: externalId ? "external_id_not_in_editions_table" : "no_external_id_resolved",
    })
  }

  // Resolved → upsert cached_listings_v2 + mark resolved.
  const currency = deriveCurrency(payload.salePaymentVaultType)
  const salePriceNum = parseFloat(payload.salePrice) || 0
  const priceUsd = isUsdEquivalent(currency) ? salePriceNum : null

  const { error: upsertErr } = await (supabaseAdmin as any)
    .from("cached_listings_v2")
    .upsert(
      [{
        listing_resource_id: payload.listingResourceID,
        source: "direct",
        flow_id: payload.nftID,
        edition_id: editionUuid,
        collection_id: ALLDAY_COLLECTION_ID,
        seller_address: payload.storefrontAddress,
        price_usd: priceUsd,
        currency,
        custom_id: payload.customID ?? null,
        listed_at: payload.blockTimestamp,
        expiry_at: epochSecondsToIso(payload.expiry),
        completed_at: null,
        completed_status: null,
        block_height: payload.blockHeight,
        tx_hash: payload.txHash,
        event_index: payload.eventIndex,
      }],
      { onConflict: "listing_resource_id,source", ignoreDuplicates: false }
    )
  if (upsertErr) {
    return NextResponse.json({ error: `v2 upsert: ${upsertErr.message}` }, { status: 500 })
  }

  const { error: markErr } = await (supabaseAdmin as any)
    .from("listing_resolution_failures")
    .update({ resolved_at: nowIso, last_retry_at: nowIso })
    .eq("id", id)
  if (markErr) console.log(`[admin-listing-retry-force] resolved-mark err: ${markErr.message}`)

  return NextResponse.json({
    ok: true,
    resolved: true,
    edition_id: editionUuid,
    external_id: externalId,
    cadence_tried: cadenceTried,
  })
}
