import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── AllDay listing-resolution retry cron ────────────────────────────────────
//
// Drains the listing_resolution_failures queue populated by the direct
// indexer when nftID -> editions UUID resolution failed. Bumped Cadence
// fallback cap (32 vs the live indexer's 12) because this is the retry
// path — wall-clock spend on Flow REST is OK here, but cannot bleed into
// the live ingest tick.
//
// Caps retry_count at 10 to permanently retire moments that can't be
// resolved (deleted, burned, or a flow_id that doesn't map to a current
// edition). Resolved rows get resolved_at=now() and an INSERT into
// cached_listings_v2 from the saved event_payload.
//
// Bearer auth on INGEST_SECRET_TOKEN.
// Schedule via cron-job.org: */15 minutes.
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 300

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const COLLECTION_SLUG = "nfl_all_day"
const PIPELINE_NAME = "allday-listings-retry"

const FLOW_REST = "https://rest-mainnet.onflow.org"
const SCRIPT_TIMEOUT_MS = 15_000
// Bumped 32 -> 100 (full batch) on 2026-05-11. The post-AllDay-historical
// backfill (89623423) dumped ~19,600 wmc_miss_historical_backfill rows in
// 2 hours, far faster than the 32/tick budget could drain. Each Cadence
// call observes ~500-650ms wall-clock under the 150ms inter-call delay,
// so 100 calls completes in ~50-65s, well under maxDuration=300.
const CADENCE_FALLBACK_MAX_RETRY = 100
const CADENCE_DELAY_MS = 150
const RETRY_BATCH_LIMIT = 100
const RETRY_COUNT_CAP = 10

// failure_reasons treated as definitively unrecoverable IF the seller-side
// Cadence borrow ALSO returns nil. Historical wmc misses on sold-out
// AllDay moments fall in here — the seller transferred long ago, so
// borrowMomentNFT will always return nil. Bumping retry_count 10x and
// waiting 2.5h to retire them just inflates the queue.
const UNRESOLVABLE_AFTER_CADENCE_FAIL: ReadonlySet<string> = new Set([
  "wmc_miss_historical_backfill",
])
const UNRESOLVABLE_MARKER = "unresolvable_no_chain_data"

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
  if (auth !== `Bearer ${TOKEN}`) return unauthorized()

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
      // Drain RETRY_BATCH_LIMIT oldest unresolved + sub-cap rows. Exclude
      // the unresolvable-marker reason so retired rows stay out of the
      // working set.
      const { data: queueRows, error: qErr } = await (supabaseAdmin as any)
        .from("listing_resolution_failures")
        .select("id, collection_id, flow_id, listing_resource_id, event_payload, retry_count, failure_reason")
        .eq("collection_id", ALLDAY_COLLECTION_ID)
        .is("resolved_at", null)
        .neq("failure_reason", UNRESOLVABLE_MARKER)
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
      const nftToEditionExternalId = new Map<string, string>()
      for (let i = 0; i < nftIds.length; i += 500) {
        const batch = nftIds.slice(i, i + 500)
        const { data } = await (supabaseAdmin as any)
          .from("wallet_moments_cache")
          .select("moment_id, edition_key")
          .eq("collection_id", ALLDAY_COLLECTION_ID)
          .in("moment_id", batch)
        for (const row of data ?? []) {
          if (row.edition_key) nftToEditionExternalId.set(row.moment_id, row.edition_key)
        }
      }

      // Try nft_edition_map for the residual misses.
      const stillMissing = nftIds.filter((id) => !nftToEditionExternalId.has(id))
      if (stillMissing.length > 0) {
        for (let i = 0; i < stillMissing.length; i += 500) {
          const batch = stillMissing.slice(i, i + 500)
          const { data } = await (supabaseAdmin as any)
            .from("nft_edition_map")
            .select("nft_id, edition_external_id")
            .eq("collection_id", ALLDAY_COLLECTION_ID)
            .in("nft_id", batch)
          for (const row of data ?? []) {
            if (row.edition_external_id) nftToEditionExternalId.set(row.nft_id, row.edition_external_id)
          }
        }
      }

      // ── Cadence fallback (retry path uses the bumped cap) ────────────────
      // Track per-row Cadence outcome so the post-loop bookkeeping can
      // confidently mark unresolvable for the wmc_miss_historical_backfill
      // cohort (sold-out moments — seller no longer holds them, by
      // definition not on chain).
      const cadenceFailedIds = new Set<number>()
      for (const q of queue) {
        if (cadenceAttempted >= CADENCE_FALLBACK_MAX_RETRY) break
        if (nftToEditionExternalId.has(q.flow_id)) continue
        const seller = q.event_payload?.storefrontAddress
        if (!seller) continue
        cadenceAttempted++
        let resolvedThisCall = false
        try {
          const result = (await runScript(BORROW_MOMENT_SCRIPT, [
            { type: "Address", value: seller },
            { type: "UInt64", value: q.flow_id },
          ])) as Record<string, string> | null
          if (result && typeof result === "object" && result.editionID) {
            nftToEditionExternalId.set(q.flow_id, String(result.editionID))
            cadenceResolved++
            resolvedThisCall = true
          }
        } catch (err) {
          console.log(
            `[allday-listings-retry] borrow err nft=${q.flow_id} seller=${seller}:`,
            err instanceof Error ? err.message : String(err)
          )
        }
        if (!resolvedThisCall) cadenceFailedIds.add(q.id)
        await delay(CADENCE_DELAY_MS)
      }

      // edition_external_id -> editions UUID
      const editionExternalIds = [...new Set(nftToEditionExternalId.values())]
      const externalIdToUuid = new Map<string, string>()
      if (editionExternalIds.length > 0) {
        for (let i = 0; i < editionExternalIds.length; i += 500) {
          const batch = editionExternalIds.slice(i, i + 500)
          const { data } = await (supabaseAdmin as any)
            .from("editions")
            .select("id, external_id")
            .eq("collection_id", ALLDAY_COLLECTION_ID)
            .in("external_id", batch)
          for (const row of data ?? []) externalIdToUuid.set(row.external_id, row.id)
        }
      }

      // ── Resolve rows: insert into cached_listings_v2 + mark resolved ────
      const resolvedIds: number[] = []
      const insertRows: any[] = []
      const stillUnresolvedIds: number[] = []
      for (const q of queue) {
        const externalId = nftToEditionExternalId.get(q.flow_id)
        const uuid = externalId ? externalIdToUuid.get(externalId) : null
        if (!uuid) {
          stillUnresolvedIds.push(q.id)
          continue
        }
        const a = q.event_payload
        const currency = deriveCurrency(a.salePaymentVaultType)
        const salePriceNum = parseFloat(a.salePrice) || 0
        const priceUsd = isUsdEquivalent(currency) ? salePriceNum : null
        insertRows.push({
          listing_resource_id: a.listingResourceID,
          source: "direct",
          flow_id: a.nftID,
          edition_id: uuid,
          collection_id: ALLDAY_COLLECTION_ID,
          seller_address: a.storefrontAddress,
          price_usd: priceUsd,
          currency,
          custom_id: a.customID,
          listed_at: a.blockTimestamp,
          expiry_at: epochSecondsToIso(a.expiry),
          completed_at: null,
          completed_status: null,
          block_height: a.blockHeight,
          tx_hash: a.txHash,
          event_index: a.eventIndex,
        })
        resolvedIds.push(q.id)
      }

      // Upsert resolved rows into cached_listings_v2.
      for (let i = 0; i < insertRows.length; i += 100) {
        const batch = insertRows.slice(i, i + 100)
        const { error } = await (supabaseAdmin as any)
          .from("cached_listings_v2")
          .upsert(batch, { onConflict: "listing_resource_id,source", ignoreDuplicates: false })
        if (error) {
          console.log("[allday-listings-retry] v2 upsert err:", error.message)
        } else {
          rowsWritten += batch.length
        }
      }

      // Mark resolved rows.
      if (resolvedIds.length > 0) {
        const { error } = await (supabaseAdmin as any)
          .from("listing_resolution_failures")
          .update({ resolved_at: new Date().toISOString(), last_retry_at: new Date().toISOString() })
          .in("id", resolvedIds)
        if (error) console.log("[allday-listings-retry] resolved-mark err:", error.message)
        resolved = resolvedIds.length
      }

      // Bookkeeping for the stragglers. Three paths:
      //   1. Row was Cadence-attempted AND failed AND its original
      //      failure_reason is in UNRESOLVABLE_AFTER_CADENCE_FAIL ->
      //      mark unresolvable (resolved_at = now, failure_reason =
      //      UNRESOLVABLE_MARKER). The chain has spoken; no point
      //      retrying the same lookup 9 more times over 2.5h.
      //   2. Row was NOT Cadence-attempted (cap hit before this row) OR
      //      Cadence failed for a non-historical-backfill reason ->
      //      bump retry_count + last_retry_at (existing behavior).
      let unresolvableMarked = 0
      const unresolvableIds: number[] = []
      const bumpIds: number[] = []
      for (const id of stillUnresolvedIds) {
        const row = queue.find((q) => q.id === id)
        if (!row) continue
        const isHistoricalMiss = row.failure_reason
          && UNRESOLVABLE_AFTER_CADENCE_FAIL.has(row.failure_reason)
        if (cadenceFailedIds.has(id) && isHistoricalMiss) {
          unresolvableIds.push(id)
        } else {
          bumpIds.push(id)
        }
      }

      if (unresolvableIds.length > 0) {
        const nowIso = new Date().toISOString()
        const { error } = await (supabaseAdmin as any)
          .from("listing_resolution_failures")
          .update({
            failure_reason: UNRESOLVABLE_MARKER,
            resolved_at: nowIso,
            last_retry_at: nowIso,
          })
          .in("id", unresolvableIds)
        if (error) {
          console.log("[allday-listings-retry] unresolvable-mark err:", error.message)
        } else {
          unresolvableMarked = unresolvableIds.length
        }
      }

      if (bumpIds.length > 0) {
        for (const id of bumpIds) {
          const row = queue.find((q) => q.id === id)
          if (!row) continue
          const newCount = row.retry_count + 1
          const { error } = await (supabaseAdmin as any)
            .from("listing_resolution_failures")
            .update({ retry_count: newCount, last_retry_at: new Date().toISOString() })
            .eq("id", id)
          if (error) {
            console.log(`[allday-listings-retry] retry-bump err id=${id}:`, error.message)
            continue
          }
          if (newCount >= RETRY_COUNT_CAP) retryCountHitCap++
          else stillUnresolved++
        }
      }

      rowsSkipped = stillUnresolved + retryCountHitCap + unresolvableMarked
      extra.resolved = resolved
      extra.still_unresolved = stillUnresolved
      extra.retry_count_hit_cap = retryCountHitCap
      extra.unresolvable_marked = unresolvableMarked
      extra.cadence_attempted = cadenceAttempted
      extra.cadence_resolved = cadenceResolved
      extra.elapsed_ms = Date.now() - start
    } catch (err) {
      ok = false
      errorMsg = err instanceof Error ? err.message : String(err)
      console.log(`[allday-listings-retry] fatal:`, errorMsg)
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
          `[allday-listings-retry] log_pipeline_run err:`,
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
