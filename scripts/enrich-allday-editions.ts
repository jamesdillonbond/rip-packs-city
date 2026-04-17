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
const DELAY_MS = 150

if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY not set")
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

const METADATA_SCRIPT = `
import AllDay from 0xe4cf4bdc1751c65d
access(all) fun main(id: UInt64): AnyStruct {
  let ed = AllDay.getEditionData(id: id)!
  let play = AllDay.getPlayData(id: ed.playID)!
  return play.metadata
}
`.trim()

interface EditionRow {
  id: string
  external_id: string | null
}

interface MetaDict { [key: string]: string }

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function loadTargets(): Promise<EditionRow[]> {
  const { data, error } = await supabase
    .from("editions")
    .select("id, external_id")
    .eq("collection_id", ALLDAY_COLLECTION_ID)
    .is("player_name", null)
    .order("external_id", { ascending: true })
    .limit(LIMIT)
  if (error) throw new Error(`load targets: ${error.message}`)
  return (data ?? []) as EditionRow[]
}

async function fetchMetadata(editionId: string): Promise<MetaDict | null> {
  // Only integer external_ids can be cast to UInt64 (on-chain edition id).
  if (!/^\d+$/.test(editionId)) return null
  const body = {
    script: Buffer.from(METADATA_SCRIPT, "utf8").toString("base64"),
    arguments: [
      Buffer.from(
        JSON.stringify({ type: "UInt64", value: String(editionId) })
      ).toString("base64"),
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

async function main() {
  console.log(
    `[enrich-allday] starting limit=${LIMIT}${DRY_RUN ? " (dry run)" : ""}`
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

  for (let i = 0; i < targets.length; i++) {
    const ed = targets[i]
    if (!ed.external_id) {
      skippedNonInt++
      continue
    }
    if (!/^\d+$/.test(ed.external_id)) {
      skippedNonInt++
      continue
    }

    let meta: MetaDict | null = null
    try {
      meta = await fetchMetadata(ed.external_id)
    } catch (e) {
      errs++
      console.log(`  ✗ ${ed.external_id}: ${(e as Error).message}`)
      await sleep(500)
      continue
    }

    if (!meta) {
      noMeta++
      await sleep(DELAY_MS)
      continue
    }

    const patch = buildPatch(meta)
    if (!patch.player_name) {
      noMeta++
      await sleep(DELAY_MS)
      continue
    }

    if (DRY_RUN) {
      console.log(`  · ${ed.external_id} → ${JSON.stringify(patch)}`)
      updated++
    } else {
      const { error } = await supabase
        .from("editions")
        .update(patch)
        .eq("id", ed.id)
      if (error) {
        errs++
        console.log(`  ✗ update ${ed.external_id}: ${error.message}`)
      } else {
        updated++
      }
    }

    if ((i + 1) % 25 === 0) {
      console.log(
        `  progress ${i + 1}/${targets.length} | updated=${updated} no_meta=${noMeta} skipped=${skippedNonInt} errs=${errs}`
      )
    }

    await sleep(DELAY_MS)
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
