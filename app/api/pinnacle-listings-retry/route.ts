import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── Pinnacle listing-resolution retry cron ──────────────────────────────────
//
// Drains the listing_resolution_failures queue populated by the Pinnacle
// direct indexer when nftID -> edition_key resolution failed. Bumped Cadence
// fallback cap (40 vs the live indexer's 12) — wall clock spend on Flow REST
// is OK here, it cannot bleed into the live ingest tick.
//
// Resolution = the derived edition_key is KNOWN (present in pinnacle_editions,
// where Pinnacle editions actually live, or — rarely — in editions). When the
// key maps to an editions UUID we also backfill cached_listings_v2.edition_id
// in place (the indexer writes the row with edition_id NULL); for the common
// pinnacle_editions-only case there is no UUID to write, but the failure is
// still resolved. Marks the failures row resolved_at = NOW().
//
// Caps retry_count at 10 to permanently retire moments that can't be resolved
// (e.g. the seller transferred before we got here, the contract surface stopped
// exposing the trait, or the edition isn't in pinnacle_editions OR editions yet).
//
// Bearer auth on INGEST_SECRET_TOKEN.
// Schedule via cron-job.org: */15 minutes.
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 300

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const PINNACLE_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
const COLLECTION_SLUG = "disney_pinnacle"
const PIPELINE_NAME = "pinnacle-listings-retry"

const FLOW_REST = "https://rest-mainnet.onflow.org"
const SCRIPT_TIMEOUT_MS = 15_000
const CADENCE_FALLBACK_MAX_RETRY = 40
const CADENCE_DELAY_MS = 150
const RETRY_BATCH_LIMIT = 100
const RETRY_COUNT_CAP = 10

// Single-NFT Pinnacle borrow — identical to the indexer's script. Returns
// the composite edition_key (royaltyCode:variant:printing) and serial when
// the seller still holds the NFT and the three required traits are present.
// Returns nil otherwise (transferred, capability missing, traits absent).
const BORROW_PINNACLE_NFT_SCRIPT = `
import NonFungibleToken from 0x1d7e57aa55817448
import MetadataViews from 0x1d7e57aa55817448
import Pinnacle from 0xedf9df96c92f4595

access(all) fun main(addr: Address, id: UInt64): {String: String}? {
    let acct = getAccount(addr)
    let cap = acct.capabilities.get<&{NonFungibleToken.Collection}>(/public/PinnacleCollection)
    if !cap.check() { return nil }
    let col = cap.borrow()
    if col == nil { return nil }
    let nftRef = col!.borrowNFT(id)
    if nftRef == nil { return nil }
    let nft = nftRef!

    var royaltyCode: String? = nil
    var variant: String? = nil
    var printing: UInt64? = nil
    if let traits = MetadataViews.getTraits(nft) {
        for trait in traits.traits {
            if trait.name == "RoyaltyCodes" {
                if let arr = trait.value as? [String] {
                    if arr.length > 0 { royaltyCode = arr[0] }
                }
            } else if trait.name == "Variant" {
                if let v = trait.value as? String { variant = v }
            } else if trait.name == "Printing" {
                if let p = trait.value as? Int { printing = UInt64(p) }
                else if let p2 = trait.value as? UInt64 { printing = p2 }
                else if let p3 = trait.value as? Int32 { printing = UInt64(p3) }
                else if let p4 = trait.value as? UInt32 { printing = UInt64(p4) }
            }
        }
    }

    if royaltyCode == nil || variant == nil || printing == nil { return nil }
    let editionKey = royaltyCode!.concat(":").concat(variant!).concat(":").concat(printing!.toString())

    var serial: UInt64? = nil
    if let editions = MetadataViews.getEditions(nft) {
        if editions.infoList.length > 0 {
            serial = editions.infoList[0].number
        }
    }

    return {
        "editionKey": editionKey,
        "serialNumber": serial == nil ? "" : serial!.toString()
    }
}
`

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
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
      case "Dictionary": {
        const arr = value as Array<{ key: unknown; value: unknown }>
        const out: Record<string, unknown> = {}
        for (const entry of arr) {
          const k = unwrapCdc(entry.key)
          const v = unwrapCdc(entry.value)
          out[String(k)] = v
        }
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
  let raw: string
  if (typeof json === "string") raw = json
  else raw = String(json.value ?? "")
  if (!raw) return null
  const trimmed = raw.trim().replace(/^"|"$/g, "")
  const decoded = JSON.parse(Buffer.from(trimmed, "base64").toString("utf8"))
  return unwrapCdc(decoded)
}

interface QueuedFailure {
  id: number
  collection_id: string
  flow_id: string
  listing_resource_id: string
  event_payload: {
    blockHeight: number
    blockTimestamp: string
    txHash: string
    eventIndex: number
    listingResourceID: string
    storefrontAddress: string
    nftID: string
    salePrice: string
    salePaymentVaultType: string | undefined
    customID: string | null
    expiry: string | undefined
  }
  retry_count: number
  failure_reason: string | null
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) return unauthorized()

  const startedAt = new Date().toISOString()
  const start = Date.now()
  const extra: Record<string, unknown> = {}
  let ok = true
  let errorMsg: string | null = null
  let rowsFound = 0
  let rowsWritten = 0
  let rowsSkipped = 0

  after(async () => {
    let resolved = 0
    let stillUnresolved = 0
    let retryCountHitCap = 0
    let cadenceAttempted = 0
    let cadenceResolved = 0

    try {
      const { data: queueRows, error: qErr } = await (supabaseAdmin as any)
        .from("listing_resolution_failures")
        .select("id, collection_id, flow_id, listing_resource_id, event_payload, retry_count, failure_reason")
        .eq("collection_id", PINNACLE_COLLECTION_ID)
        .is("resolved_at", null)
        .lt("retry_count", RETRY_COUNT_CAP)
        .order("first_seen_at", { ascending: true })
        .limit(RETRY_BATCH_LIMIT)

      if (qErr) throw new Error(`queue fetch: ${qErr.message}`)
      const queue: QueuedFailure[] = (queueRows as QueuedFailure[]) ?? []
      rowsFound = queue.length

      if (queue.length === 0) {
        extra.empty_queue = true
        return
      }

      // ── wmc batch lookup first (free, fast) ──────────────────────────────
      const nftIds = [...new Set(queue.map((q) => q.flow_id))]
      const nftToEditionKey = new Map<string, string>()
      for (let i = 0; i < nftIds.length; i += 500) {
        const batch = nftIds.slice(i, i + 500)
        const { data } = await (supabaseAdmin as any)
          .from("pinnacle_nft_map")
          .select("nft_id, edition_key")
          .in("nft_id", batch)
        for (const row of data ?? []) {
          if (row.edition_key) nftToEditionKey.set(String(row.nft_id), String(row.edition_key))
        }
      }

      const stillMissing = nftIds.filter((id) => !nftToEditionKey.has(id))
      if (stillMissing.length > 0) {
        for (let i = 0; i < stillMissing.length; i += 500) {
          const batch = stillMissing.slice(i, i + 500)
          const { data } = await (supabaseAdmin as any)
            .from("wallet_moments_cache")
            .select("moment_id, edition_key")
            .eq("collection_id", PINNACLE_COLLECTION_ID)
            .in("moment_id", batch)
          for (const row of data ?? []) {
            if (row.edition_key) nftToEditionKey.set(String(row.moment_id), String(row.edition_key))
          }
        }
      }

      // ── Cadence fallback (retry path uses the bumped cap) ────────────────
      for (const q of queue) {
        if (cadenceAttempted >= CADENCE_FALLBACK_MAX_RETRY) break
        if (nftToEditionKey.has(q.flow_id)) continue
        const seller = q.event_payload?.storefrontAddress
        if (!seller) continue
        cadenceAttempted++
        try {
          const result = (await runScript(BORROW_PINNACLE_NFT_SCRIPT, [
            { type: "Address", value: seller },
            { type: "UInt64", value: q.flow_id },
          ])) as Record<string, string> | null
          if (result && typeof result === "object" && result.editionKey) {
            nftToEditionKey.set(q.flow_id, String(result.editionKey))
            cadenceResolved++
          }
        } catch (err) {
          console.log(
            `[pinnacle-listings-retry] borrow err nft=${q.flow_id} seller=${seller}:`,
            err instanceof Error ? err.message : String(err)
          )
        }
        await delay(CADENCE_DELAY_MS)
      }

      // edition_key resolution against BOTH edition tables. Pinnacle editions
      // live in pinnacle_editions, NOT editions, and cached_listings_v2.edition_id
      // is a UUID FK to editions.id — so for the vast majority of Pinnacle rows
      // there is no UUID to backfill. A pinnacle_editions hit still means the
      // edition is KNOWN, so the failure is resolved even though edition_id stays
      // null. The prior editions-only lookup could never resolve these and bumped
      // every one to the retry cap.
      const editionKeys = [...new Set(nftToEditionKey.values())]
      const editionKeyToUuid = new Map<string, string>()
      const knownEditionKeys = new Set<string>()
      if (editionKeys.length > 0) {
        for (let i = 0; i < editionKeys.length; i += 500) {
          const batch = editionKeys.slice(i, i + 500)
          const [edRes, pinRes] = await Promise.all([
            (supabaseAdmin as any)
              .from("editions")
              .select("id, external_id")
              .eq("collection_id", PINNACLE_COLLECTION_ID)
              .in("external_id", batch),
            (supabaseAdmin as any)
              .from("pinnacle_editions")
              .select("edition_key")
              .in("edition_key", batch),
          ])
          for (const row of edRes?.data ?? []) {
            editionKeyToUuid.set(row.external_id, row.id)
            knownEditionKeys.add(row.external_id)
          }
          for (const row of pinRes?.data ?? []) knownEditionKeys.add(String(row.edition_key))
        }
      }

      // ── Resolve rows: UPDATE the existing cached_listings_v2 row in place
      //    + mark the failures row resolved. The Pinnacle indexer wrote the
      //    v2 row with edition_id=NULL on the first pass, so retry's job is
      //    to backfill that one column without touching listed_at /
      //    completed_at / price_usd / etc.
      const resolvedIds: number[] = []
      const stillUnresolvedIds: number[] = []
      for (const q of queue) {
        const editionKey = nftToEditionKey.get(q.flow_id)
        const uuid = editionKey ? editionKeyToUuid.get(editionKey) : null
        const known = !!editionKey && knownEditionKeys.has(editionKey)
        if (!known) {
          // edition_key still in neither table (or never derived) — keep retrying.
          stillUnresolvedIds.push(q.id)
          continue
        }
        // Backfill edition_id only when we actually have an editions UUID; for
        // pinnacle_editions-only hits there is nothing to write, but the failure
        // is genuinely resolved (the edition is known).
        if (uuid) {
          const { error: updErr } = await (supabaseAdmin as any)
            .from("cached_listings_v2")
            .update({ edition_id: uuid })
            .eq("listing_resource_id", q.listing_resource_id)
            .eq("source", "direct")
          if (updErr) {
            console.log(
              `[pinnacle-listings-retry] v2 update err lrid=${q.listing_resource_id}:`,
              updErr.message
            )
            stillUnresolvedIds.push(q.id)
            continue
          }
          rowsWritten++
        }
        resolvedIds.push(q.id)
      }

      if (resolvedIds.length > 0) {
        const nowIso = new Date().toISOString()
        const { error } = await (supabaseAdmin as any)
          .from("listing_resolution_failures")
          .update({ resolved_at: nowIso, last_retry_at: nowIso })
          .in("id", resolvedIds)
        if (error) console.log("[pinnacle-listings-retry] resolved-mark err:", error.message)
        resolved = resolvedIds.length
      }

      // Bump retry_count on the stragglers. RETRY_COUNT_CAP retires the row
      // permanently — no Pinnacle equivalent of AllDay's historical-backfill
      // short-circuit today since failure_reason values here aren't tied to
      // a backfill cohort that's known-unrecoverable.
      for (const id of stillUnresolvedIds) {
        const row = queue.find((q) => q.id === id)
        if (!row) continue
        const newCount = row.retry_count + 1
        const { error } = await (supabaseAdmin as any)
          .from("listing_resolution_failures")
          .update({ retry_count: newCount, last_retry_at: new Date().toISOString() })
          .eq("id", id)
        if (error) {
          console.log(`[pinnacle-listings-retry] retry-bump err id=${id}:`, error.message)
          continue
        }
        if (newCount >= RETRY_COUNT_CAP) retryCountHitCap++
        else stillUnresolved++
      }

      rowsSkipped = stillUnresolved + retryCountHitCap
      extra.resolved = resolved
      extra.still_unresolved = stillUnresolved
      extra.retry_count_hit_cap = retryCountHitCap
      extra.cadence_attempted = cadenceAttempted
      extra.cadence_resolved = cadenceResolved
      extra.elapsed_ms = Date.now() - start
    } catch (err) {
      ok = false
      errorMsg = err instanceof Error ? err.message : String(err)
      console.log(`[pinnacle-listings-retry] fatal:`, errorMsg)
    } finally {
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
          p_cursor_before: null,
          p_cursor_after: null,
          p_extra: Object.keys(extra).length > 0 ? extra : null,
        })
      } catch (e) {
        console.log(
          `[pinnacle-listings-retry] log_pipeline_run err:`,
          e instanceof Error ? e.message : String(e)
        )
      }
    }
  })

  return NextResponse.json({ ok: true, message: "retry queued" })
}

export async function GET(req: NextRequest) {
  return POST(req)
}
