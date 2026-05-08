import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var is required")

const FLOW_REST = "https://rest-mainnet.onflow.org"
// 2026-05-07: bumped DEFAULT_BATCH_SIZE 25 → 100 to drain the ~30,900-row
// held-moment mapping backlog from ~116 days at the prior cadence down to
// ~1 week. Per-call latency is ~430ms (150ms sleep + ~280ms script), so
// 100 ids/run = ~43s of work — well under the 300s function ceiling.
// Cron-job.org schedule (every 2h → every 30m) is configured separately
// by Trevor; that lever is not in this file.
const DEFAULT_BATCH_SIZE = 100
const INTER_CALL_DELAY_MS = 150

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("NEXT_PUBLIC_SUPABASE_URL") ?? ""
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY") ?? ""
const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

// v8: fixed Cadence compile bug — init was referencing `rawTypeInfo` which is
// a local in main(), not a visible identifier inside the struct init scope.
// That caused every script to fail with Error Code 1101 (observed across 3
// v7 cron runs logged in pipeline_runs). Changed to reference the init param.
const RESOLVE_SCRIPT = `
import Pinnacle from 0xedf9df96c92f4595
import NonFungibleToken from 0x1d7e57aa55817448
import MetadataViews from 0x1d7e57aa55817448

access(all) struct Resolved {
    access(all) let nftID: UInt64
    access(all) let royaltyCode: String?
    access(all) let variant: String?
    access(all) let printing: UInt64?
    access(all) let setName: String?
    access(all) let editionKey: String?
    access(all) let rawRoyaltyCodeType: String?

    init(
        nftID: UInt64,
        royaltyCode: String?,
        variant: String?,
        printing: UInt64?,
        setName: String?,
        editionKey: String?,
        rawRoyaltyCodeType: String?
    ) {
        self.nftID = nftID
        self.royaltyCode = royaltyCode
        self.variant = variant
        self.printing = printing
        self.setName = setName
        self.editionKey = editionKey
        self.rawRoyaltyCodeType = rawRoyaltyCodeType
    }
}

access(all) fun main(nftID: UInt64, ownerAddress: Address): Resolved {
    let account = getAccount(ownerAddress)
    let collectionCap = account.capabilities.get<&{NonFungibleToken.Collection}>(Pinnacle.CollectionPublicPath)
    if !collectionCap.check() {
        return Resolved(nftID: nftID, royaltyCode: nil, variant: nil, printing: nil, setName: nil, editionKey: nil, rawRoyaltyCodeType: "no_capability")
    }
    let collection = collectionCap.borrow()!
    let nftRef = collection.borrowNFT(nftID)
    if nftRef == nil {
        return Resolved(nftID: nftID, royaltyCode: nil, variant: nil, printing: nil, setName: nil, editionKey: nil, rawRoyaltyCodeType: "borrow_nil")
    }
    let nft = nftRef!
    var royaltyCode: String? = nil
    var variant: String? = nil
    var printing: UInt64? = nil
    var setName: String? = nil
    var rawTypeInfo: String? = nil
    if let traits = MetadataViews.getTraits(nft) {
        for trait in traits.traits {
            if trait.name == "RoyaltyCodes" {
                rawTypeInfo = trait.value.getType().identifier
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
            } else if trait.name == "SetName" {
                if let s = trait.value as? String { setName = s }
            }
        }
    }
    var editionKey: String? = nil
    if royaltyCode != nil && variant != nil && printing != nil {
        editionKey = royaltyCode!.concat(":").concat(variant!).concat(":").concat(printing!.toString())
    }
    return Resolved(nftID: nftID, royaltyCode: royaltyCode, variant: variant, printing: printing, setName: setName, editionKey: editionKey, rawRoyaltyCodeType: rawTypeInfo)
}
`.trim()

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

interface Target { nft_id: string; owner: string }
interface ResolvedPair { nft_id: string; edition_key: string; owner: string }

async function loadBatch(limit: number): Promise<Target[]> {
  const { data, error } = await supabase.from("pinnacle_unresolved_with_owner").select("nft_id, owner").limit(limit)
  if (error) throw new Error(`load batch: ${error.message}`)
  return (data ?? []) as Target[]
}

function extractEditionKey(raw: unknown): string | null {
  const envelope = raw as { type?: string; value?: unknown }
  if (!envelope || typeof envelope !== "object") return null
  const structValue = envelope.value as { fields?: Array<{ name: string; value: unknown }> } | undefined
  const fields = structValue?.fields
  if (!Array.isArray(fields)) return null
  for (const f of fields) {
    if (f.name !== "editionKey") continue
    const outer = f.value as { type?: string; value?: unknown } | null
    if (!outer) return null
    if (outer.type === "Optional") {
      const inner = outer.value as { type?: string; value?: unknown } | null
      if (!inner) return null
      const v = inner.value
      return typeof v === "string" && v.length > 0 ? v : null
    }
    const v = outer.value
    return typeof v === "string" && v.length > 0 ? v : null
  }
  return null
}

async function logPipelineRun(args: { pipeline: string; startedAt: string; rowsFound?: number; rowsWritten?: number; rowsSkipped?: number; ok: boolean; error?: string | null; collectionSlug?: string | null; extra?: Record<string, unknown> }): Promise<void> {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabase as any).rpc("log_pipeline_run", {
      p_pipeline: args.pipeline, p_started_at: args.startedAt,
      p_rows_found: args.rowsFound ?? 0, p_rows_written: args.rowsWritten ?? 0, p_rows_skipped: args.rowsSkipped ?? 0,
      p_ok: args.ok, p_error: args.error ?? null, p_collection_slug: args.collectionSlug ?? null,
      p_cursor_before: null, p_cursor_after: null, p_extra: args.extra ?? null,
    })
  } catch (e) { console.log(`[${args.pipeline}] log_pipeline_run err: ${e instanceof Error ? e.message : String(e)}`) }
}

async function resolveOne(nftId: string, owner: string): Promise<string | null> {
  const body = { script: btoa(RESOLVE_SCRIPT), arguments: [btoa(JSON.stringify({ type: "UInt64", value: String(nftId) })), btoa(JSON.stringify({ type: "Address", value: owner }))] }
  const res = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`script HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  const rawText = (await res.text()).trim().replace(/^"|"$/g, "")
  const decoded = JSON.parse(atob(rawText))
  return extractEditionKey(decoded)
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("Authorization") ?? ""
  if (auth !== `Bearer ${INGEST_SECRET_TOKEN}`) return new Response("Unauthorized", { status: 401 })
  const url = new URL(req.url)
  const batchParam = Number(url.searchParams.get("batch") ?? DEFAULT_BATCH_SIZE)
  const batchSize = Math.max(1, Math.min(200, Number.isFinite(batchParam) ? batchParam : DEFAULT_BATCH_SIZE))
  const started = Date.now()
  const startedAtIso = new Date(started).toISOString()
  try {
    const targets = await loadBatch(batchSize)
    if (targets.length === 0) {
      await logPipelineRun({ pipeline: "pinnacle-nft-resolver", startedAt: startedAtIso, ok: true, collectionSlug: "disney-pinnacle", extra: { message: "no unresolved", elapsed_ms: Date.now() - started, resolver_version: 9 } })
      return new Response(JSON.stringify({ ok: true, message: "no unresolved" }), { headers: { "Content-Type": "application/json" } })
    }
    let queried = 0, nullEdition = 0, failed = 0
    const failures: Array<{ nft_id: string; reason: string }> = []
    const resolvedPairs: ResolvedPair[] = []
    for (const t of targets) {
      queried++
      try {
        const editionKey = await resolveOne(t.nft_id, t.owner)
        if (editionKey == null) { nullEdition++; continue }
        resolvedPairs.push({ nft_id: t.nft_id, edition_key: editionKey, owner: t.owner })
      } catch (err) {
        failed++
        const reason = err instanceof Error ? err.message : String(err)
        failures.push({ nft_id: t.nft_id, reason: reason.slice(0, 200) })
      }
      await sleep(INTER_CALL_DELAY_MS)
    }
    let batchResult: Record<string, unknown> | null = null
    let batchErr: string | null = null
    if (resolvedPairs.length > 0) {
      const { data, error } = await supabase.rpc("pinnacle_upsert_nft_map_batch", { p_rows: resolvedPairs })
      if (error) batchErr = error.message
      else batchResult = data as Record<string, unknown>
    }
    let stubResult: Record<string, unknown> | null = null
    try {
      const { data: stub, error: stubErr } = await supabase.rpc("backfill_missing_pinnacle_editions")
      if (!stubErr) stubResult = stub as Record<string, unknown>
    } catch {}
    const { data: promoted, error: promoteErr } = await supabase.rpc("backfill_pinnacle_sale_editions")
    const elapsed = Date.now() - started
    const rowsWrittenEffective = typeof batchResult?.inserted === "number" ? (batchResult.inserted as number) + (typeof batchResult.updated === "number" ? (batchResult.updated as number) : 0) : 0
    await logPipelineRun({
      pipeline: "pinnacle-nft-resolver", startedAt: startedAtIso,
      rowsFound: queried, rowsWritten: rowsWrittenEffective, rowsSkipped: nullEdition + failed,
      ok: true, collectionSlug: "disney-pinnacle",
      extra: {
        resolver_version: 9, resolved_pairs_count: resolvedPairs.length,
        batch_upsert_result: batchResult, batch_upsert_err: batchErr,
        stub_editions_result: stubResult, null_edition: nullEdition,
        failed, failures: failures.slice(0, 10),
        promoted: promoted ?? null, promote_err: promoteErr ? promoteErr.message : null,
        elapsed_ms: elapsed, batch_size: batchSize,
      },
    })
    return new Response(JSON.stringify({ ok: true, queried, resolved: resolvedPairs.length, nullEdition, failed, batch_upsert: batchResult, stub_editions: stubResult, promoted: promoted ?? null, elapsed }), { headers: { "Content-Type": "application/json" } })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await logPipelineRun({ pipeline: "pinnacle-nft-resolver", startedAt: startedAtIso, ok: false, error: msg, collectionSlug: "disney-pinnacle", extra: { elapsed_ms: Date.now() - started, resolver_version: 9 } })
    return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500, headers: { "Content-Type": "application/json" } })
  }
})
