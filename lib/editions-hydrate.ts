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
  // When set, this row was canonical-resolved against an existing UUID-format
  // TopShot edition. Caller should NOT upsert it; instead, map external_id →
  // redirect.canonical_id directly. Prevention layer for the editions dedup
  // project — without it, every TopShot sale on a known play was creating a
  // fresh int-format orphan row.
  redirect?: { canonical_id: string; canonical_external_id: string }
}

export interface HydrateOptions {
  // Pass a Supabase client to enable canonical-sibling resolution for TopShot
  // int-pair external_ids. Without it, the hydrator behaves as before.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase?: any
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
  // On-chain integer IDs surfaced by the GQL response so UUID-format inserts
  // (where the external_id has no int-pair to parse) still land both columns.
  // Quirk: TopShot GQL exposes set.flowId (lowercase d) and play.flowID
  // (uppercase D). Both come back as strings; we coerce to int.
  setIdOnchain: number | null
  playIdOnchain: number | null
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
  const setFlowIdRaw = row.set?.flowId ?? null
  const playFlowIDRaw = row.play?.flowID ?? null
  const setIdOnchain =
    setFlowIdRaw != null && Number.isFinite(Number(setFlowIdRaw))
      ? parseInt(String(setFlowIdRaw), 10)
      : null
  const playIdOnchain =
    playFlowIDRaw != null && Number.isFinite(Number(playFlowIDRaw))
      ? parseInt(String(playFlowIDRaw), 10)
      : null
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
    setIdOnchain,
    playIdOnchain,
  }
}

function splitTsExternalId(extId: string): { setID: string; playID: string } | null {
  const parts = extId.split(":")
  if (parts.length !== 2) return null
  const [setID, playID] = parts
  if (!setID || !playID) return null
  return { setID, playID }
}

// ── Top Shot int-pair resolver (Cadence) ─────────────────────────────────────
// The GQL `searchEditions` schema only accepts UUID set/play IDs. For
// integer-pair external_ids ("104:3659" etc) we have to resolve via the on-chain
// TopShot contract. Cadence can return play metadata, set name, set series,
// and circulation; tier and thumbnail aren't on-chain (those stay null and the
// upstream caller — usually the canonical-sibling redirect or a separate
// hydrator — fills them in later).
//
// Flow REST raw integration intentionally — keeps lib/editions-hydrate free of
// FCL config side-effects when imported into shared module paths.

const FLOW_REST_SCRIPTS = "https://rest-mainnet.onflow.org/v1/scripts?block_height=final"

const CADENCE_TS_INT_RESOLVE = `
import TopShot from 0x0b2a3299cc857e29

access(all) fun main(setID: UInt32, playID: UInt32): {String: String} {
    let result: {String: String} = TopShot.getPlayMetaData(playID: playID) ?? {}

    if let setName = TopShot.getSetName(setID: setID) {
        result["__SetName"] = setName
    }
    if let series = TopShot.getSetSeries(setID: setID) {
        result["__SetSeries"] = series.toString()
    }
    if let circulation = TopShot.getNumMomentsInEdition(setID: setID, playID: playID) {
        result["__Circulation"] = circulation.toString()
    }

    return result
}
`.trim()

function flattenTsCadenceDict(parsed: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v = (parsed as any)?.value
  if (!Array.isArray(v)) return out
  for (const entry of v) {
    const k = entry?.key?.value
    const val = entry?.value?.value
    if (typeof k === "string" && typeof val === "string") out[k] = val
  }
  return out
}

function pickTsPlayerName(meta: Record<string, string>): string | null {
  const full = meta.FullName
  if (full && full !== "<invalid Value>" && full.trim() !== "") return full.trim()
  const first = (meta.FirstName ?? "").trim()
  const last = (meta.LastName ?? "").trim()
  const composed = [first, last].filter(Boolean).join(" ")
  return composed || null
}

async function fetchTsEditionMetaCadence(
  setIdOnchain: number,
  playIdOnchain: number,
): Promise<TsEditionMeta | null> {
  const body = {
    script: Buffer.from(CADENCE_TS_INT_RESOLVE, "utf8").toString("base64"),
    arguments: [
      Buffer.from(JSON.stringify({ type: "UInt32", value: String(setIdOnchain) }), "utf8").toString("base64"),
      Buffer.from(JSON.stringify({ type: "UInt32", value: String(playIdOnchain) }), "utf8").toString("base64"),
    ],
  }

  let res: Response
  try {
    res = await fetch(FLOW_REST_SCRIPTS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    console.log(
      `[editions-hydrate] cadence fetch failed set=${setIdOnchain} play=${playIdOnchain}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "")
    console.log(
      `[editions-hydrate] cadence HTTP ${res.status} set=${setIdOnchain} play=${playIdOnchain}: ${txt.slice(0, 160)}`,
    )
    return null
  }

  let raw: string
  try {
    raw = await res.text()
  } catch {
    return null
  }

  let parsed: unknown
  try {
    const decoded = Buffer.from(raw.replace(/^"|"$/g, "").trim(), "base64").toString("utf8")
    parsed = JSON.parse(decoded)
  } catch (err) {
    console.log(
      `[editions-hydrate] cadence decode failed set=${setIdOnchain} play=${playIdOnchain}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }

  const meta = flattenTsCadenceDict(parsed)
  if (Object.keys(meta).length === 0) {
    console.log(
      `[editions-hydrate] cadence empty result set=${setIdOnchain} play=${playIdOnchain}`,
    )
    return null
  }

  const seriesRaw = meta.__SetSeries ?? null
  const seriesNum = seriesRaw != null && Number.isFinite(Number(seriesRaw)) ? Number(seriesRaw) : null
  const circRaw = meta.__Circulation ?? null
  const circulation = circRaw != null && Number.isFinite(Number(circRaw)) ? Number(circRaw) : null
  const dateOfMoment = meta.DateOfMoment ?? null
  const dateSlice = dateOfMoment ? String(dateOfMoment).slice(0, 10) : null
  const gameDate = dateSlice && /^\d{4}-\d{2}-\d{2}$/.test(dateSlice) ? dateSlice : null

  return {
    playerName: pickTsPlayerName(meta),
    setName: meta.__SetName?.trim() || null,
    series: seriesNum,
    // Tier is GQL-only; on-chain doesn't carry it. Caller treats null as
    // "preserve existing" — the upsert RPC uses COALESCE(tier, p_tier).
    tier: null,
    circulation,
    teamName: meta.TeamAtMoment?.trim() || null,
    playCategory: meta.PlayCategory?.trim() || null,
    playType: meta.PlayType?.trim() || null,
    gameDate,
    homeTeam: meta.HomeTeamName?.trim() || null,
    awayTeam: meta.AwayTeamName?.trim() || null,
    setIdOnchain,
    playIdOnchain,
  }
}

interface TsCanonicalSibling {
  id: string
  external_id: string
  name: string | null
  player_name: string | null
  set_name: string | null
  team_name: string | null
  tier: string | null
  series: number | null
  circulation_count: number | null
  set_id_onchain: number | null
  play_id_onchain: number | null
  play_type: string | null
  game_date: string | null
  home_team: string | null
  away_team: string | null
}

// Look up an existing UUID-format TopShot edition row that matches the same
// (set_id_onchain, play_id_onchain) on-chain coordinates. If found, the
// hydrator redirects the int-pair input to it instead of inserting a duplicate.
async function lookupTsCanonicalSibling(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  setIdOnchain: number,
  playIdOnchain: number,
): Promise<TsCanonicalSibling | null> {
  try {
    const { data } = await supabase
      .from("editions")
      .select(
        "id, external_id, name, player_name, set_name, team_name, tier, series, circulation_count, set_id_onchain, play_id_onchain, play_type, game_date, home_team, away_team",
      )
      .eq("collection_id", TS_COLLECTION_ID)
      .eq("set_id_onchain", setIdOnchain)
      .eq("play_id_onchain", playIdOnchain)
      .limit(2)
    if (!data || data.length === 0) return null
    // UUID-format external_ids are setUUID:playUUID — both halves contain '-'
    // and the row contains ':'. Int-pair format ("73:2785") matches '^\d+:\d+$'.
    // Pick the UUID-format row.
    const sibling = (data as TsCanonicalSibling[]).find(
      (r) =>
        typeof r.external_id === "string" &&
        r.external_id.includes(":") &&
        r.external_id.includes("-"),
    )
    return sibling ?? null
  } catch {
    return null
  }
}

export async function hydrateTopShotEditions(
  externalIds: string[],
  options?: HydrateOptions,
): Promise<HydratedEditionRow[]> {
  const now = new Date().toISOString()
  const out: HydratedEditionRow[] = []
  const unique = Array.from(new Set(externalIds.filter(Boolean)))
  const supabase = options?.supabase ?? null

  for (const extId of unique) {
    const split = splitTsExternalId(extId)
    if (!split) {
      out.push(emptyRow(extId, TS_COLLECTION_ID, "nba_top_shot", now))
      continue
    }
    const { setID, playID } = split

    const intPair = /^\d+:\d+$/.test(extId)
    const setIdOnchain = intPair ? Number(setID) : null
    const playIdOnchain = intPair ? Number(playID) : null

    // Canonical-resolve: if a UUID-format sibling exists for this on-chain
    // pair, return a redirect row instead of fetching GQL + creating a new
    // int-format duplicate. Skipped when no supabase client was passed.
    if (
      intPair &&
      supabase &&
      setIdOnchain != null &&
      playIdOnchain != null
    ) {
      const sibling = await lookupTsCanonicalSibling(
        supabase,
        setIdOnchain,
        playIdOnchain,
      )
      if (sibling) {
        out.push({
          external_id: extId,
          collection_id: TS_COLLECTION_ID,
          collection: "nba_top_shot",
          name: sibling.name,
          player_name: sibling.player_name,
          set_name: sibling.set_name,
          team_name: sibling.team_name,
          tier: sibling.tier,
          series: sibling.series,
          circulation_count: sibling.circulation_count,
          set_id_onchain: sibling.set_id_onchain ?? undefined,
          play_id_onchain: sibling.play_id_onchain ?? undefined,
          play_type: sibling.play_type,
          game_date: sibling.game_date,
          home_team: sibling.home_team,
          away_team: sibling.away_team,
          updated_at: now,
          ok: true,
          redirect: {
            canonical_id: sibling.id,
            canonical_external_id: sibling.external_id,
          },
        })
        continue
      }
    }

    // Branch: int-pair external_ids resolve via Cadence (TopShot's GQL
    // `searchEditions` rejects integer set/play IDs with a uuid-syntax error).
    // UUID-pair external_ids stay on the GQL path. Without this branch, the
    // int-pair fallthrough silently returned null whenever no UUID canonical
    // sibling existed for the redirect path above to catch — meaning any
    // int-pair without a sibling produced an empty edition row.
    const meta =
      intPair && setIdOnchain != null && playIdOnchain != null
        ? await fetchTsEditionMetaCadence(setIdOnchain, playIdOnchain)
        : await fetchTsEditionMeta(setID, playID)

    const playerName = meta?.playerName ?? null
    const setName = meta?.setName ?? null
    const name =
      playerName && setName ? `${playerName} — ${setName}` : playerName ?? setName

    // For UUID-format external_ids the int pair isn't in the key, so fall back
    // to the GQL-returned set.flowId / play.flowID. UUID-format inserts that
    // omitted these columns were the bug this branch closes (2026-05-09).
    const resolvedSetIdOnchain = setIdOnchain ?? meta?.setIdOnchain ?? null
    const resolvedPlayIdOnchain = playIdOnchain ?? meta?.playIdOnchain ?? null

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
      set_id_onchain: resolvedSetIdOnchain ?? undefined,
      play_id_onchain: resolvedPlayIdOnchain ?? undefined,
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
  if (process.env.ALLDAY_PROXY_URL && process.env.TS_PROXY_SECRET) {
    h["X-Proxy-Secret"] = process.env.TS_PROXY_SECRET
  }
  return h
}

function alldayUrl(): string {
  return process.env.ALLDAY_PROXY_URL || ALLDAY_GQL_DEFAULT
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

// Strip the `ok` flag, the `redirect` side-channel, and any undefined
// onchain-id fields so callers can pass the result straight to .upsert
// without manual key cleanup.
export function toUpsertRow(
  row: HydratedEditionRow,
): Record<string, unknown> {
  const clean: Record<string, unknown> = { ...row }
  delete clean.ok
  delete clean.redirect
  if (clean.set_id_onchain === undefined) delete clean.set_id_onchain
  if (clean.play_id_onchain === undefined) delete clean.play_id_onchain
  return clean
}
