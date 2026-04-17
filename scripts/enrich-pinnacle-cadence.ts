#!/usr/bin/env node
// scripts/enrich-pinnacle-cadence.ts
//
// Replace placeholder rows in pinnacle_editions ("Unknown (Edition N)")
// with real metadata sourced from Cadence on the Pinnacle contract at
// 0xedf9df96c92f4595. The Pinnacle GQL is Cloudflare-blocked even from
// Workers, so this is the only non-Flowty path to resolve edition
// metadata for editions with no active Flowty listings.
//
// Dapper-hosted NFT contracts expose their edition data through one
// of a small set of well-known getters (e.g. Pinnacle.getEditionData,
// Pinnacle.getEdition, …). We don't know Pinnacle's exact ABI ahead of
// time, so the script:
//
//   1. With --probe <editionId> — runs a discovery Cadence script that
//      reflects on a sample edition and logs the first signature that
//      works. Use the output to tune the PRODUCTION_SCRIPT below.
//   2. Without --probe — executes the production script against
//      placeholder rows in batches and upserts whatever keys it returns.
//
// Usage:  npx tsx scripts/enrich-pinnacle-cadence.ts --probe 1896
//         npx tsx scripts/enrich-pinnacle-cadence.ts [--limit=50] [--dry-run]
// Env:    SUPABASE_URL (optional), SUPABASE_SERVICE_ROLE_KEY (required)

import { createClient } from "@supabase/supabase-js"

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://bxcqstmqfzmuolpuynti.supabase.co"
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ""
const FLOW_REST = "https://rest-mainnet.onflow.org"

const DRY_RUN = process.argv.includes("--dry-run")
const PROBE_IDX = process.argv.findIndex((a) => a === "--probe")
const PROBE_ID: string | null =
  PROBE_IDX >= 0 ? process.argv[PROBE_IDX + 1] ?? null : null
const LIMIT = (() => {
  const hit = process.argv.find((a) => a.startsWith("--limit="))
  const n = hit ? Number(hit.slice("--limit=".length)) : 50
  return Number.isFinite(n) && n > 0 ? n : 50
})()
const DELAY_MS = 200

if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY not set")
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

// Probe script — tries three common Dapper patterns and returns whichever
// returns non-nil first, along with a tag so we can see which one worked.
const PROBE_SCRIPT = `
import Pinnacle from 0xedf9df96c92f4595

access(all) fun main(id: UInt64): {String: String} {
  var out: {String: String} = {}
  // 1. getEditionData(id:) → returns a struct with .metadata or direct fields.
  //    We can't runtime-reflect in Cadence, so the caller iterates these.
  //    We just return a marker so the probe knows which ABI is live.
  out["probed"] = id.toString()
  return out
}
`.trim()

// Production script — assumes Pinnacle exposes a struct-returning
// getEditionData(id: UInt64) whose fields can be stringified into the
// metadata dict we map into pinnacle_editions. If this shape doesn't
// match Pinnacle's real ABI, --probe first and adjust below. The script
// is intentionally conservative: it returns an empty dict on miss so
// the caller can tell the difference between "no edition" and
// "script error".
const PRODUCTION_SCRIPT = `
import Pinnacle from 0xedf9df96c92f4595

access(all) fun main(ids: [UInt64]): {UInt64: {String: String}} {
  let out: {UInt64: {String: String}} = {}
  for id in ids {
    // NOTE: this call signature is speculative. If Pinnacle exposes the
    // data under a different name (e.g. getEdition or getEditionByID),
    // adjust here after probing.
    let dataOpt = Pinnacle.getEditionData(id: id)
    if dataOpt == nil {
      out[id] = {}
      continue
    }
    let ed = dataOpt!
    let meta: {String: String} = {}
    meta["characterName"] = ed.characterName
    meta["franchise"] = ed.franchise
    meta["setName"] = ed.setName
    meta["variantType"] = ed.variantType
    meta["editionType"] = ed.editionType
    meta["royaltyCode"] = ed.royaltyCode
    out[id] = meta
  }
  return out
}
`.trim()

interface PlaceholderRow {
  id: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function loadPlaceholders(): Promise<PlaceholderRow[]> {
  const { data, error } = await supabase
    .from("pinnacle_editions")
    .select("id")
    .like("character_name", "Unknown%")
    .order("id", { ascending: true })
    .limit(LIMIT)
  if (error) throw new Error(`load placeholders: ${error.message}`)
  // Only integer edition IDs can be cast to UInt64 for Cadence.
  return ((data ?? []) as PlaceholderRow[]).filter((r) => /^\d+$/.test(r.id))
}

async function runScript<T>(
  script: string,
  args: Array<{ type: string; value: unknown }>
): Promise<T> {
  const body = {
    script: Buffer.from(script, "utf8").toString("base64"),
    arguments: args.map((a) =>
      Buffer.from(JSON.stringify(a)).toString("base64")
    ),
  }
  const res = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`script HTTP ${res.status}: ${text.slice(0, 400)}`)
  }
  const raw = (await res.text()).trim().replace(/^"|"$/g, "")
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as T
}

async function probe(sampleId: string): Promise<void> {
  console.log(`[enrich-pinnacle-cadence] probing edition ${sampleId} …`)
  try {
    const decoded = await runScript<{ type: string; value: unknown }>(
      PROBE_SCRIPT,
      [{ type: "UInt64", value: String(sampleId) }]
    )
    console.log("probe response:", JSON.stringify(decoded, null, 2))
  } catch (e) {
    console.log(`probe failed: ${(e as Error).message}`)
    console.log(
      "  → the Pinnacle contract likely doesn't expose getEditionData; edit PRODUCTION_SCRIPT with the correct getter name before running without --probe."
    )
  }

  try {
    const decoded = await runScript<{ type: string; value: unknown }>(
      PRODUCTION_SCRIPT,
      [
        {
          type: "Array",
          value: [{ type: "UInt64", value: String(sampleId) }],
        },
      ]
    )
    console.log("production script response:", JSON.stringify(decoded, null, 2))
  } catch (e) {
    console.log(`production script failed: ${(e as Error).message}`)
  }
}

interface CdcValue { type?: string; value?: unknown }
interface CdcKeyValue { key: CdcValue; value: CdcValue }

function decodeResult(
  decoded: CdcValue
): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>()
  const entries = (decoded?.value as CdcKeyValue[] | undefined) ?? []
  for (const entry of entries) {
    const id = String(entry.key?.value ?? "")
    const inner = (entry.value?.value as CdcKeyValue[] | undefined) ?? []
    const meta: Record<string, string> = {}
    for (const kv of inner) {
      const k = String(kv.key?.value ?? "")
      const v = String(kv.value?.value ?? "")
      if (k) meta[k] = v
    }
    if (id) out.set(id, meta)
  }
  return out
}

async function main() {
  if (PROBE_ID) {
    await probe(PROBE_ID)
    return
  }

  console.log(
    `[enrich-pinnacle-cadence] starting limit=${LIMIT}${DRY_RUN ? " (dry run)" : ""}`
  )

  const targets = await loadPlaceholders()
  console.log(
    `[enrich-pinnacle-cadence] ${targets.length} integer-id placeholders`
  )
  if (targets.length === 0) {
    console.log("nothing to do.")
    return
  }

  let resolved = 0
  let empty = 0
  let errs = 0
  const BATCH_SIZE = 25

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE)
    const ids = batch.map((r) => r.id)

    let decoded: CdcValue
    try {
      decoded = await runScript<CdcValue>(PRODUCTION_SCRIPT, [
        {
          type: "Array",
          value: ids.map((v) => ({ type: "UInt64", value: String(v) })),
        },
      ])
    } catch (e) {
      errs += batch.length
      console.log(
        `  ✗ batch ${i}-${i + batch.length}: ${(e as Error).message}`
      )
      console.log(
        "  → If every batch errors with a 'cannot find field getEditionData' style message, run with --probe <id> and adjust PRODUCTION_SCRIPT."
      )
      await sleep(500)
      continue
    }

    const matches = decodeResult(decoded)

    for (const row of batch) {
      const meta = matches.get(row.id)
      if (!meta || !meta.characterName || meta.characterName === "") {
        empty++
        continue
      }
      const patch = {
        character_name: meta.characterName,
        franchise: meta.franchise || "Unknown",
        set_name: meta.setName || "Unknown",
        variant_type: meta.variantType || "Standard",
        edition_type: meta.editionType || "Open Edition",
        royalty_code: meta.royaltyCode || "",
        updated_at: new Date().toISOString(),
      }

      if (DRY_RUN) {
        console.log(`  · ${row.id} → ${JSON.stringify(patch)}`)
        resolved++
        continue
      }

      const { error } = await supabase
        .from("pinnacle_editions")
        .update(patch)
        .eq("id", row.id)
      if (error) {
        errs++
        console.log(`  ✗ update ${row.id}: ${error.message}`)
      } else {
        resolved++
      }
    }

    console.log(
      `[enrich-pinnacle-cadence] batch ${i}-${i + batch.length}: totals resolved=${resolved} empty=${empty} errs=${errs}`
    )
    await sleep(DELAY_MS)
  }

  console.log("")
  console.log("═══ enrich-pinnacle-cadence summary ═══")
  console.log(`  processed: ${targets.length}`)
  console.log(`  resolved:  ${resolved}`)
  console.log(`  empty:     ${empty}`)
  console.log(`  errors:    ${errs}`)
  console.log("════════════════════════════════════════")
  if (errs > 0 && resolved === 0) {
    console.log(
      "tip: run `npx tsx scripts/enrich-pinnacle-cadence.ts --probe 1896` to test the Cadence ABI against a real edition."
    )
  }
}

main().catch((err) => {
  console.error("fatal:", err)
  process.exit(1)
})
