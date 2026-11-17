#!/usr/bin/env node
// scripts/enrich-topshot-editions.ts
//
// Fills in thumbnail_url / tier / play_type / game_date / team_name / series
// on Top Shot editions.
//
// UUID mode (default): external_id is the UUID pair (setUUID:playUUID). Uses
// the TopShot public GraphQL, optionally via the Cloudflare proxy when
// TS_PROXY_URL is set.
//
// --integer mode: external_id is integer setID:playID (e.g. 218:8207). The
// TopShot GQL resolver rejects raw integer IDs, so this path goes straight
// to Cadence: TopShot.getPlayMetaData + TopShot.getSetSeries. Cadence can't
// return thumbnail_url or tier (not on-chain) — those have to be resolved
// another way for integer rows.
//
// Usage:  npx tsx scripts/enrich-topshot-editions.ts [--limit=50] [--dry-run] [--integer]
// Env:    SUPABASE_URL (optional), SUPABASE_SERVICE_ROLE_KEY (required)
//         TS_PROXY_URL (optional), TS_PROXY_SECRET (optional)

import { createClient } from "@supabase/supabase-js"
import * as fcl from "@onflow/fcl"
import * as t from "@onflow/types"

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://bxcqstmqfzmuolpuynti.supabase.co"
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ""
const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const TS_PROXY_URL = process.env.TS_PROXY_URL || ""
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET || ""
const GQL_ENDPOINT = TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"

const DRY_RUN = process.argv.includes("--dry-run")
// UUID-format external_ids (setUUID:playUUID) use the GQL path. Pass
// --integer to instead target rows with integer setID:playID (e.g. 218:8207);
// integer IDs can't go through the GQL resolver, so that mode uses Cadence.
const INTEGER_MODE = process.argv.includes("--integer")
// --target=player_name|set_name|nulls overrides the loadTargets OR filter
// to home in on a specific NULL cohort instead of the broad
// "missing thumbnail/tier/onchain ids" sweep. Useful when a backfill
// pass already hydrated the obvious gaps and the only rows left are the
// ones whose player_name or set_name was never written.
type TargetMode = "default" | "player_name" | "set_name" | "nulls"
const TARGET: TargetMode = (() => {
  const hit = process.argv.find((a) => a.startsWith("--target="))
  if (!hit) return "default"
  const v = hit.slice("--target=".length).trim().toLowerCase()
  if (v === "player_name" || v === "set_name" || v === "nulls") return v
  return "default"
})()
const LIMIT = (() => {
  const hit = process.argv.find((a) => a.startsWith("--limit="))
  const n = hit ? Number(hit.slice("--limit=".length)) : 50
  return Number.isFinite(n) && n > 0 ? n : 50
})()
// Cadence path is cheaper than GQL (access node with short RPC), so a tighter
// throttle is safe. UUID/GQL path uses 3-concurrent + 2s pause to mirror
// compute-topshot-pack-ev v10's anti-1015 throttle through the Cloudflare
// worker proxy. INTEGER_MODE keeps the simple sequential delay.
const DELAY_MS = INTEGER_MODE ? 150 : 0
const FETCH_CONCURRENCY = INTEGER_MODE ? 1 : 3
const BATCH_DELAY_MS = 2000

if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY not set")
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

// On-chain Series UInt32 → display name (series=1 does not exist on chain).
const SERIES_MAP: Record<number, string> = {
  0: "Series 1",
  2: "Series 2",
  3: "Summer 2021",
  4: "Series 3",
  5: "Series 4",
  6: "Series 2023-24",
  7: "Series 2024-25",
  8: "Series 2025-26",
}

if (INTEGER_MODE) {
  fcl.config()
    .put("flow.network", "mainnet")
    .put("accessNode.api", "https://rest-mainnet.onflow.org")
}

const CADENCE_GET_PLAY_META = `
import TopShot from 0x0b2a3299cc857e29

access(all) fun main(playID: UInt32): {String: String} {
    return TopShot.getPlayMetaData(playID: playID) ?? {}
}
`.trim()

const CADENCE_GET_SET_SERIES = `
import TopShot from 0x0b2a3299cc857e29

access(all) fun main(setID: UInt32): UInt32? {
    return TopShot.getSetSeries(setID: setID)
}
`.trim()

const CADENCE_GET_SET_NAME = `
import TopShot from 0x0b2a3299cc857e29

access(all) fun main(setID: UInt32): String? {
    return TopShot.getSetName(setID: setID)
}
`.trim()

interface EditionRow {
  id: string
  external_id: string | null
  name: string | null
  thumbnail_url: string | null
  tier: string | null
  player_name: string | null
  set_name: string | null
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// UUID path: uses the complex filters.bySetIDs/byPlayIDs shape that returns
// data under searchEditions.searchSummary.data.data.
const SEARCH_QUERY_UUID = `
  query EnrichEdition($input: SearchEditionsInput!) {
    searchEditions(input: $input) {
      searchSummary {
        data {
          ... on Editions {
            data {
              ... on Edition {
                tier
                assetPathPrefix
                set {
                  flowId
                  flowName
                  flowSeriesNumber
                }
                play {
                  flowID
                  stats {
                    playerName
                    teamAtMoment
                    playCategory
                    dateOfMoment
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`.trim()

interface GqlEdition {
  play?: {
    flowID?: string | null
    stats?: {
      playerName?: string | null
      teamAtMoment?: string | null
      playCategory?: string | null
      dateOfMoment?: string | null
    } | null
  } | null
  set?: { flowId?: string | null; flowName?: string | null; flowSeriesNumber?: number | null } | null
  tier?: string | null
  assetPathPrefix?: string | null
}

async function topshotGql(
  query: string,
  variables: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (TS_PROXY_URL && TS_PROXY_SECRET) headers["X-Proxy-Secret"] = TS_PROXY_SECRET
  const res = await fetch(GQL_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`GQL ${res.status}: ${text.slice(0, 200)}`)
  }
  const json = (await res.json()) as { data?: Record<string, unknown>; errors?: Array<{ message: string }> }
  if (json.errors && json.errors.length > 0) {
    throw new Error(json.errors[0].message)
  }
  return json.data ?? null
}

async function loadTargets(): Promise<EditionRow[]> {
  // Skip rows like "locked_<nftid>" created by the lock-refresh flow — they
  // can't be resolved through the Play/Set path regardless of mode.
  let query = supabase
    .from("editions")
    .select("id, external_id, name, thumbnail_url, tier, player_name, set_name")
    .eq("collection_id", TOPSHOT_COLLECTION_ID)

  if (INTEGER_MODE) {
    // Integer on-chain IDs: setID:playID (e.g. 218:8207). These have a colon
    // but no dashes and don't start with the "locked_" prefix. PostgREST has
    // no regex operator via supabase-js, so we combine positive/negative LIKE.
    // Cadence fills the on-chain-resolvable columns only: play_type, game_date,
    // team_name, series, player_name — thumbnail_url/tier aren't on-chain.
    query = query
      .like("external_id", "%:%")
      .not("external_id", "like", "%-%")
      .not("external_id", "like", "locked%")
    if (TARGET === "player_name") {
      query = query.or("player_name.is.null,player_name.eq.")
    } else if (TARGET === "set_name") {
      query = query.or("set_name.is.null,set_name.eq.")
    } else if (TARGET === "nulls") {
      query = query.or("player_name.is.null,player_name.eq.,set_name.is.null,set_name.eq.")
    } else {
      query = query.or(
        "play_type.is.null,game_date.is.null,team_name.is.null,series.is.null,player_name.is.null,player_name.eq."
      )
    }
  } else {
    // UUID pair: setUUID:playUUID — both contain dashes, colon in the middle.
    query = query.like("external_id", "%-%:%-%")
    // Filter selection. The default broad sweep keeps the prior behavior;
    // targeted modes only fetch rows where the named column is NULL/empty so
    // a small residual cohort isn't drowned out by the larger general one.
    if (TARGET === "player_name") {
      query = query.or("player_name.is.null,player_name.eq.")
    } else if (TARGET === "set_name") {
      query = query.or("set_name.is.null,set_name.eq.")
    } else if (TARGET === "nulls") {
      query = query.or("player_name.is.null,player_name.eq.,set_name.is.null,set_name.eq.")
    } else {
      // Default: everything from before, plus player_name / set_name so the
      // filter actually reaches rows where only the denormalised name columns
      // are NULL (set_id_onchain etc. may already be hydrated).
      query = query.or(
        "thumbnail_url.is.null,tier.is.null,set_id_onchain.is.null,play_id_onchain.is.null,player_name.is.null,player_name.eq.,set_name.is.null,set_name.eq."
      )
    }
  }

  const { data, error } = await query
    .order("external_id", { ascending: true })
    .limit(LIMIT)
  if (error) throw new Error(`load targets: ${error.message}`)
  return (data ?? []) as EditionRow[]
}

type CadencePatch = {
  play_type?: string
  game_date?: string
  team_name?: string
  series?: number
  player_name?: string
  set_name?: string
}

async function enrichViaCadence(
  ed: EditionRow,
  setId: string,
  playId: string
): Promise<CadencePatch> {
  const patch: CadencePatch = {}

  // Call 1: play metadata
  const meta = (await fcl.query({
    cadence: CADENCE_GET_PLAY_META,
    args: (arg: any) => [arg(String(playId), t.UInt32)],
  })) as Record<string, string> | null

  if (meta) {
    if (meta.PlayCategory) patch.play_type = meta.PlayCategory
    const gd = normDate(meta.DateOfMoment)
    if (gd) patch.game_date = gd
    if (meta.TeamAtMoment) patch.team_name = meta.TeamAtMoment
    if (!ed.player_name && meta.FullName) patch.player_name = meta.FullName
  }

  // Call 2: set series (nullable UInt32)
  const seriesRaw = (await fcl.query({
    cadence: CADENCE_GET_SET_SERIES,
    args: (arg: any) => [arg(String(setId), t.UInt32)],
  })) as string | number | null

  if (seriesRaw != null) {
    const seriesNum = Number(seriesRaw)
    if (Number.isFinite(seriesNum)) patch.series = seriesNum
  }

  // Call 3: set name (nullable String). Drains the 4 integer-format
  // NULL set_name rows that the GQL UUID path can't reach.
  const nameRaw = (await fcl.query({
    cadence: CADENCE_GET_SET_NAME,
    args: (arg: any) => [arg(String(setId), t.UInt32)],
  })) as string | null

  if (nameRaw && typeof nameRaw === "string") patch.set_name = nameRaw.trim()

  return patch
}

function normDate(raw: string | null | undefined): string | null {
  if (!raw) return null
  const t = Date.parse(raw)
  if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10)
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10)
  return null
}

async function main() {
  console.log(
    `[enrich-topshot] starting limit=${LIMIT} mode=${INTEGER_MODE ? "integer-cadence" : "uuid-gql"}${DRY_RUN ? " (dry run)" : ""}`
  )
  if (!INTEGER_MODE) {
    console.log(
      `[enrich-topshot] GQL endpoint: ${GQL_ENDPOINT === TS_PROXY_URL ? "via proxy" : "direct (may be Cloudflare-blocked)"}`
    )
  } else {
    console.log(`[enrich-topshot] Flow access node: https://rest-mainnet.onflow.org`)
  }

  const targets = await loadTargets()
  console.log(
    `[enrich-topshot] ${targets.length} ${INTEGER_MODE ? "integer" : "UUID"} editions missing data`
  )
  if (targets.length === 0) {
    console.log("nothing to do.")
    return
  }

  let updated = 0
  let noMeta = 0
  let errs = 0

  type RowOutcome = "updated" | "no_meta" | "error"

  async function processOne(ed: EditionRow): Promise<RowOutcome> {
    const extId = ed.external_id
    if (!extId) return "no_meta"
    const [setId, playId] = extId.split(":")
    if (!setId || !playId) return "no_meta"

    const patch: {
      thumbnail_url?: string
      tier?: string
      play_type?: string
      game_date?: string
      team_name?: string
      series?: number
      player_name?: string
      set_name?: string
      set_id_onchain?: number
      play_id_onchain?: number
    } = {}

    if (INTEGER_MODE) {
      try {
        const cadencePatch = await enrichViaCadence(ed, setId, playId)
        Object.assign(patch, cadencePatch)
      } catch (e) {
        console.log(`  ✗ ${extId}: ${(e as Error).message}`)
        return "error"
      }
    } else {
      let data: Record<string, unknown> | null = null
      try {
        data = await topshotGql(SEARCH_QUERY_UUID, {
          input: {
            filters: { bySetIDs: [setId], byPlayIDs: [playId] },
            searchInput: { pagination: { cursor: "", direction: "RIGHT", limit: 1 } },
          },
        })
      } catch (e) {
        console.log(`  ✗ ${extId}: ${(e as Error).message}`)
        return "error"
      }

      const nodes = (data as any)?.searchEditions?.searchSummary?.data?.data as GqlEdition[] | undefined
      const edition: GqlEdition | null = Array.isArray(nodes) && nodes.length > 0 ? nodes[0] : null
      if (!edition) return "no_meta"

      if (!ed.thumbnail_url && edition.assetPathPrefix) {
        patch.thumbnail_url = `${edition.assetPathPrefix}image`.replace(/\/?image$/, "/image")
      }
      if (!ed.tier && edition.tier) {
        patch.tier = String(edition.tier).replace(/^MOMENT_TIER_/, "").toUpperCase()
      }

      const playCategory = edition.play?.stats?.playCategory ?? null
      if (playCategory) patch.play_type = playCategory
      const gameDate = normDate(edition.play?.stats?.dateOfMoment ?? null)
      if (gameDate) patch.game_date = gameDate
      const team = edition.play?.stats?.teamAtMoment ?? null
      if (team) patch.team_name = team
      const seriesNum = edition.set?.flowSeriesNumber
      if (seriesNum != null && Number.isFinite(Number(seriesNum))) {
        patch.series = Number(seriesNum)
      }
      const setFlowId = edition.set?.flowId
      if (setFlowId != null) {
        const n = Number(setFlowId)
        if (Number.isFinite(n)) patch.set_id_onchain = n
      }
      const playFlowId = edition.play?.flowID
      if (playFlowId != null) {
        const n = Number(playFlowId)
        if (Number.isFinite(n)) patch.play_id_onchain = n
      }
      const playerName = edition.play?.stats?.playerName ?? null
      if (playerName && (!ed.player_name || ed.player_name === "")) {
        patch.player_name = String(playerName).trim()
      }
      const setName = edition.set?.flowName ?? null
      if (setName && (!ed.set_name || ed.set_name === "")) {
        patch.set_name = String(setName).trim()
      }
    }

    if (Object.keys(patch).length === 0) return "no_meta"

    if (DRY_RUN) {
      const seriesLabel =
        patch.series != null ? ` (${SERIES_MAP[patch.series] ?? `series ${patch.series}`})` : ""
      console.log(`  · ${extId} → ${JSON.stringify(patch)}${seriesLabel}`)
      return "updated"
    }
    const { error } = await supabase.from("editions").update(patch).eq("id", ed.id)
    if (error) {
      console.log(`  ✗ update ${extId}: ${error.message}`)
      return "error"
    }
    return "updated"
  }

  // Batched concurrency: 3 in flight + 2s pause between batches in UUID-mode
  // (matches compute-topshot-pack-ev v10's anti-1015 throttle through the
  // Cloudflare worker proxy). INTEGER_MODE stays sequential because the
  // fcl client holds shared global state.
  for (let i = 0; i < targets.length; i += FETCH_CONCURRENCY) {
    const chunk = targets.slice(i, i + FETCH_CONCURRENCY)
    const results = await Promise.allSettled(chunk.map(processOne))
    for (const r of results) {
      if (r.status === "rejected") { errs++; continue }
      if (r.value === "updated") updated++
      else if (r.value === "no_meta") noMeta++
      else if (r.value === "error") errs++
    }
    const done = Math.min(i + FETCH_CONCURRENCY, targets.length)
    if (done % 12 === 0 || done === targets.length) {
      console.log(
        `  progress ${done}/${targets.length} | updated=${updated} no_meta=${noMeta} errs=${errs}`
      )
    }
    if (done < targets.length) {
      await sleep(INTEGER_MODE ? DELAY_MS : BATCH_DELAY_MS)
    }
  }

  console.log("")
  console.log("═══ enrich-topshot summary ═══")
  console.log(`  processed:  ${targets.length}`)
  console.log(`  updated:    ${updated}`)
  console.log(`  no meta:    ${noMeta}`)
  console.log(`  errors:     ${errs}`)
  console.log("═══════════════════════════════")
}

main().catch((err) => {
  console.error("fatal:", err)
  process.exit(1)
})
