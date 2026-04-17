// scan-pinnacle-wallet — enumerate owned Disney Pinnacle NFTs for a wallet
// and upsert them into wallet_moments_cache. Pinnacle's edition key
// (ROYALTY_CODE:VARIANT:PRINTING) is derived from Flowty trait data, not the
// on-chain NFT struct, so we resolve edition metadata through the existing
// pinnacle_nft_map (nft_id → edition_key) table and leave edition_key null
// for ids not yet mapped — those will backfill on the next sales/listing
// cache cycle as pinnacle_nft_map grows.
//
// Auth: Bearer rippackscity2026. Query: ?wallet=0x...

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

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
  if (auth !== "Bearer rippackscity2026") return new Response("Unauthorized", { status: 401 })

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

    // Pull edition metadata for any edition_keys we found.
    const editionKeys = [...new Set(Array.from(mapMap.values()))]
    const edMap = new Map<string, any>()
    for (let i = 0; i < editionKeys.length; i += 500) {
      const batch = editionKeys.slice(i, i + 500)
      const { data } = await supabase
        .from("pinnacle_editions")
        .select("id, character_name, set_name, variant_type, franchise")
        .in("id", batch)
      for (const row of data ?? []) edMap.set(String(row.id), row)
    }

    const now = new Date().toISOString()
    const rows = ids.map((id) => {
      const editionKey = mapMap.get(id) ?? null
      const ed = editionKey ? edMap.get(editionKey) : null
      return {
        wallet_address: wallet,
        moment_id: id,
        edition_key: editionKey,
        serial_number: null,
        player_name: ed?.character_name ?? null,
        set_name: ed?.set_name ?? null,
        tier: ed?.variant_type ?? null,
        series_number: null,
        collection_id: PINNACLE_COLLECTION_ID,
        last_seen_at: now,
      }
    })

    let upserted = 0
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100)
      const { error } = await supabase
        .from("wallet_moments_cache")
        .upsert(chunk, { onConflict: "wallet_address,moment_id" })
      if (error) console.log("[scan-pinnacle] upsert err:", error.message)
      else upserted += chunk.length
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
