#!/usr/bin/env node
// scripts/enrich-pinnacle-cadence.ts
//
// Replace placeholder rows in pinnacle_editions ("Unknown (Edition N)")
// with real metadata from Cadence on the Pinnacle contract at
// 0xedf9df96c92f4595.
//
// Pinnacle exposes two getters we need:
//   1. Pinnacle.getEdition(id: Int)  → edition struct (variant, isChaser, shapeID…)
//   2. Pinnacle.getShape(id: Int)    → shape struct (name, editionType, metadata)
// shapeID from #1 feeds into #2 — so enrichment is two calls per edition.
//
// Pinnacle IDs are Int (not UInt64). Argument shape: {"type":"Int","value":"1896"}.
//
// Usage:  npx tsx scripts/enrich-pinnacle-cadence.ts [--limit=50] [--dry-run]
// Env:    SUPABASE_URL (optional), SUPABASE_SERVICE_ROLE_KEY (required)

import { createClient } from "@supabase/supabase-js"

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://bxcqstmqfzmuolpuynti.supabase.co"
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ""
const FLOW_REST = "https://rest-mainnet.onflow.org"

const DRY_RUN = process.argv.includes("--dry-run")
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

const EDITION_SCRIPT = `
import Pinnacle from 0xedf9df96c92f4595
access(all) fun main(id: Int): AnyStruct {
  return Pinnacle.getEdition(id: id)
}
`.trim()

const SHAPE_SCRIPT = `
import Pinnacle from 0xedf9df96c92f4595
access(all) fun main(id: Int): AnyStruct {
  return Pinnacle.getShape(id: id)
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
  return ((data ?? []) as PlaceholderRow[]).filter((r) => /^\d+$/.test(r.id))
}

async function runScript(script: string, id: string): Promise<CdcValue> {
  const body = {
    script: Buffer.from(script, "utf8").toString("base64"),
    arguments: [
      Buffer.from(JSON.stringify({ type: "Int", value: String(id) })).toString(
        "base64"
      ),
    ],
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
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as CdcValue
}

// ── Cadence JSON decoding ────────────────────────────────────────────────────
// Flow REST returns values wrapped as { type, value } recursively. For an
// Optional<Struct>, the wrapper is value.value. For a non-Optional Struct,
// fields live at value.fields[]. We normalize by unwrapping Optional first.

interface CdcValue {
  type?: string
  value?: unknown
  fields?: CdcField[]
}
interface CdcField {
  name: string
  value: CdcValue
}
interface CdcDictEntry {
  key: CdcValue
  value: CdcValue
}

function unwrapOptional(v: CdcValue | undefined | null): CdcValue | null {
  if (!v) return null
  if (v.type === "Optional") {
    if (v.value == null) return null
    return v.value as CdcValue
  }
  return v
}

function getStructFields(v: CdcValue | null): Record<string, CdcValue> {
  const out: Record<string, CdcValue> = {}
  if (!v) return out
  // Flow REST may put fields at v.value.fields (wrapped) or v.fields (unwrapped).
  const inner =
    (v.value as { fields?: CdcField[] } | undefined)?.fields ??
    v.fields ??
    []
  for (const f of inner) {
    out[f.name] = f.value
  }
  return out
}

function scalarString(v: CdcValue | null | undefined): string | null {
  const u = unwrapOptional(v ?? null)
  if (!u) return null
  const val = u.value
  return val == null ? null : String(val)
}

function scalarBool(v: CdcValue | null | undefined): boolean | null {
  const u = unwrapOptional(v ?? null)
  if (!u) return null
  if (typeof u.value === "boolean") return u.value
  if (u.value === "true") return true
  if (u.value === "false") return false
  return null
}

function dictEntries(v: CdcValue | null | undefined): CdcDictEntry[] {
  const u = unwrapOptional(v ?? null)
  if (!u) return []
  return (u.value as CdcDictEntry[] | undefined) ?? []
}

function arrayValues(v: CdcValue | null | undefined): CdcValue[] {
  const u = unwrapOptional(v ?? null)
  if (!u) return []
  return (u.value as CdcValue[] | undefined) ?? []
}

interface EditionData {
  shapeID: string | null
  variant: string | null
  isChaser: boolean | null
  description: string | null
}

function parseEdition(decoded: CdcValue): EditionData | null {
  const unwrapped = unwrapOptional(decoded)
  if (!unwrapped) return null
  const fields = getStructFields(unwrapped)
  return {
    shapeID: scalarString(fields.shapeID),
    variant: scalarString(fields.variant),
    isChaser: scalarBool(fields.isChaser),
    description: scalarString(fields.description),
  }
}

interface ShapeData {
  name: string | null
  editionType: string | null
  franchise: string | null
  studio: string | null
}

function parseShape(decoded: CdcValue): ShapeData | null {
  const unwrapped = unwrapOptional(decoded)
  if (!unwrapped) return null
  const fields = getStructFields(unwrapped)

  const metaDict = dictEntries(fields.metadata)
  const lookup = new Map<string, CdcValue>()
  for (const entry of metaDict) {
    const k = scalarString(entry.key)
    if (k) lookup.set(k, entry.value)
  }

  const firstArrayString = (key: string): string | null => {
    const arr = arrayValues(lookup.get(key))
    if (arr.length === 0) return null
    return scalarString(arr[0])
  }

  return {
    name: scalarString(fields.name),
    editionType: scalarString(fields.editionType),
    franchise: firstArrayString("Franchises"),
    studio: firstArrayString("Categories"),
  }
}

async function main() {
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

  let updated = 0
  let empty = 0
  let errs = 0

  for (const row of targets) {
    try {
      const edDecoded = await runScript(EDITION_SCRIPT, row.id)
      const edition = parseEdition(edDecoded)
      if (!edition || !edition.shapeID) {
        empty++
        console.log(`  · ${row.id}: edition returned nil or no shapeID`)
        await sleep(DELAY_MS)
        continue
      }

      await sleep(DELAY_MS)

      const shDecoded = await runScript(SHAPE_SCRIPT, edition.shapeID)
      const shape = parseShape(shDecoded)
      if (!shape || !shape.name) {
        empty++
        console.log(
          `  · ${row.id}: shape ${edition.shapeID} returned nil or no name`
        )
        await sleep(DELAY_MS)
        continue
      }

      const patch: Record<string, unknown> = {
        character_name: shape.name,
        franchise: shape.franchise ?? "Unknown",
        edition_type: shape.editionType ?? "Open Edition",
        variant_type: edition.variant ?? "Standard",
        updated_at: new Date().toISOString(),
      }
      if (shape.studio) patch.studio = shape.studio
      if (edition.isChaser !== null) patch.is_chaser = edition.isChaser

      if (DRY_RUN) {
        console.log(`  · ${row.id} → ${JSON.stringify(patch)}`)
        updated++
      } else {
        const { error } = await supabase
          .from("pinnacle_editions")
          .update(patch)
          .eq("id", row.id)
        if (error) {
          errs++
          console.log(`  ✗ update ${row.id}: ${error.message}`)
        } else {
          updated++
          console.log(
            `  ✓ ${row.id}: ${shape.name}${edition.variant ? ` (${edition.variant})` : ""}`
          )
        }
      }
    } catch (e) {
      errs++
      console.log(`  ✗ ${row.id}: ${(e as Error).message}`)
    }

    await sleep(DELAY_MS)
  }

  console.log("")
  console.log("═══ enrich-pinnacle-cadence summary ═══")
  console.log(`  processed: ${targets.length}`)
  console.log(`  updated:   ${updated}`)
  console.log(`  empty:     ${empty}`)
  console.log(`  errors:    ${errs}`)
  console.log("════════════════════════════════════════")
}

main().catch((err) => {
  console.error("fatal:", err)
  process.exit(1)
})
