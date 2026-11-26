#!/usr/bin/env node
/**
 * allday-placeholder-plays-scan.mjs — list NFL All Day plays whose ON-CHAIN metadata is a
 * placeholder (minted before the play existed), so their editions can be refreshed from All
 * Day's own record. Read-only: it reads the AllDay contract via Flow REST and prints a report.
 *
 * Why (2026-11-25): Dapper mints some plays before the play happens and fills the real play in
 * ONLY on nflallday.com — the chain keeps the filler forever:
 *   * 2025 season: description "…will have a key play added during the upcoming 2025-26
 *     season…", gameDate = the opener / draft day, empty scores, home = away = the player's team.
 *   * 2024 Rookie Debut / Marquee: a pre-draft blurb, "Invalid date", and a game the player's
 *     team is not in (every one "New England Patriots vs Indianapolis Colts").
 * Our ingest now writes NO game for such a play (allDayPlayIsPlaceholder in
 * lib/chains/flow/allday-edition-onchain.ts — this script applies the same three rules), so a
 * new one arrives with NULL game_date / home_team / away_team. This script is the queue for
 * filling those in from the real record. Runbook: docs/reference/database.md, "NFL All Day
 * placeholder plays".
 *
 * Usage:
 *   node scripts/allday-placeholder-plays-scan.mjs              # every play
 *   node scripts/allday-placeholder-plays-scan.mjs --from 5000  # plays >= 5000 only
 *   node scripts/allday-placeholder-plays-scan.mjs --json       # machine-readable
 */

const FLOW_REST = "https://rest-mainnet.onflow.org"
const ALLDAY = "0xe4cf4bdc1751c65d"
const BATCH = 250

const args = process.argv.slice(2)
const fromIdx = args.indexOf("--from")
const FROM = fromIdx >= 0 ? Number(args[fromIdx + 1]) : 1
const AS_JSON = args.includes("--json")

async function runScript(code, scriptArgs = []) {
  const body = {
    script: Buffer.from(code, "utf8").toString("base64"),
    arguments: scriptArgs.map((a) => Buffer.from(JSON.stringify(a), "utf8").toString("base64")),
  }
  const res = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`Flow script HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const raw = String(await res.json()).replace(/^"|"$/g, "")
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8"))
}

const NEXT_ID = `import AllDay from ${ALLDAY}
access(all) fun main(): UInt64 { return AllDay.nextPlayID }`

const RANGE = `import AllDay from ${ALLDAY}
access(all) fun main(a: UInt64, b: UInt64): [[String]] {
  let out: [[String]] = []
  var i = a
  while i < b {
    let p = AllDay.getPlayData(id: i)
    let m = p.metadata
    out.append([i.toString(), p.classification, m["gameDate"] ?? "", m["homeTeamName"] ?? "",
                m["awayTeamName"] ?? "", m["teamName"] ?? "", m["description"] ?? ""])
    i = i + 1
  }
  return out
}`

// Same three rules as allDayPlayIsPlaceholder (lib/chains/flow/allday-edition-onchain.ts).
function isPlaceholder({ description, home, away, team }) {
  if (/will have a key play added|key play (?:will be )?added|a play will be added|upcoming 20\d\d-\d\d season/i.test(description)) return "placeholder text"
  if (home && away && home === away) return "same team both sides"
  if (home && away && team && team !== home && team !== away) return "player's team not in the game"
  return null
}

const cdcStr = (v) => (v && typeof v === "object" && "value" in v ? String(v.value) : String(v ?? ""))

async function main() {
  const next = Number(cdcStr(await runScript(NEXT_ID)))
  const found = []
  for (let a = Math.max(1, FROM); a < next; a += BATCH) {
    const b = Math.min(next, a + BATCH)
    const res = await runScript(RANGE, [
      { type: "UInt64", value: String(a) },
      { type: "UInt64", value: String(b) },
    ])
    for (const row of res.value ?? []) {
      const [id, cls, gameDate, home, away, team, description] = (row.value ?? []).map(cdcStr)
      const reason = isPlaceholder({ description, home, away, team })
      if (reason) found.push({ play_id: Number(id), classification: cls, team, chain_game_date: gameDate, reason })
    }
  }
  if (AS_JSON) {
    console.log(JSON.stringify({ next_play_id: next, from: FROM, placeholders: found }, null, 2))
    return
  }
  console.log(`AllDay plays ${FROM}..${next - 1}: ${found.length} placeholder(s)`)
  for (const f of found) console.log(`  play ${f.play_id}  ${f.classification.padEnd(12)} ${f.team.padEnd(24)} ${f.reason}`)
  if (found.length) {
    console.log("\nEditions on these plays (run in the Supabase SQL editor / MCP):")
    console.log(
      `select external_id, player_name, set_name, game_date, home_team, away_team from editions ` +
        `where collection = 'nfl_all_day' and play_id_onchain = any('{${found.map((f) => f.play_id).join(",")}}'::int[]) ` +
        `order by external_id::int;`,
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
