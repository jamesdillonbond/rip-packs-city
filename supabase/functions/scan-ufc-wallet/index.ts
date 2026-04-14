// supabase/functions/scan-ufc-wallet/index.ts
//
// Supabase Edge Function: scans a wallet for UFC Strike NFTs.
// POST { wallet: "0x..." } with ?token=<INGEST_SECRET_TOKEN>
//
// Steps:
//   1. Run a Cadence script that returns owned UFC_NFT IDs
//   2. For each ID, run a per-NFT metadata script to extract edition name,
//      serial, circulation, and fighter trait
//   3. Slugify (editionName, circulation) → external_id, match to editions row,
//      upsert wallet_moments_cache
//
// Deploy: supabase functions deploy scan-ufc-wallet --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"

const UFC_COLLECTION_ID = "9b4824a8-736d-4a96-b450-8dcc0c46b023"
const FLOW_REST = "https://rest-mainnet.onflow.org"

const IDS_SCRIPT = `
import UFC_NFT from 0x329feb3ab062d289
import NonFungibleToken from 0x1d7e57aa55817448

access(all) fun main(address: Address): [UInt64] {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/UFC_NFTCollection)
  if col == nil { return [] }
  return col!.getIDs()
}
`

const METADATA_SCRIPT = `
import UFC_NFT from 0x329feb3ab062d289
import MetadataViews from 0x1d7e57aa55817448

access(all) fun main(address: Address, id: UInt64): {String: String} {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{UFC_NFT.MomentNFTCollectionPublic}>(/public/UFC_NFTCollection)
    ?? panic("No UFC collection")
  let nft = col.borrowMomentNFT(id: id) ?? panic("No moment")
  let result: {String: String} = {"nftID": id.toString()}

  if let editions = nft.resolveView(Type<MetadataViews.Editions>()) {
    let e = editions as! MetadataViews.Editions
    if e.infoList.length > 0 {
      let info = e.infoList[0]
      result["editionName"] = info.name ?? ""
      result["serial"] = info.number.toString()
      result["max"] = info.max?.toString() ?? ""
    }
  }

  if let traits = nft.resolveView(Type<MetadataViews.Traits>()) {
    let t = traits as! MetadataViews.Traits
    for trait in t.traits {
      result["trait_".concat(trait.name)] = trait.value as! String? ?? ""
    }
  }

  return result
}
`

function unwrapCdc(node: unknown): unknown {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(unwrapCdc)
  if (typeof node !== "object") return node
  const { type, value } = node as { type?: string; value?: unknown }
  if (type !== undefined && value !== undefined) {
    switch (type) {
      case "Optional": return value === null ? null : unwrapCdc(value)
      case "Array": return (value as unknown[]).map(unwrapCdc)
      case "Dictionary": {
        const out: Record<string, unknown> = {}
        for (const kv of value as Array<{ key: unknown; value: unknown }>) {
          out[String(unwrapCdc(kv.key))] = unwrapCdc(kv.value)
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
    script: btoa(code),
    arguments: args.map((a) => btoa(JSON.stringify(a))),
  }
  const res = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`script HTTP ${res.status}: ${await res.text()}`)
  const json = await res.json() as { value: string }
  const decoded = JSON.parse(atob(json.value))
  return unwrapCdc(decoded)
}

function slugify(name: string, max: number | null): string {
  const clean = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return max !== null ? `${clean}-${max}` : clean
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = typeof v === "number" ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

serve(async (req: Request) => {
  const startedAt = Date.now()

  const url = new URL(req.url)
  const urlToken = url.searchParams.get("token") ?? ""
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")
  const expected = Deno.env.get("INGEST_SECRET_TOKEN") ?? ""
  if (!expected || (urlToken !== expected && bearer !== expected)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    })
  }

  let wallet = ""
  try {
    const body = await req.json() as { wallet?: string }
    wallet = (body.wallet ?? "").trim()
  } catch { /* ignore */ }
  if (!wallet) {
    return new Response(JSON.stringify({ error: "Missing wallet" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    })
  }
  if (!wallet.startsWith("0x")) wallet = `0x${wallet}`

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  const supabase = createClient(supabaseUrl, serviceKey)

  const errors: string[] = []

  let ids: string[] = []
  try {
    const raw = await runScript(IDS_SCRIPT, [{ type: "Address", value: wallet }])
    if (Array.isArray(raw)) ids = raw.map((x) => String(x))
  } catch (err) {
    errors.push(`ids script: ${String(err)}`)
  }

  if (ids.length === 0) {
    return new Response(JSON.stringify({
      ok: true, wallet, momentsFound: 0, upserted: 0, errors,
      elapsed_ms: Date.now() - startedAt,
    }), { headers: { "Content-Type": "application/json" } })
  }

  // Load existing editions for matching.
  const { data: editionRows } = await supabase
    .from("editions")
    .select("id, external_id")
    .eq("collection_id", UFC_COLLECTION_ID)
  const externalToId = new Map<string, string>()
  for (const r of (editionRows ?? []) as Array<{ id: string; external_id: string | null }>) {
    if (r.external_id) externalToId.set(r.external_id, r.id)
  }

  interface MomentRow {
    wallet_address: string
    collection_id: string
    moment_id: string
    edition_key: string | null
    edition_id: string | null
    serial_number: number | null
    is_locked: boolean
    cached_at: string
  }

  const rows: MomentRow[] = []
  const BATCH = 20
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH)
    await Promise.all(chunk.map(async (id) => {
      try {
        const raw = await runScript(METADATA_SCRIPT, [
          { type: "Address", value: wallet },
          { type: "UInt64", value: id },
        ])
        const meta = (raw ?? {}) as Record<string, string>
        const editionName = (meta.editionName ?? "").trim()
        const max = toNum(meta.max)
        const serial = toNum(meta.serial)
        const externalId = editionName ? slugify(editionName, max) : null
        const editionId = externalId ? externalToId.get(externalId) ?? null : null

        rows.push({
          wallet_address: wallet,
          collection_id: UFC_COLLECTION_ID,
          moment_id: id,
          edition_key: externalId,
          edition_id: editionId,
          serial_number: serial,
          is_locked: false,
          cached_at: new Date().toISOString(),
        })
      } catch (err) {
        errors.push(`nft ${id}: ${String(err)}`)
      }
    }))
  }

  let upserted = 0
  const UP_CHUNK = 100
  for (let i = 0; i < rows.length; i += UP_CHUNK) {
    const batch = rows.slice(i, i + UP_CHUNK)
    const { error, count } = await supabase
      .from("wallet_moments_cache")
      .upsert(batch, { onConflict: "wallet_address,collection_id,moment_id", count: "exact" })
    if (error) {
      errors.push(`upsert ${i}: ${error.message}`)
    } else {
      upserted += count ?? batch.length
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    wallet,
    momentsFound: ids.length,
    metadataResolved: rows.length,
    upserted,
    errors: errors.slice(0, 20),
    errorCount: errors.length,
    elapsed_ms: Date.now() - startedAt,
  }), { headers: { "Content-Type": "application/json" } })
})
