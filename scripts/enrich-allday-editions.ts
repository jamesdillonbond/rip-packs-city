#!/usr/bin/env node
// scripts/enrich-allday-editions.ts
//
// Fills in player_name / team_name / play_type / game_date on AllDay
// editions whose rows were created from sales/listings with only the set
// name attached (e.g., "Iconic", "Make the Stop"). The player is
// on-chain in AllDay.EditionData.metadata, so we pull it via a Cadence
// script against the Flow Access Node.
//
// Usage:
//   npx tsx scripts/enrich-allday-editions.ts [--limit=100] [--dry-run]
//
// Env:   SUPABASE_URL (optional), SUPABASE_SERVICE_ROLE_KEY (required)

import { createClient } from "@supabase/supabase-js"

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://bxcqstmqfzmuolpuynti.supabase.co"
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ""
const FLOW_REST = "https://rest-mainnet.onflow.org"
const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"

const DRY_RUN = process.argv.includes("--dry-run")
const LIMIT = (() => {
  const hit = process.argv.find((a) => a.startsWith("--limit="))
  const n = hit ? Number(hit.slice("--limit=".length)) : 100
  return Number.isFinite(n) && n > 0 ? n : 100
})()
// Match compute-topshot-pack-ev v10 throttle (3 in flight, 2s between batches).
// Flow REST is not behind Cloudflare, but the same shape keeps the script
// well-behaved against any access-node burst limits.
const FETCH_CONCURRENCY = 3
const BATCH_DELAY_MS = 2000

if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY not set")
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

// Resolve metadata from the editionID side. Some legacy rows (e.g. the
// 36 NFL Draft 2025 entries at editionID 4102+) point at Plays whose
// metadata has only {gameDate, description, playType} and no player
// fields — those will round-trip with no usable patch.
const METADATA_BY_EDITION_SCRIPT = `
import AllDay from 0xe4cf4bdc1751c65d
access(all) fun main(id: UInt64): AnyStruct {
  let ed = AllDay.getEditionData(id: id)!
  let play = AllDay.getPlayData(id: ed.playID)!
  return play.metadata
}
`.trim()

// Fallback: for rows where AllDay.getEditionData(id: external_id) returns
// nil (script 400s on the unwrap), use play_id_onchain to skip straight
// to the Play. This is the column captured at ingest time; it survives
// even when the edition row was minted under a now-burned/legacy id.
const METADATA_BY_PLAY_SCRIPT = `
import AllDay from 0xe4cf4bdc1751c65d
access(all) fun main(id: UInt64): AnyStruct {
  let play = AllDay.getPlayData(id: id)!
  return play.metadata
}
`.trim()

interface EditionRow {
  id: string
  external_id: string | null
  play_id_onchain: number | null
}

interface MetaDict { [key: string]: string }

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function loadTargets(): Promise<EditionRow[]> {
  // player_name IS NULL OR player_name = '' covers both shapes the
  // ingest pipeline emits when a Play's metadata is missing playerName.
  const { data, error } = await supabase
    .from("editions")
    .select("id, external_id, play_id_onchain")
    .eq("collection_id", ALLDAY_COLLECTION_ID)
    .or("player_name.is.null,player_name.eq.")
    .order("external_id", { ascending: true })
    .limit(LIMIT)
  if (error) throw new Error(`load targets: ${error.message}`)
  return (data ?? []) as EditionRow[]
}

async function runCadenceMetaScript(
  script: string,
  uint64Id: string
): Promise<MetaDict | null> {
  const body = {
    script: Buffer.from(script, "utf8").toString("base64"),
    arguments: [
      Buffer.from(JSON.stringify({ type: "UInt64", value: uint64Id })).toString("base64"),
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
    throw new Error(`script HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  const raw = (await res.text()).trim().replace(/^"|"$/g, "")
  const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as {
    type?: string
    value?: Array<{ key: { value: string }; value: { value: string } }>
  }
  const out: MetaDict = {}
  for (const entry of decoded?.value ?? []) {
    const k = entry.key?.value
    const v = entry.value?.value
    if (typeof k === "string" && typeof v === "string") out[k] = v
  }
  return Object.keys(out).length > 0 ? out : null
}

// Resolve play metadata for a single edition row. Tries the editionID
// route first (works for 99% of rows); on HTTP 400 from the Cadence
// unwrap or empty metadata, falls back to play_id_onchain when present.
// Returns null when neither route yields metadata.
async function resolveMetadata(ed: EditionRow): Promise<MetaDict | null> {
  let edError: Error | null = null
  if (ed.external_id && /^\d+$/.test(ed.external_id)) {
    try {
      const meta = await runCadenceMetaScript(METADATA_BY_EDITION_SCRIPT, ed.external_id)
      if (meta) return meta
    } catch (e) {
      edError = e as Error
    }
  }
  if (ed.play_id_onchain != null && Number.isFinite(ed.play_id_onchain)) {
    try {
      const meta = await runCadenceMetaScript(METADATA_BY_PLAY_SCRIPT, String(ed.play_id_onchain))
      if (meta) return meta
    } catch (e) {
      // If both routes fail, surface the editionID error first since it's
      // the more common path. Re-throw so the caller logs and skips.
      throw edError ?? e
    }
  }
  if (edError) throw edError
  return null
}

function normDate(raw: string | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  // AllDay metadata commonly surfaces dates as ISO "2024-09-08T00:00:00Z"
  // or plain YYYY-MM-DD. Fall back to first 10 chars when the full ISO
  // string parses cleanly.
  const t = Date.parse(trimmed)
  if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10)
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10)
  return null
}

function buildPatch(meta: MetaDict) {
  const first = (meta.playerFirstName ?? "").trim()
  const last = (meta.playerLastName ?? "").trim()
  const fullFromParts = [first, last].filter(Boolean).join(" ").trim()
  const teamNameRaw = (meta.teamName ?? "").trim()
  const playerName = fullFromParts || teamNameRaw || null

  const patch: {
    player_name?: string
    team_name?: string
    play_type?: string
    game_date?: string
  } = {}
  if (playerName) patch.player_name = playerName
  if (teamNameRaw) patch.team_name = teamNameRaw
  const playType = (meta.playType ?? "").trim()
  if (playType) patch.play_type = playType
  const gameDate = normDate(meta.gameDate ?? meta.playDate ?? meta.mintingDate)
  if (gameDate) patch.game_date = gameDate
  return patch
}

async function processOne(ed: EditionRow): Promise<"updated" | "no_meta" | "skipped" | "error"> {
  // Skip rows that have neither a usable editionID nor a play_id_onchain.
  const usableEdId = ed.external_id && /^\d+$/.test(ed.external_id)
  if (!usableEdId && ed.play_id_onchain == null) return "skipped"

  let meta: MetaDict | null = null
  try {
    meta = await resolveMetadata(ed)
  } catch (e) {
    console.log(`  ✗ ${ed.external_id ?? "?"} (play=${ed.play_id_onchain ?? "?"}): ${(e as Error).message}`)
    return "error"
  }

  if (!meta) return "no_meta"

  const patch = buildPatch(meta)
  if (!patch.player_name) return "no_meta"

  if (DRY_RUN) {
    console.log(`  · ${ed.external_id ?? "?"} → ${JSON.stringify(patch)}`)
    return "updated"
  }
  const { error } = await supabase.from("editions").update(patch).eq("id", ed.id)
  if (error) {
    console.log(`  ✗ update ${ed.external_id ?? "?"}: ${error.message}`)
    return "error"
  }
  return "updated"
}

async function main() {
  console.log(
    `[enrich-allday] starting limit=${LIMIT}${DRY_RUN ? " (dry run)" : ""} concurrency=${FETCH_CONCURRENCY} batch_delay=${BATCH_DELAY_MS}ms`
  )

  const targets = await loadTargets()
  console.log(`[enrich-allday] ${targets.length} editions missing player_name`)
  if (targets.length === 0) {
    console.log("nothing to do.")
    return
  }

  let updated = 0
  let skippedNonInt = 0
  let noMeta = 0
  let errs = 0

  for (let i = 0; i < targets.length; i += FETCH_CONCURRENCY) {
    const chunk = targets.slice(i, i + FETCH_CONCURRENCY)
    const results = await Promise.allSettled(chunk.map(processOne))
    for (const r of results) {
      if (r.status === "rejected") { errs++; continue }
      if (r.value === "updated") updated++
      else if (r.value === "no_meta") noMeta++
      else if (r.value === "skipped") skippedNonInt++
      else if (r.value === "error") errs++
    }
    const done = Math.min(i + FETCH_CONCURRENCY, targets.length)
    if (done % 12 === 0 || done === targets.length) {
      console.log(
        `  progress ${done}/${targets.length} | updated=${updated} no_meta=${noMeta} skipped=${skippedNonInt} errs=${errs}`
      )
    }
    if (done < targets.length) await sleep(BATCH_DELAY_MS)
  }

  console.log("")
  console.log("═══ enrich-allday summary ═══")
  console.log(`  processed:        ${targets.length}`)
  console.log(`  updated:          ${updated}`)
  console.log(`  no metadata:      ${noMeta}`)
  console.log(`  skipped non-int:  ${skippedNonInt}`)
  console.log(`  errors:           ${errs}`)
  console.log("═════════════════════════════")
}

main().catch((err) => {
  console.error("fatal:", err)
  process.exit(1)
})
