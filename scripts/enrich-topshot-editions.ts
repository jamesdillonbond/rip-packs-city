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
const LIMIT = (() => {
  const hit = process.argv.find((a) => a.startsWith("--limit="))
  const n = hit ? Number(hit.slice("--limit=".length)) : 50
  return Number.isFinite(n) && n > 0 ? n : 50
})()
// Cadence path is cheaper than GQL (access node with short RPC), so a tighter
// throttle is safe. GQL path keeps the prior 500ms to avoid tripping rate
// limits on the proxy / TopShot API.
const DELAY_MS = INTEGER_MODE ? 150 : 500

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

interface EditionRow {
  id: string
  external_id: string | null
  name: string | null
  thumbnail_url: string | null
  tier: string | null
  player_name: string | null
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
    .select("id, external_id, name, thumbnail_url, tier, player_name")
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
      .or("play_type.is.null,game_date.is.null,team_name.is.null,series.is.null,player_name.is.null")
  } else {
    // UUID pair: setUUID:playUUID — both contain dashes, colon in the middle.
    query = query
      .like("external_id", "%-%:%-%")
      .or("thumbnail_url.is.null,tier.is.null")
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

  for (let i = 0; i < targets.length; i++) {
    const ed = targets[i]
    const extId = ed.external_id
    if (!extId) continue
    const [setId, playId] = extId.split(":")
    if (!setId || !playId) {
      noMeta++
      continue
    }

    const patch: {
      thumbnail_url?: string
      tier?: string
      play_type?: string
      game_date?: string
      team_name?: string
      series?: number
      player_name?: string
    } = {}

    if (INTEGER_MODE) {
      try {
        const cadencePatch = await enrichViaCadence(ed, setId, playId)
        Object.assign(patch, cadencePatch)
      } catch (e) {
        errs++
        console.log(`  ✗ ${extId}: ${(e as Error).message}`)
        await sleep(DELAY_MS * 2)
        continue
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
        errs++
        console.log(`  ✗ ${extId}: ${(e as Error).message}`)
        await sleep(DELAY_MS * 2)
        continue
      }

      const nodes = (data as any)?.searchEditions?.searchSummary?.data?.data as GqlEdition[] | undefined
      const edition: GqlEdition | null = Array.isArray(nodes) && nodes.length > 0 ? nodes[0] : null
      if (!edition) {
        noMeta++
        await sleep(DELAY_MS)
        continue
      }

      if (!ed.thumbnail_url && edition.assetPathPrefix) {
        patch.thumbnail_url = `${edition.assetPathPrefix}image`.replace(
          /\/?image$/,
          "/image"
        )
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
    }

    if (Object.keys(patch).length === 0) {
      noMeta++
      await sleep(DELAY_MS)
      continue
    }

    if (DRY_RUN) {
      const seriesLabel =
        patch.series != null ? ` (${SERIES_MAP[patch.series] ?? `series ${patch.series}`})` : ""
      console.log(`  · ${extId} → ${JSON.stringify(patch)}${seriesLabel}`)
      updated++
    } else {
      const { error } = await supabase
        .from("editions")
        .update(patch)
        .eq("id", ed.id)
      if (error) {
        errs++
        console.log(`  ✗ update ${extId}: ${error.message}`)
      } else {
        updated++
      }
    }

    if ((i + 1) % 10 === 0) {
      console.log(
        `  progress ${i + 1}/${targets.length} | updated=${updated} no_meta=${noMeta} errs=${errs}`
      )
    }

    await sleep(DELAY_MS)
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
