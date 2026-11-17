// scan-pinnacle-wallet — enumerate owned Disney Pinnacle NFTs for a wallet
// and upsert them into wallet_moments_cache. Pinnacle's edition key
// (ROYALTY_CODE:VARIANT:PRINTING) is derived from Flowty trait data, not the
// on-chain NFT struct, so we resolve edition metadata through the existing
// pinnacle_nft_map (nft_id → edition_key) table and leave edition_key null
// for ids not yet mapped — those will backfill on the next sales/listing
// cache cycle as pinnacle_nft_map grows.
//
// Auth: Bearer ${INGEST_SECRET_TOKEN}. Query: ?wallet=0x...

import { createClient } from "@supabase/supabase-js"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) {
  throw new Error("INGEST_SECRET_TOKEN env var is required")
}

const FLOW_REST = "https://rest-mainnet.onflow.org"
const PINNACLE_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("NEXT_PUBLIC_SUPABASE_URL")!
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY")!
const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

function b64ToUtf8(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder("utf-8").decode(bytes)
}

function unwrap(node: any): any {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(unwrap)
  if (typeof node !== "object") return node
  const { type, value } = node
  if (type !== undefined && value !== undefined) {
    switch (type) {
      case "Optional": return value === null ? null : unwrap(value)
      case "Array": return (value as any[]).map(unwrap)
      case "Dictionary": {
        const o: Record<string, any> = {}
        for (const kv of value as any[]) o[String(unwrap(kv.key))] = unwrap(kv.value)
        return o
      }
      case "Struct": case "Resource": case "Event": case "Contract": case "Enum": {
        const o: Record<string, any> = {}
        for (const f of (value.fields ?? [])) o[f.name] = unwrap(f.value)
        return o
      }
      default: return value
    }
  }
  return node
}

async function runCadence(code: string, args: Array<{ type: string; value: unknown }> = []): Promise<any> {
  const body = { script: btoa(code), arguments: args.map(a => btoa(JSON.stringify(a))) }
  const res = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Flow HTTP ${res.status}: ${text.slice(0, 300)}`)
  return unwrap(JSON.parse(b64ToUtf8(JSON.parse(text))))
}

const IDS_SCRIPT = `
import Pinnacle from 0xedf9df96c92f4595
import NonFungibleToken from 0x1d7e57aa55817448
access(all) fun main(addr: Address): [UInt64] {
  let acct = getAccount(addr)
  let ref = acct.capabilities.borrow<&{NonFungibleToken.Collection}>(Pinnacle.CollectionPublicPath)
  if ref == nil { return [] }
  return ref!.getIDs()
}`

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("Authorization")
  if (auth !== `Bearer ${INGEST_SECRET_TOKEN}`) return new Response("Unauthorized", { status: 401 })

  const url = new URL(req.url)
  const walletRaw = url.searchParams.get("wallet")
  if (!walletRaw || !walletRaw.startsWith("0x")) {
    return new Response(JSON.stringify({ error: "wallet param required" }), { status: 400 })
  }
  const wallet = walletRaw.toLowerCase()

  const started = Date.now()
  try {
    const idsRaw = await runCadence(IDS_SCRIPT, [{ type: "Address", value: wallet }]) as Array<string | number>
    const ids = Array.isArray(idsRaw) ? idsRaw.map(String) : []

    if (ids.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, wallet, found: 0, mapped: 0, upserted: 0, elapsed: Date.now() - started }),
        { headers: { "Content-Type": "application/json; charset=utf-8" } }
      )
    }

    // Resolve nft_id → edition_key through pinnacle_nft_map.
    const mapMap = new Map<string, string>()
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500)
      const { data } = await supabase
        .from("pinnacle_nft_map")
        .select("nft_id, edition_key")
        .in("nft_id", batch)
      for (const row of data ?? []) {
        if (row.nft_id && row.edition_key) mapMap.set(String(row.nft_id), String(row.edition_key))
      }
    }

    const now = new Date().toISOString()

    // NON-DESTRUCTIVE UPSERT (2026-08-02) — this block used to be a live
    // data-loss bug, armed but not yet fired.
    //
    // It previously built ONE uniform payload for every id containing
    //     serial_number: null, series_number: null,
    //     edition_key / player_name / set_name / tier  (null when unmapped)
    // and upserted it straight to wallet_moments_cache. A PostgREST upsert
    // compiles to INSERT ... ON CONFLICT DO UPDATE SET <every column in the
    // payload>, so each of those nulls OVERWRITES whatever is already stored.
    //
    // Why it had not bitten yet: the function threw at runtime on every call
    // from 2026-06-10 (commit acf85c04 deleted its .from() line) until the
    // 2026-08-01 repair, so it wrote nothing for ~7 weeks. It is now ACTIVE
    // again (v25), which means the next invocation against a wallet holding
    // Limited / Limited Event / Legendary / Genesis pins would have silently
    // NULLed real serial numbers. Live check at the time of this fix: 14,077
    // wmc rows sit on those serialed edition types and 0 were missing a
    // serial — i.e. the damage had not happened yet, and this prevents it.
    //
    // This function CANNOT know a serial: its Cadence script only calls
    // getIDs(), and edition metadata is resolved out of pinnacle_nft_map.
    // Serials come from the Cadence details walk in
    // lib/chains/flow/wallet-backfill-helpers.ts (runPinnacleDetailsBackfill),
    // which reads MetadataViews.Edition.number. So serial_number and
    // series_number are now OMITTED from the payload entirely — a column that
    // is absent from an upsert payload is never touched by ON CONFLICT.
    //
    // Rows are also split into two uniform batches so an UNMAPPED id can no
    // longer blank an edition_key that another pipeline already resolved.
    // Metadata is filled afterwards by the COALESCE-guarded
    // backfill_pinnacle_wmc_metadata_from_editions() RPC (the same post-pass
    // the Flow backfills use) instead of being written inline, so a NULL in
    // pinnacle_editions can never erase a good stored value.
    const mappedRows: Array<Record<string, unknown>> = []
    const unmappedRows: Array<Record<string, unknown>> = []
    for (const id of ids) {
      const editionKey = mapMap.get(id) ?? null
      if (editionKey) {
        mappedRows.push({
          wallet_address: wallet,
          collection_id: PINNACLE_COLLECTION_ID,
          moment_id: id,
          edition_key: editionKey,
          last_seen_at: now,
        })
      } else {
        // Identity + liveness only. edition_key is deliberately absent so an
        // id that pinnacle_nft_map has not mapped yet cannot blank a key.
        unmappedRows.push({
          wallet_address: wallet,
          collection_id: PINNACLE_COLLECTION_ID,
          moment_id: id,
          last_seen_at: now,
        })
      }
    }

    let upserted = 0
    for (const batch of [mappedRows, unmappedRows]) {
      for (let i = 0; i < batch.length; i += 100) {
        const chunk = batch.slice(i, i + 100)
        const { error } = await supabase
          .from("wallet_moments_cache")
          // 3-col key — wmc has no plain (wallet_address, moment_id) unique
          // index since 2026-05-06, so the old 2-col target raised 42P10 and
          // wrote nothing. rows already carry collection_id.
          .upsert(chunk, { onConflict: "wallet_address,collection_id,moment_id" })
        if (error) console.log("[scan-pinnacle] upsert err:", error.message)
        else upserted += chunk.length
      }
    }

    // COALESCE-guarded metadata post-pass (fills character_name / player_name
    // / set_name / tier / mint_count from pinnacle_editions, NULLs only).
    if (mappedRows.length > 0) {
      const { error: denormErr } = await supabase.rpc(
        "backfill_pinnacle_wmc_metadata_from_editions",
        { p_wallet_address: wallet },
      )
      if (denormErr) console.log("[scan-pinnacle] metadata denorm err:", denormErr.message)
    }

    // Opportunistic owner refresh in pinnacle_nft_map for ids we just saw.
    const ownerRows = Array.from(mapMap.keys()).map((nftId) => ({
      nft_id: nftId,
      edition_key: mapMap.get(nftId)!,
      owner: wallet,
    }))
    for (let i = 0; i < ownerRows.length; i += 200) {
      const chunk = ownerRows.slice(i, i + 200)
      const { error } = await supabase
        .from("pinnacle_nft_map")
        .upsert(chunk, { onConflict: "nft_id" })
      if (error) console.log("[scan-pinnacle] nft_map owner err:", error.message)
    }

    return new Response(JSON.stringify({
      ok: true,
      wallet,
      found: ids.length,
      mapped: mapMap.size,
      upserted,
      elapsed: Date.now() - started,
    }), { headers: { "Content-Type": "application/json; charset=utf-8" } })
  } catch (err: any) {
    console.log("[scan-pinnacle] fatal:", err.message)
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json; charset=utf-8" },
    })
  }
})
