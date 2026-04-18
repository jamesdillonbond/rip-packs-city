#!/usr/bin/env node
// scripts/enrich-topshot-editions.ts
//
// Fills in thumbnail_url / tier / play_type / game_date / team_name / series
// on Top Shot editions whose external_id is the UUID pair (setUUID:playUUID).
// Goes through the Cloudflare proxy when TS_PROXY_URL is set; falls back to
// the public GQL (will hit the Cloudflare wall from most Vercel IPs, but
// works fine locally).
//
// Usage:  npx tsx scripts/enrich-topshot-editions.ts [--limit=50] [--dry-run]
// Env:    SUPABASE_URL (optional), SUPABASE_SERVICE_ROLE_KEY (required)
//         TS_PROXY_URL (optional), TS_PROXY_SECRET (optional)

import { createClient } from "@supabase/supabase-js"

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://bxcqstmqfzmuolpuynti.supabase.co"
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ""
const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const TS_PROXY_URL = process.env.TS_PROXY_URL || ""
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET || ""
const GQL_ENDPOINT = TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"

const DRY_RUN = process.argv.includes("--dry-run")
// UUID-format external_ids (setUUID:playUUID) are the default path. Pass
// --integer to instead target rows with integer setID:playID (e.g. 218:8207);
// the same searchEditions GQL query handles both — TS's API accepts either
// UUIDs or integer on-chain IDs in bySetIDs/byPlayIDs.
const INTEGER_MODE = process.argv.includes("--integer")
const LIMIT = (() => {
  const hit = process.argv.find((a) => a.startsWith("--limit="))
  const n = hit ? Number(hit.slice("--limit=".length)) : 50
  return Number.isFinite(n) && n > 0 ? n : 50
})()
const DELAY_MS = 500

if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY not set")
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

interface EditionRow {
  id: string
  external_id: string | null
  name: string | null
  thumbnail_url: string | null
  tier: string | null
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const SEARCH_QUERY = `
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
  // can't be resolved through the Play/Set GQL path regardless of mode.
  let query = supabase
    .from("editions")
    .select("id, external_id, name, thumbnail_url, tier")
    .eq("collection_id", TOPSHOT_COLLECTION_ID)
    .or("thumbnail_url.is.null,tier.is.null")

  if (INTEGER_MODE) {
    // Integer on-chain IDs: setID:playID (e.g. 218:8207).
    query = query.filter("external_id", "match", "^[0-9]+:[0-9]+$")
  } else {
    // UUID pair: setUUID:playUUID — both contain dashes, colon in the middle.
    query = query.like("external_id", "%-%:%-%")
  }

  const { data, error } = await query
    .order("external_id", { ascending: true })
    .limit(LIMIT)
  if (error) throw new Error(`load targets: ${error.message}`)
  return (data ?? []) as EditionRow[]
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
    `[enrich-topshot] starting limit=${LIMIT} mode=${INTEGER_MODE ? "integer" : "uuid"}${DRY_RUN ? " (dry run)" : ""}`
  )
  console.log(
    `[enrich-topshot] GQL endpoint: ${GQL_ENDPOINT === TS_PROXY_URL ? "via proxy" : "direct (may be Cloudflare-blocked)"}`
  )

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

    let data: Record<string, unknown> | null = null
    try {
      data = await topshotGql(SEARCH_QUERY, {
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

    // Path: data.searchEditions.searchSummary.data.data[]
    const nodes = (data as any)?.searchEditions?.searchSummary?.data?.data as GqlEdition[] | undefined
    const edition: GqlEdition | null = Array.isArray(nodes) && nodes.length > 0 ? nodes[0] : null
    if (!edition) {
      noMeta++
      await sleep(DELAY_MS)
      continue
    }

    const patch: {
      thumbnail_url?: string
      tier?: string
      play_type?: string
      game_date?: string
      team_name?: string
      series?: number
    } = {}

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

    if (Object.keys(patch).length === 0) {
      noMeta++
      await sleep(DELAY_MS)
      continue
    }

    if (DRY_RUN) {
      console.log(`  · ${extId} → ${JSON.stringify(patch)}`)
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
