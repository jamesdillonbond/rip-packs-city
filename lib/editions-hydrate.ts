// Shared edition-metadata hydrators for Top Shot and NFL All Day.
//
// Used by hydrate-at-insert paths (flowty-sales, flowty-listings, allday-pack-ev,
// compute-topshot-pack-ev) and by scripts/backfill-residual-edition-metadata.mjs.
//
// Hydrators take external_id strings, fetch metadata from the upstream GraphQL,
// and return rows shaped for direct upsert into editions. Rows that fail to
// resolve (404 / null fields) come back with player_name=null and ok=false, so
// callers can choose to skeleton-insert or skip.
//
// Top Shot: setUUID:playUUID format (from parallelSetPlay.set.id / play.id),
// resolved via getPlay + getSet GraphQL through TS_PROXY_URL when set.
// Top Shot integer-pair format (setID:playID) is also accepted — those keys
// route through the same GetPlay/GetSet calls (the GQL accepts both id forms).
//
// NFL All Day: bare integer external_ids (e.g. "4102") and UUID:UUID, resolved
// against the consumer GQL endpoint by paginating allEditions and matching.
// One bulk pull per process; cached in-module for the run.

const TOPSHOT_GQL_DEFAULT = "https://public-api.nbatopshot.com/graphql"
const ALLDAY_GQL_DEFAULT = "https://nflallday.com/consumer/graphql"
const PER_REQUEST_TIMEOUT_MS = 8_000

export interface HydratedEditionRow {
  external_id: string
  collection_id: string
  collection?: string | null
  name: string | null
  player_name: string | null
  set_name: string | null
  team_name?: string | null
  tier: string | null
  series: number | null
  circulation_count: number | null
  set_id_onchain?: number | null
  play_id_onchain?: number | null
  play_type?: string | null
  game_date?: string | null
  home_team?: string | null
  away_team?: string | null
  updated_at: string
  ok: boolean
}

const TS_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"

// ── Top Shot ─────────────────────────────────────────────────────────────────

// Single allowlisted query that returns set + play.stats + tier + circulation
// in one round trip. Discovered 2026-05-02 after the public-api schema dropped
// the standalone getPlay/getSet response shapes; only the searchEditions
// pattern (with plural bySetIDs/byPlayIDs filters and the searchSummary →
// Editions → Edition union path) is on the operation safelist.
const SEARCH_EDITION_QUERY = `
  query SearchEditionBackfill($input: SearchEditionsInput!) {
    searchEditions(input: $input) {
      searchSummary {
        data {
          ... on Editions {
            data {
              ... on Edition {
                tier
                circulationCount
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
                    teamAtMomentNbaId
                    playCategory
                    playType
                    dateOfMoment
                    homeTeamName
                    awayTeamName
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`

interface TsProxyConfig {
  url: string
  secret: string | null
}

function tsProxyConfig(): TsProxyConfig {
  return {
    url: process.env.TS_PROXY_URL || TOPSHOT_GQL_DEFAULT,
    secret: process.env.TS_PROXY_SECRET || null,
  }
}

async function tsGql<T>(
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): Promise<T | null> {
  const cfg = tsProxyConfig()
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "rip-packs-city/editions-hydrate",
  }
  if (cfg.secret) headers["X-Proxy-Secret"] = cfg.secret
  const body: Record<string, unknown> = { query, variables }
  if (operationName) body.operationName = operationName
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { data?: T; errors?: unknown[] }
    if (Array.isArray(json.errors) && json.errors.length > 0) return null
    return json.data ?? null
  } catch {
    return null
  }
}

interface TsEditionMeta {
  playerName: string | null
  setName: string | null
  series: number | null
  tier: string | null
  circulation: number | null
  teamName: string | null
  playCategory: string | null
  playType: string | null
  gameDate: string | null
  homeTeam: string | null
  awayTeam: string | null
}

function normalizeTsTier(raw: string | null | undefined): string | null {
  if (!raw) return null
  const t = String(raw).toUpperCase()
  if (t.includes("ULTIMATE")) return "ULTIMATE"
  if (t.includes("LEGENDARY")) return "LEGENDARY"
  if (t.includes("RARE")) return "RARE"
  if (t.includes("FANDOM")) return "FANDOM"
  if (t.includes("COMMON")) return "COMMON"
  return null
}

async function fetchTsEditionMeta(
  setID: string,
  playID: string,
): Promise<TsEditionMeta | null> {
  type Resp = {
    searchEditions?: {
      searchSummary?: {
        data?: {
          data?: Array<{
            tier?: string | null
            circulationCount?: number | null
            set?: {
              flowId?: number | string | null
              flowName?: string | null
              flowSeriesNumber?: number | null
            } | null
            play?: {
              flowID?: string | null
              stats?: {
                playerName?: string | null
                teamAtMoment?: string | null
                teamAtMomentNbaId?: string | null
                playCategory?: string | null
                playType?: string | null
                dateOfMoment?: string | null
                homeTeamName?: string | null
                awayTeamName?: string | null
              } | null
            } | null
          }>
        } | null
      } | null
    } | null
  }
  const data = await tsGql<Resp>(
    SEARCH_EDITION_QUERY,
    {
      input: {
        filters: { bySetIDs: [setID], byPlayIDs: [playID] },
        searchInput: { pagination: { cursor: "", direction: "RIGHT", limit: 1 } },
      },
    },
    "SearchEditionBackfill",
  )
  const row = data?.searchEditions?.searchSummary?.data?.data?.[0]
  if (!row) return null
  const s = row.play?.stats ?? {}
  const dateOfMoment = s.dateOfMoment ?? null
  const dateSlice = dateOfMoment ? String(dateOfMoment).slice(0, 10) : null
  const gameDate = dateSlice && /^\d{4}-\d{2}-\d{2}$/.test(dateSlice) ? dateSlice : null
  return {
    playerName: s.playerName ? String(s.playerName).trim() : null,
    setName: row.set?.flowName ? String(row.set.flowName).trim() : null,
    series: row.set?.flowSeriesNumber != null ? Number(row.set.flowSeriesNumber) : null,
    tier: normalizeTsTier(row.tier),
    circulation: row.circulationCount ?? null,
    teamName: s.teamAtMoment ?? null,
    playCategory: s.playCategory ?? null,
    playType: s.playType ?? null,
    gameDate,
    homeTeam: s.homeTeamName ?? null,
    awayTeam: s.awayTeamName ?? null,
  }
}

function splitTsExternalId(extId: string): { setID: string; playID: string } | null {
  const parts = extId.split(":")
  if (parts.length !== 2) return null
  const [setID, playID] = parts
  if (!setID || !playID) return null
  return { setID, playID }
}

export async function hydrateTopShotEditions(
  externalIds: string[],
): Promise<HydratedEditionRow[]> {
  const now = new Date().toISOString()
  const out: HydratedEditionRow[] = []
  const unique = Array.from(new Set(externalIds.filter(Boolean)))

  for (const extId of unique) {
    const split = splitTsExternalId(extId)
    if (!split) {
      out.push(emptyRow(extId, TS_COLLECTION_ID, "nba_top_shot", now))
      continue
    }
    const { setID, playID } = split
    const meta = await fetchTsEditionMeta(setID, playID)

    const playerName = meta?.playerName ?? null
    const setName = meta?.setName ?? null
    const name =
      playerName && setName ? `${playerName} — ${setName}` : playerName ?? setName

    const intPair = /^\d+:\d+$/.test(extId)
    const setIdOnchain = intPair ? Number(setID) : null
    const playIdOnchain = intPair ? Number(playID) : null

    out.push({
      external_id: extId,
      collection_id: TS_COLLECTION_ID,
      collection: "nba_top_shot",
      name,
      player_name: playerName,
      set_name: setName,
      team_name: meta?.teamName ?? null,
      tier: meta?.tier ?? null,
      series: meta?.series ?? null,
      circulation_count: meta?.circulation ?? null,
      set_id_onchain: setIdOnchain ?? undefined,
      play_id_onchain: playIdOnchain ?? undefined,
      play_type: meta?.playType ?? null,
      game_date: meta?.gameDate ?? null,
      home_team: meta?.homeTeam ?? null,
      away_team: meta?.awayTeam ?? null,
      updated_at: now,
      ok: Boolean(playerName),
    })
  }

  return out
}

// ── NFL All Day ──────────────────────────────────────────────────────────────

const ALLDAY_RELAY_QUERY = `
  query SeedEditions($first: Int!, $after: String) {
    allEditions(first: $first, after: $after) {
      edges {
        node {
          id
          circulationCount
          tier
          series { name number }
          set { name id }
          play {
            id
            playerName
            description
            team { name }
            classification
            gameDate
            awayTeamName
            homeTeamName
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

interface AllDayEditionMeta {
  external_id: string
  player_name: string | null
  set_name: string | null
  team_name: string | null
  tier: string | null
  series: number | null
  circulation_count: number | null
  play_type: string | null
  game_date: string | null
  home_team: string | null
  away_team: string | null
}

let alldayCachePromise: Promise<Map<string, AllDayEditionMeta>> | null = null

function alldayHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "rip-packs-city/editions-hydrate",
  }
  if (process.env.AD_PROXY_URL && process.env.TS_PROXY_SECRET) {
    h["X-Proxy-Secret"] = process.env.TS_PROXY_SECRET
  }
  return h
}

function alldayUrl(): string {
  return process.env.AD_PROXY_URL || ALLDAY_GQL_DEFAULT
}

function normalizeAllDayTier(raw: string | null | undefined): string | null {
  if (!raw) return null
  const t = String(raw).toUpperCase()
  if (t.includes("ULTIMATE")) return "ULTIMATE"
  if (t.includes("LEGENDARY")) return "LEGENDARY"
  if (t.includes("RARE")) return "RARE"
  if (t.includes("COMMON")) return "COMMON"
  return null
}

async function fetchAllDayMap(): Promise<Map<string, AllDayEditionMeta>> {
  if (alldayCachePromise) return alldayCachePromise
  alldayCachePromise = (async () => {
    const map = new Map<string, AllDayEditionMeta>()
    const url = alldayUrl()
    const headers = alldayHeaders()
    let after: string | null = null
    for (let page = 0; page < 50; page++) {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: ALLDAY_RELAY_QUERY,
          variables: { first: 100, after },
        }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) break
      const json = (await res.json().catch(() => null)) as
        | { data?: { allEditions?: { edges?: Array<{ node: any }>; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } }; errors?: unknown[] }
        | null
      if (!json || (Array.isArray(json.errors) && json.errors.length > 0)) break
      const conn = json.data?.allEditions
      const edges = conn?.edges ?? []
      for (const edge of edges) {
        const n = edge?.node
        if (!n) continue
        const setId = n.set?.id ?? null
        const playId = n.play?.id ?? null
        const composite = setId && playId ? `${setId}:${playId}` : null
        const gqlId = n.id ?? null
        const meta: AllDayEditionMeta = {
          external_id: composite ?? gqlId ?? "",
          player_name: n.play?.playerName ?? null,
          set_name: n.set?.name ?? null,
          team_name: n.play?.team?.name ?? null,
          tier: normalizeAllDayTier(n.tier),
          series: n.series?.number ?? null,
          circulation_count: n.circulationCount ?? null,
          play_type: n.play?.classification ?? null,
          game_date: n.play?.gameDate ?? null,
          home_team: n.play?.homeTeamName ?? null,
          away_team: n.play?.awayTeamName ?? null,
        }
        // Index under both composite and bare-gqlId so callers can hit either.
        if (composite) map.set(composite, { ...meta, external_id: composite })
        if (gqlId) map.set(String(gqlId), { ...meta, external_id: String(gqlId) })
      }
      if (!conn?.pageInfo?.hasNextPage) break
      after = conn.pageInfo.endCursor ?? null
      if (!after) break
    }
    return map
  })()
  return alldayCachePromise
}

export function resetAllDayCache(): void {
  alldayCachePromise = null
}

export async function hydrateAllDayEditions(
  externalIds: string[],
): Promise<HydratedEditionRow[]> {
  const now = new Date().toISOString()
  const unique = Array.from(new Set(externalIds.filter(Boolean)))
  const map = await fetchAllDayMap()
  const out: HydratedEditionRow[] = []
  for (const extId of unique) {
    const meta = map.get(extId)
    if (!meta) {
      out.push(emptyRow(extId, ALLDAY_COLLECTION_ID, "nfl_all_day", now))
      continue
    }
    const name =
      meta.player_name && meta.set_name
        ? `${meta.player_name} — ${meta.set_name}`
        : meta.player_name ?? meta.set_name
    out.push({
      external_id: extId,
      collection_id: ALLDAY_COLLECTION_ID,
      collection: "nfl_all_day",
      name,
      player_name: meta.player_name,
      set_name: meta.set_name,
      team_name: meta.team_name,
      tier: meta.tier,
      series: meta.series,
      circulation_count: meta.circulation_count,
      play_type: meta.play_type,
      game_date: meta.game_date,
      home_team: meta.home_team,
      away_team: meta.away_team,
      updated_at: now,
      ok: Boolean(meta.player_name),
    })
  }
  return out
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function emptyRow(
  externalId: string,
  collectionId: string,
  collection: string,
  now: string,
): HydratedEditionRow {
  return {
    external_id: externalId,
    collection_id: collectionId,
    collection,
    name: null,
    player_name: null,
    set_name: null,
    team_name: null,
    tier: null,
    series: null,
    circulation_count: null,
    play_type: null,
    game_date: null,
    home_team: null,
    away_team: null,
    updated_at: now,
    ok: false,
  }
}

// Strip the `ok` flag and any undefined onchain-id fields so callers can pass
// the result straight to .upsert without manual key cleanup.
export function toUpsertRow(
  row: HydratedEditionRow,
): Record<string, unknown> {
  const clean: Record<string, unknown> = { ...row }
  delete clean.ok
  if (clean.set_id_onchain === undefined) delete clean.set_id_onchain
  if (clean.play_id_onchain === undefined) delete clean.play_id_onchain
  return clean
}
