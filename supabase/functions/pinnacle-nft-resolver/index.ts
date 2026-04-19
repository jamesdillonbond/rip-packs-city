// pinnacle-nft-resolver — drains pinnacle_sales rows where edition_id IS NULL
// by combining ownership snapshots (pinnacle_ownership_snapshots) with a
// Cadence script that reconstructs the edition_key from the NFT's traits.
//
// Per invocation:
//   1. Pull up to BATCH_SIZE (nft_id, owner) pairs from
//      pinnacle_unresolved_with_owner (a view that joins ownership snapshots
//      against unresolved sales).
//   2. For each pair, POST resolve-pinnacle-nft.cdc to the Flow Access API
//      /v1/scripts endpoint with the (nft_id, owner) arguments.
//   3. The script returns a Resolved struct. If editionKey is non-null,
//      call pinnacle_upsert_nft_map(nft_id, edition_key, owner) to persist
//      the mapping. If editionKey is null (NFT didn't borrow, or traits
//      couldn't be read) we log and skip that pair for this batch.
//   4. At the end of the batch, call backfill_pinnacle_sale_editions() to
//      propagate any new mappings into pinnacle_sales.edition_id.
//
// Auth: Bearer rippackscity2026.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const FLOW_REST = "https://rest-mainnet.onflow.org"
const DEFAULT_BATCH_SIZE = 25
const INTER_CALL_DELAY_MS = 150

const SUPABASE_URL =
  Deno.env.get("SUPABASE_URL") ?? Deno.env.get("NEXT_PUBLIC_SUPABASE_URL") ?? ""
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY") ?? ""

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

// Cadence resolver — mirrors cadence/scripts/resolve-pinnacle-nft.cdc.
// Kept inline because Supabase edge functions don't bundle files outside
// the function directory, and the existing codebase (see scan-pinnacle-wallet)
// follows the inline-Cadence convention.
const RESOLVE_SCRIPT = `
import Pinnacle from 0xedf9df96c92f4595
import NonFungibleToken from 0x1d7e57aa55817448
import MetadataViews from 0x1d7e57aa55817448
import ViewResolver from 0x1d7e57aa55817448

access(all) struct Resolved {
    access(all) let royaltyCode: String?
    access(all) let variant: String?
    access(all) let printing: UInt64?
    access(all) let editionKey: String?
    access(all) let rawRoyaltyCodeType: String?

    init(
        royaltyCode: String?,
        variant: String?,
        printing: UInt64?,
        editionKey: String?,
        rawRoyaltyCodeType: String?
    ) {
        self.royaltyCode = royaltyCode
        self.variant = variant
        self.printing = printing
        self.editionKey = editionKey
        self.rawRoyaltyCodeType = rawRoyaltyCodeType
    }
}

access(all) fun main(id: UInt64, owner: Address): Resolved {
    let empty = Resolved(
        royaltyCode: nil,
        variant: nil,
        printing: nil,
        editionKey: nil,
        rawRoyaltyCodeType: nil
    )

    let acct = getAccount(owner)
    let colRef = acct.capabilities.borrow<&{NonFungibleToken.Collection}>(
        Pinnacle.CollectionPublicPath
    )
    if colRef == nil {
        return empty
    }

    let nftOpt = colRef!.borrowNFT(id)
    if nftOpt == nil {
        return empty
    }
    let nft = nftOpt!

    let traitsViewOpt = nft.resolveView(Type<MetadataViews.Traits>())
    if traitsViewOpt == nil {
        return empty
    }
    let traits = traitsViewOpt! as! MetadataViews.Traits

    var royaltyCode: String? = nil
    var variant: String? = nil
    var printing: UInt64? = nil
    var rawRoyaltyCodeType: String? = nil

    for trait in traits.traits {
        let raw = trait.value
        let rawType = raw.getType().identifier

        if trait.name == "Royalty Code" || trait.name == "royaltyCode" {
            rawRoyaltyCodeType = rawType
            if let s = raw as? String {
                royaltyCode = s
            }
        } else if trait.name == "Variant" || trait.name == "variant" {
            if let s = raw as? String {
                variant = s
            }
        } else if trait.name == "Printing" || trait.name == "printing" {
            if let u = raw as? UInt64 {
                printing = u
            } else if let i = raw as? Int {
                printing = UInt64(i)
            } else if let u32 = raw as? UInt32 {
                printing = UInt64(u32)
            } else if let s = raw as? String {
                printing = UInt64.fromString(s) ?? nil
            }
        }
    }

    var editionKey: String? = nil
    if royaltyCode != nil && variant != nil && printing != nil {
        editionKey = royaltyCode!
            .concat(":")
            .concat(variant!)
            .concat(":")
            .concat(printing!.toString())
    }

    return Resolved(
        royaltyCode: royaltyCode,
        variant: variant,
        printing: printing,
        editionKey: editionKey,
        rawRoyaltyCodeType: rawRoyaltyCodeType
    )
}
`.trim()

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

interface Target {
  nft_id: string
  owner: string
}

async function loadBatch(limit: number): Promise<Target[]> {
  const { data, error } = await supabase
    .from("pinnacle_unresolved_with_owner")
    .select("nft_id, owner")
    .limit(limit)
  if (error) throw new Error(`load batch: ${error.message}`)
  return (data ?? []) as Target[]
}

// Walk the Cadence JSON response for a Resolved struct and pluck out the
// editionKey field. The shape is:
//   { type: "Struct", value: { fields: [ { name, value: {...} } ] } }
// Fields we care about are wrapped in Optional — so e.g. the Optional<String>
// editionKey looks like { type: "Optional", value: { type: "String", value: "..." } }
// or { type: "Optional", value: null }.
function extractEditionKey(raw: unknown): string | null {
  const envelope = raw as { type?: string; value?: unknown }
  if (!envelope || typeof envelope !== "object") return null

  // Top-level struct value.
  const structValue = envelope.value as { fields?: Array<{ name: string; value: unknown }> } | undefined
  const fields = structValue?.fields
  if (!Array.isArray(fields)) return null

  for (const f of fields) {
    if (f.name !== "editionKey") continue
    const outer = f.value as { type?: string; value?: unknown } | null
    if (!outer) return null
    // Optional wrapper.
    if (outer.type === "Optional") {
      const inner = outer.value as { type?: string; value?: unknown } | null
      if (!inner) return null
      const v = inner.value
      return typeof v === "string" && v.length > 0 ? v : null
    }
    // Fallback — should not happen because editionKey is declared Optional.
    const v = outer.value
    return typeof v === "string" && v.length > 0 ? v : null
  }
  return null
}

async function resolveOne(nftId: string, owner: string): Promise<string | null> {
  const body = {
    script: btoa(RESOLVE_SCRIPT),
    arguments: [
      btoa(JSON.stringify({ type: "UInt64", value: String(nftId) })),
      btoa(JSON.stringify({ type: "Address", value: owner })),
    ],
  }
  const res = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
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
  if (auth !== "Bearer rippackscity2026") {
    return new Response("Unauthorized", { status: 401 })
  }

  const url = new URL(req.url)
  const batchParam = Number(url.searchParams.get("batch") ?? DEFAULT_BATCH_SIZE)
  const batchSize = Math.max(
    1,
    Math.min(100, Number.isFinite(batchParam) ? batchParam : DEFAULT_BATCH_SIZE)
  )

  const started = Date.now()
  try {
    const targets = await loadBatch(batchSize)
    if (targets.length === 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          message: "no unresolved (nft_id, owner) pairs",
          elapsed: Date.now() - started,
        }),
        { headers: { "Content-Type": "application/json; charset=utf-8" } }
      )
    }

    let queried = 0
    let resolved = 0
    let nullEdition = 0
    let failed = 0

    for (const t of targets) {
      queried++
      try {
        const editionKey = await resolveOne(t.nft_id, t.owner)
        if (editionKey == null) {
          nullEdition++
          console.log(
            `[pinnacle-nft-resolver] null editionKey nft=${t.nft_id} owner=${t.owner} — skipping`
          )
          continue
        }

        const { error: rpcErr } = await supabase.rpc("pinnacle_upsert_nft_map", {
          p_nft_id: t.nft_id,
          p_edition_key: editionKey,
          p_owner: t.owner,
        })
        if (rpcErr) {
          failed++
          console.log(
            `[pinnacle-nft-resolver] upsert rpc err nft=${t.nft_id}: ${rpcErr.message}`
          )
          continue
        }
        resolved++
      } catch (err) {
        failed++
        console.log(
          `[pinnacle-nft-resolver] resolve err nft=${t.nft_id}: ` +
            `${err instanceof Error ? err.message : String(err)}`
        )
      }
      await sleep(INTER_CALL_DELAY_MS)
    }

    // Promote newly-resolved mappings into pinnacle_sales.edition_id.
    const { data: promoted, error: promoteErr } = await supabase.rpc(
      "backfill_pinnacle_sale_editions"
    )
    if (promoteErr) {
      console.log(
        `[pinnacle-nft-resolver] backfill_pinnacle_sale_editions err: ${promoteErr.message}`
      )
    }

    return new Response(
      JSON.stringify({
        ok: true,
        queried,
        resolved,
        nullEdition,
        failed,
        promoted: promoted ?? null,
        elapsed: Date.now() - started,
      }),
      { headers: { "Content-Type": "application/json; charset=utf-8" } }
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[pinnacle-nft-resolver] fatal: ${msg}`)
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } }
    )
  }
})
