#!/usr/bin/env node
// scripts/enrich-pinnacle-editions.ts
//
// Backfill placeholder rows in pinnacle_editions. The sales indexer creates
// stub rows like { character_name: "Unknown (Edition N)" } to unblock
// sales → edition linking, and this script replaces those stubs with real
// metadata.
//
// Strategy (tried in order; each placeholder ID is considered resolved as
// soon as any source returns a match):
//   1. Flowty listings — reuse parsePinnacleTraits against the current
//      active-listings snapshot. Covers any edition with at least one live
//      Flowty listing. No proxy required.
//   2. Pinnacle Worker proxy (optional) — when PINNACLE_PROXY_URL is set,
//      query the Pinnacle GQL for edition metadata. Falls through silently
//      if the proxy is unset/not-deployed, so the script stays useful in
//      Flowty-only mode.
//
// Usage:  npx tsx scripts/enrich-pinnacle-editions.ts [--dry-run]
// Env:    SUPABASE_URL (optional), SUPABASE_SERVICE_ROLE_KEY (required)
//         PINNACLE_PROXY_URL     (optional, e.g. https://pinnacle-proxy.tdillonbond.workers.dev)
//         PINNACLE_PROXY_SECRET  (required if PINNACLE_PROXY_URL set)

import { createClient } from "@supabase/supabase-js"
import {
  fetchPinnacleListings,
  parsePinnacleTraits,
  buildEditionKey,
} from "../lib/pinnacle/flowty"

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://bxcqstmqfzmuolpuynti.supabase.co"
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ""
const PROXY_URL = process.env.PINNACLE_PROXY_URL || ""
const PROXY_SECRET = process.env.PINNACLE_PROXY_SECRET || ""
const DRY_RUN = process.argv.includes("--dry-run")

if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY not set")
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

interface PlaceholderRow {
  id: string
  character_name: string
  franchise: string | null
  set_name: string | null
  variant_type: string | null
}

interface EditionUpdate {
  id: string
  character_name: string
  franchise: string
  set_name: string
  royalty_code: string
  variant_type: string
  edition_type: string
  printing: number
  is_serialized: boolean
  is_chaser: boolean
  updated_at: string
}

async function loadPlaceholders(): Promise<PlaceholderRow[]> {
  const all: PlaceholderRow[] = []
  let from = 0
  const pageSize = 500
  for (;;) {
    const { data, error } = await supabase
      .from("pinnacle_editions")
      .select("id,character_name,franchise,set_name,variant_type")
      .like("character_name", "Unknown%")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw new Error(`placeholder load: ${error.message}`)
    if (!data || data.length === 0) break
    all.push(...(data as PlaceholderRow[]))
    if (data.length < pageSize) break
    from += pageSize
  }
  return all
}

function flowtyUpdates(
  placeholderIds: Set<string>,
  listings: Awaited<ReturnType<typeof fetchPinnacleListings>>
): Map<string, EditionUpdate> {
  const out = new Map<string, EditionUpdate>()
  for (const listing of listings) {
    try {
      const traits = parsePinnacleTraits(listing.nftView.traits.traits)
      const editionKey = buildEditionKey(traits)
      if (!placeholderIds.has(editionKey)) continue
      if (out.has(editionKey)) continue
      const studio = traits.Studios.replace(/^\[|\]$/g, "")
      out.set(editionKey, {
        id: editionKey,
        character_name: traits.Characters.replace(/^\[|\]$/g, ""),
        franchise: studio,
        set_name: traits.SetName,
        royalty_code: traits.RoyaltyCodes.replace(/^\[|\]$/g, ""),
        variant_type: traits.Variant,
        edition_type: traits.EditionType,
        printing: Number(traits.Printing) || 1,
        is_serialized: traits.SerialNumber !== null,
        is_chaser: traits.IsChaser === "true",
        updated_at: new Date().toISOString(),
      })
    } catch {
      // per-listing parse errors are non-fatal
    }
  }
  return out
}

async function proxyUpdates(
  placeholderIds: string[]
): Promise<Map<string, EditionUpdate>> {
  const out = new Map<string, EditionUpdate>()
  if (!PROXY_URL) return out
  if (!PROXY_SECRET) {
    console.log(
      "[enrich-pinnacle] PINNACLE_PROXY_URL set but PINNACLE_PROXY_SECRET missing — skipping proxy pass"
    )
    return out
  }

  // Probe: try one known edition key and see what shape the proxy returns.
  // If the proxy isn't wired up yet (404/500), fall through quietly.
  const probe = placeholderIds[0]
  try {
    const res = await fetch(PROXY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Proxy-Secret": PROXY_SECRET,
      },
      body: JSON.stringify({ editionKey: probe }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      console.log(
        `[enrich-pinnacle] proxy probe returned ${res.status} — skipping proxy pass (deploy pinnacle-proxy to enable)`
      )
      return out
    }
  } catch (e: any) {
    console.log(
      `[enrich-pinnacle] proxy probe failed (${e?.message ?? "unknown"}) — skipping proxy pass`
    )
    return out
  }

  // Shape of the proxy response is intentionally not pinned here — whoever
  // deploys the Pinnacle GQL proxy owns that contract. Expected to return
  // { editionKey, characterName, franchise, setName, variantType, ... }.
  for (const key of placeholderIds) {
    if (out.has(key)) continue
    try {
      const res = await fetch(PROXY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Proxy-Secret": PROXY_SECRET,
        },
        body: JSON.stringify({ editionKey: key }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) continue
      const j = (await res.json()) as Record<string, unknown>
      const characterName = String(j.characterName ?? j.character_name ?? "")
      const franchise = String(j.franchise ?? j.studio ?? "")
      if (!characterName || characterName.startsWith("Unknown")) continue
      out.set(key, {
        id: key,
        character_name: characterName,
        franchise,
        set_name: String(j.setName ?? j.set_name ?? ""),
        royalty_code: String(j.royaltyCode ?? j.royalty_code ?? key.split(":")[0] ?? ""),
        variant_type: String(j.variantType ?? j.variant_type ?? key.split(":")[1] ?? "Standard"),
        edition_type: String(j.editionType ?? j.edition_type ?? "Open Edition"),
        printing: Number(j.printing ?? key.split(":")[2] ?? 1) || 1,
        is_serialized: j.isSerialized === true || j.is_serialized === true,
        is_chaser: j.isChaser === true || j.is_chaser === true,
        updated_at: new Date().toISOString(),
      })
    } catch {
      // per-key errors are non-fatal — we'll retry on next run
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return out
}

async function applyUpdates(updates: EditionUpdate[]): Promise<number> {
  if (updates.length === 0) return 0
  if (DRY_RUN) {
    console.log(`[enrich-pinnacle] DRY RUN — would update ${updates.length} rows`)
    for (const u of updates.slice(0, 10)) {
      console.log(`  ${u.id} → ${u.character_name} / ${u.franchise}`)
    }
    if (updates.length > 10) console.log(`  … ${updates.length - 10} more`)
    return 0
  }

  const CHUNK = 100
  let written = 0
  for (let i = 0; i < updates.length; i += CHUNK) {
    const batch = updates.slice(i, i + CHUNK)
    const { error } = await supabase
      .from("pinnacle_editions")
      .upsert(batch, { onConflict: "id" })
    if (error) {
      console.log(`[enrich-pinnacle] upsert chunk ${i} err: ${error.message}`)
    } else {
      written += batch.length
    }
  }
  return written
}

async function main() {
  console.log(`[enrich-pinnacle] starting${DRY_RUN ? " (dry run)" : ""}`)

  const placeholders = await loadPlaceholders()
  console.log(`[enrich-pinnacle] ${placeholders.length} placeholder rows`)
  if (placeholders.length === 0) {
    console.log("nothing to do.")
    return
  }
  const placeholderIds = new Set(placeholders.map((p) => p.id))

  // 1. Flowty pass.
  let flowtyHits = 0
  let flowtyMap = new Map<string, EditionUpdate>()
  try {
    console.log("[enrich-pinnacle] fetching Flowty listings …")
    const listings = await fetchPinnacleListings()
    console.log(`[enrich-pinnacle] ${listings.length} active Flowty listings`)
    flowtyMap = flowtyUpdates(placeholderIds, listings)
    flowtyHits = flowtyMap.size
    console.log(`[enrich-pinnacle] Flowty resolved ${flowtyHits}/${placeholderIds.size}`)
  } catch (e: any) {
    console.log(`[enrich-pinnacle] Flowty fetch failed: ${e?.message ?? "unknown"}`)
  }

  // 2. Proxy pass — only for what Flowty didn't catch.
  const stillMissing = placeholders
    .filter((p) => !flowtyMap.has(p.id))
    .map((p) => p.id)
  let proxyHits = 0
  let proxyMap = new Map<string, EditionUpdate>()
  if (stillMissing.length > 0 && PROXY_URL) {
    console.log(`[enrich-pinnacle] querying proxy for ${stillMissing.length} remaining …`)
    proxyMap = await proxyUpdates(stillMissing)
    proxyHits = proxyMap.size
    console.log(`[enrich-pinnacle] Proxy resolved ${proxyHits}/${stillMissing.length}`)
  }

  const merged = [...flowtyMap.values(), ...proxyMap.values()]
  const written = await applyUpdates(merged)

  const unresolved = placeholderIds.size - flowtyHits - proxyHits
  console.log("")
  console.log("═══ enrich-pinnacle summary ═══")
  console.log(`  placeholders:  ${placeholderIds.size}`)
  console.log(`  flowty hits:   ${flowtyHits}`)
  console.log(`  proxy hits:    ${proxyHits}`)
  console.log(`  written:       ${written}`)
  console.log(`  unresolved:    ${unresolved}`)
  console.log("════════════════════════════════")
  if (unresolved > 0 && !PROXY_URL) {
    console.log(
      "tip: deploy the Pinnacle Worker proxy and set PINNACLE_PROXY_URL + PINNACLE_PROXY_SECRET to resolve editions without active Flowty listings."
    )
  }
}

main().catch((err) => {
  console.error("fatal:", err)
  process.exit(1)
})
