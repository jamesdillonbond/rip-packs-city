#!/usr/bin/env node
// scripts/fetch-missing-pinnacle-editions.ts
//
// Fetches Pinnacle edition metadata for edition_keys that are referenced
// by wallet_moments_cache rows but have NO corresponding pinnacle_editions
// row. Inserts new rows so that backfill_pinnacle_wmc_metadata_from_editions
// can fill character_name / set_name / tier / mint_count on the affected
// wmc rows.
//
// Source: Flowty's per-NFT REST endpoint
// (https://api2.flowty.io/nft/0xedf9df96c92f4595/Pinnacle/{nft_id}). Same
// pattern as supabase/functions/allday-unmapped-resolver — Flowty already
// indexes Pinnacle moments for the marketplace UI, traits include
// RoyaltyCodes / Variant / Printing / Characters / Studios / SetName etc.
//
// Why per-NFT and not GQL: the public-api.disneypinnacle.com GQL schema
// for fetching by edition_key isn't documented in this repo, and Flowty's
// per-NFT endpoint requires no auth and is already battle-tested for
// AllDay. Each missing edition_key has at least one wmc row with a
// moment_id, so we pick any moment_id per edition_key and look it up.
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/fetch-missing-pinnacle-editions.ts
//   --dry-run    print planned inserts without writing
//   --limit=N    cap the work (default: process all)
//
// Verification:
//   pinnacle_editions where edition_key IS NOT NULL grows from 293 toward 315 (+22).
//   wmc with NULL set_name on Pinnacle drops by ~836.

import { createClient } from "@supabase/supabase-js"

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://bxcqstmqfzmuolpuynti.supabase.co"
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ""
const PINNACLE_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
const FLOWTY_NFT_BASE = "https://api2.flowty.io/nft/0xedf9df96c92f4595/Pinnacle"
const FLOWTY_HEADERS: Record<string, string> = {
  Origin: "https://www.flowty.io",
  "User-Agent": "rip-packs-city/fetch-missing-pinnacle-editions",
}
const PER_CALL_TIMEOUT_MS = 10_000
const PER_CALL_DELAY_MS = 150

const DRY_RUN = process.argv.includes("--dry-run")
const LIMIT = (() => {
  const hit = process.argv.find((a) => a.startsWith("--limit="))
  if (!hit) return Infinity
  const n = Number(hit.slice("--limit=".length))
  return Number.isFinite(n) && n > 0 ? n : Infinity
})()

if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY not set")
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface MissingTarget {
  edition_key: string
  sample_moment_id: string
  wmc_rows: number
}

async function loadMissingTargets(): Promise<MissingTarget[]> {
  // PostgREST can't express the cross-table NOT EXISTS we want without a
  // raw RPC. Issue two reads and aggregate in JS instead. The wmc page
  // size is bounded by the .range() PostgREST cap; the volume here is
  // 13k-ish wmc rows for Pinnacle which paginates cheaply.

  // Step 1: list edition_keys present in pinnacle_editions (so we can NOT IN them)
  const knownKeys = new Set<string>()
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await supabase
      .from("pinnacle_editions")
      .select("edition_key")
      .not("edition_key", "is", null)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`pinnacle_editions read: ${error.message}`)
    const rows = (data ?? []) as Array<{ edition_key: string | null }>
    for (const r of rows) if (r.edition_key) knownKeys.add(r.edition_key)
    if (rows.length < PAGE) break
    from += PAGE
  }

  // Step 2: scan wmc for edition_keys not in knownKeys, aggregate in JS.
  const counts = new Map<string, { count: number; sampleId: string }>()
  let cursor = 0
  while (true) {
    const { data, error } = await supabase
      .from("wallet_moments_cache")
      .select("moment_id, edition_key")
      .eq("collection_id", PINNACLE_COLLECTION_ID)
      .not("edition_key", "is", null)
      .range(cursor, cursor + PAGE - 1)
    if (error) throw new Error(`wallet_moments_cache scan: ${error.message}`)
    const rows = (data ?? []) as Array<{ moment_id: string; edition_key: string }>
    for (const r of rows) {
      const ek = r.edition_key
      if (!ek) continue
      if (knownKeys.has(ek)) continue
      // Validate shape: ROYALTY-MID-SUFFIX:Variant:Printing
      if (!/^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+:.+:[0-9]+$/.test(ek)) continue
      const existing = counts.get(ek)
      if (existing) {
        existing.count++
        if (r.moment_id < existing.sampleId) existing.sampleId = r.moment_id
      } else {
        counts.set(ek, { count: 1, sampleId: r.moment_id })
      }
    }
    if (rows.length < PAGE) break
    cursor += PAGE
  }

  return Array.from(counts.entries())
    .map(([edition_key, v]) => ({
      edition_key,
      sample_moment_id: v.sampleId,
      wmc_rows: v.count,
    }))
    .sort((a, b) => b.wmc_rows - a.wmc_rows)
}

interface FlowtyTrait {
  name: string
  value: string
}

interface FlowtyNftResp {
  nftView?: {
    traits?: { traits?: FlowtyTrait[] }
  }
}

function trait(traits: FlowtyTrait[] | undefined, name: string): string | null {
  if (!Array.isArray(traits)) return null
  for (const t of traits) {
    if (t?.name === name) {
      const v = t.value
      if (v != null && String(v).trim() !== "") return String(v).trim()
    }
  }
  return null
}

interface PinnacleEditionInsert {
  edition_key: string
  character_name: string
  franchise: string
  set_name: string
  variant_type: string
  edition_type: string
  printing: number
  royalty_code: string
  mint_count: number | null
  is_chaser: boolean
  is_serialized: boolean
}

async function fetchEditionFromMoment(
  momentId: string,
  editionKey: string,
): Promise<PinnacleEditionInsert | null> {
  let res: Response
  try {
    res = await fetch(`${FLOWTY_NFT_BASE}/${encodeURIComponent(momentId)}`, {
      method: "GET",
      headers: FLOWTY_HEADERS,
      signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
    })
  } catch (err) {
    console.log(
      `  ✗ ${editionKey} (moment ${momentId}): fetch ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
  if (!res.ok) {
    console.log(`  ✗ ${editionKey} (moment ${momentId}): HTTP ${res.status}`)
    return null
  }
  let json: FlowtyNftResp
  try {
    json = (await res.json()) as FlowtyNftResp
  } catch {
    console.log(`  ✗ ${editionKey} (moment ${momentId}): bad JSON`)
    return null
  }
  const traits = json?.nftView?.traits?.traits
  const royaltyRaw = trait(traits, "RoyaltyCodes")
  const variant = trait(traits, "Variant")
  const printingRaw = trait(traits, "Printing")
  const characters = trait(traits, "Characters")
  const studios = trait(traits, "Studios")
  const setName = trait(traits, "SetName")
  const editionType = trait(traits, "EditionType")
  const isChaser = trait(traits, "IsChaser")
  const serialNumber = trait(traits, "SerialNumber")

  if (!royaltyRaw || !variant || !printingRaw || !characters || !setName) {
    console.log(`  ✗ ${editionKey} (moment ${momentId}): missing required traits`)
    return null
  }

  const royaltyCode = royaltyRaw.replace(/^\[|\]$/g, "")
  const character = characters.replace(/^\[|\]$/g, "")
  const studio = studios ? studios.replace(/^\[|\]$/g, "") : null
  const printing = Number(printingRaw) || 1

  // Sanity: traits should reproduce the edition_key we expected. If not,
  // the wmc row's edition_key was constructed from a different convention
  // and we should skip rather than poison pinnacle_editions.
  const builtKey = `${royaltyCode}:${variant}:${printing}`
  if (builtKey !== editionKey) {
    console.log(
      `  ⚠ ${editionKey} (moment ${momentId}): trait key '${builtKey}' doesn't match — skipping`,
    )
    return null
  }

  return {
    edition_key: editionKey,
    character_name: character,
    // pinnacle_editions.franchise is NOT NULL — fall back to "" if Studios
    // trait is missing rather than failing the insert.
    franchise: studio ?? "",
    set_name: setName,
    variant_type: variant,
    // pinnacle_editions.edition_type is NOT NULL — default matches the
    // Flowty path used by enrich-pinnacle-editions.ts.
    edition_type: editionType ?? "Open Edition",
    printing,
    royalty_code: royaltyCode,
    mint_count: null, // Flowty NFT trait surface doesn't expose mint_count;
    // it's only on the SeriesEdition GQL surface. Stays NULL until a future
    // GQL resolver fills it.
    is_chaser: isChaser === "true",
    is_serialized: serialNumber != null,
  }
}

async function applyInserts(rows: PinnacleEditionInsert[]): Promise<number> {
  if (rows.length === 0) return 0
  if (DRY_RUN) {
    console.log(`[fetch-missing-pinnacle] DRY RUN — would insert ${rows.length} rows`)
    for (const r of rows.slice(0, 10)) {
      console.log(
        `  ${r.edition_key} → ${r.character_name} / ${r.franchise} / ${r.set_name} / ${r.variant_type}`,
      )
    }
    if (rows.length > 10) console.log(`  … ${rows.length - 10} more`)
    return 0
  }

  // pinnacle_editions.id is text; use edition_key as the id when no chain
  // resolver has assigned one. The existing enrich-pinnacle-editions.ts
  // uses the same convention (id = edition_key for new rows).
  const toUpsert = rows.map((r) => ({
    id: r.edition_key,
    edition_key: r.edition_key,
    character_name: r.character_name,
    franchise: r.franchise,
    set_name: r.set_name,
    variant_type: r.variant_type,
    edition_type: r.edition_type,
    printing: r.printing,
    royalty_code: r.royalty_code,
    mint_count: r.mint_count,
    is_chaser: r.is_chaser,
    is_serialized: r.is_serialized,
    updated_at: new Date().toISOString(),
  }))

  const CHUNK = 50
  let written = 0
  for (let i = 0; i < toUpsert.length; i += CHUNK) {
    const batch = toUpsert.slice(i, i + CHUNK)
    const { error } = await supabase
      .from("pinnacle_editions")
      .upsert(batch, { onConflict: "id" })
    if (error) {
      console.log(`[fetch-missing-pinnacle] upsert chunk ${i} err: ${error.message}`)
    } else {
      written += batch.length
    }
  }
  return written
}

async function main() {
  console.log(`[fetch-missing-pinnacle] starting${DRY_RUN ? " (dry run)" : ""}`)

  console.log("[fetch-missing-pinnacle] computing missing edition_keys …")
  const targets = await loadMissingTargets()
  const limited = Number.isFinite(LIMIT) ? targets.slice(0, LIMIT) : targets
  console.log(
    `[fetch-missing-pinnacle] ${targets.length} missing edition_keys (processing ${limited.length})`,
  )
  if (limited.length === 0) {
    console.log("nothing to do.")
    return
  }

  const inserts: PinnacleEditionInsert[] = []
  let resolved = 0
  let skipped = 0
  for (const tgt of limited) {
    const row = await fetchEditionFromMoment(tgt.sample_moment_id, tgt.edition_key)
    if (row) {
      inserts.push(row)
      resolved++
      console.log(
        `  ✓ ${tgt.edition_key} (${tgt.wmc_rows} wmc rows) → ${row.character_name} / ${row.set_name}`,
      )
    } else {
      skipped++
    }
    await sleep(PER_CALL_DELAY_MS)
  }

  const written = await applyInserts(inserts)

  // Trigger the post-pass JOIN UPDATE so wmc rows get character_name /
  // set_name / tier / mint_count filled. p_wallet_address NULL means
  // backfill across all wallets (RPC supports this — same as the cron path).
  let postPassUpdated = 0
  if (written > 0 && !DRY_RUN) {
    console.log("[fetch-missing-pinnacle] triggering wmc post-pass …")
    const { data: updResult, error: updErr } = await supabase.rpc(
      "backfill_pinnacle_wmc_metadata_from_editions",
      { p_wallet_address: null },
    )
    if (updErr) {
      console.log(`  post-pass err: ${updErr.message}`)
    } else {
      postPassUpdated = Number(updResult ?? 0) || 0
    }
  }

  console.log("")
  console.log("═══ fetch-missing-pinnacle summary ═══")
  console.log(`  targets:           ${limited.length}`)
  console.log(`  resolved:          ${resolved}`)
  console.log(`  skipped:           ${skipped}`)
  console.log(`  rows written:      ${written}`)
  console.log(`  wmc rows updated:  ${postPassUpdated}`)
  console.log("══════════════════════════════════════")
}

main().catch((err) => {
  console.error("fatal:", err)
  process.exit(1)
})
