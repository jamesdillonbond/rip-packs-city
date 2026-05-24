// compute-topshot-pack-ev v18 — inline UUID:UUID skeleton hydration.
//
// v18 (2026-05-24): the seed_topshot_editions RPC creates skeleton rows with
// set_id_onchain/play_id_onchain populated ONLY for integer-pair external_ids.
// Every external_id this function seeds is `{setUUID}:{playUUID}`, so the
// integer columns stay NULL and the topshot-stub-resolver pipeline (which
// requires set_id_onchain IS NOT NULL on its target query) never touches
// them — backlog was 992 and growing ~10/day, and topshot-moments-hydrator
// failed ~16x/day on the same catalog gap. v18 hydrates the just-seeded
// UUID:UUID rows inline via Top Shot's searchEditions GQL, populating
// set_id_onchain / play_id_onchain / name / player_name / set_name / tier
// / circulation_count in the same invocation. Runs AFTER the EV insert with
// a strict time budget so the critical EV path is never blocked.
//
// Mirrors app/api/pack-ev/route.ts: every persisted row carries primary_price,
// secondary_ask, price_source, primary_available, secondary_available
// alongside the legacy pack_price. EV is anchored against the cheaper of (a)
// primary retail if the pack is still selling or (b) the secondary low ask on
// the P2P market. computeDualPrice() is a verbatim port of the route's
// function so future devs can grep both paths and confirm a single source of
// truth for the math.
//
// Secondary asks are fetched in one upfront call to Dapper Studio's
// searchPackNftAggregation (same query the /api/pack-listings route
// uses, also hit directly by seed-topshot-pack-distributions — Dapper
// Studio is reachable from Supabase egress without a proxy hop). The
// result is a Map<distId, lowestAsk> consulted per pack in the loop.
//
// v15 history:
//   v14 BATCH_SIZE 12 → 8 to fix ~50% time-budget timeouts.
//   v13 added zero_total_weight to sentinel-trigger reasons.
//   v12 explicit snapshotted_at on success path.
//   v11 pool_empty sentinel write breaks queue-poisoning on sold-out packs.
//
// Outer pack loop still chunks at FETCH_CONCURRENCY=3 to stay under the
// topshot-proxy Cloudflare Workers per-IP rate limit. gqlCall retries
// HTTP 429 / Cloudflare code 1015 up to MAX_1015_RETRIES.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var required")

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const TOPSHOT_GRAPHQL_DIRECT = "https://public-api.nbatopshot.com/graphql"
const TS_PROXY_URL = Deno.env.get("TS_PROXY_URL") ?? ""
const TS_PROXY_SECRET = Deno.env.get("TS_PROXY_SECRET") ?? ""
const GQL_ENDPOINT = TS_PROXY_URL || TOPSHOT_GRAPHQL_DIRECT
const USING_PROXY = Boolean(TS_PROXY_URL && TS_PROXY_SECRET)
if (!USING_PROXY) {
  console.log(`[compute-topshot-pack-ev] WARN: proxy env not set (TS_PROXY_URL=${TS_PROXY_URL ? "set" : "missing"}, TS_PROXY_SECRET=${TS_PROXY_SECRET ? "set" : "missing"}). Falling back to direct GQL — Cloudflare may reject ~50% of requests.`)
}

// Dapper Studio is the only host that serves searchPackNftAggregation
// (per-pack listing aggregation with min ask). Reachable from Supabase
// egress directly — seed-topshot-pack-distributions hits the same host
// without a proxy. No CF WAF block.
const STUDIO_GRAPHQL = "https://api.production.studio-platform.dapperlabs.com/graphql"

const BATCH_SIZE = 8
const MAX_EDITION_PAGES = 8
const MAX_LISTING_PAGES = 4
const TIME_BUDGET_MS = 110_000
const HARD_CEILING_MS = 130_000
const ERRORS_SAMPLE_CAP = 12
const FETCH_CONCURRENCY = 3
const MAX_1015_RETRIES = 3
const RETRY_BACKOFF_MS = 2000
const FUNCTION_VERSION = 18

// Hydration safety margin: leave this many ms of HARD_CEILING headroom for
// the GQL+update loop so it can short-circuit cleanly without dragging the
// outer Deno.serve handler past its budget. Tuned for ~5s/call worst case.
const HYDRATE_BUDGET_RESERVE_MS = 8_000
const HYDRATE_PER_CALL_TIMEOUT_MS = 8_000

// UUID character class (no anchors so it can be used inline in colon-split keys).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const retryEvents: Array<{
  op: string
  attempt: number
  status: number
  body: string
  marker: "retried_after_1015"
}> = []

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
)

const GQL_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "User-Agent": "RipPacksCity/1.0 (www.rippackscity.com)",
  "Origin": "https://nbatopshot.com",
  "Referer": "https://nbatopshot.com/",
}
if (USING_PROXY) GQL_HEADERS["X-Proxy-Secret"] = TS_PROXY_SECRET

const STUDIO_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "User-Agent": "RipPacksCity/1.0 (www.rippackscity.com)",
  "Origin": "https://nbatopshot.com",
  "Referer": "https://nbatopshot.com/",
}

const DYNAMIC_QUERY = `
  query GetPackListing_DynamicData($input: GetPackListingInput!) {
    getPackListing(input: $input) {
      data {
        id
        forSale
        isSoldOut
        remaining
        dropType
        packListingContentRemaining {
          unopened
          totalPackCount
          remainingByTier {
            common rare legendary ultimate fandom autograph anthology
          }
          originalCountsByTier {
            common rare legendary ultimate fandom autograph anthology
          }
        }
      }
    }
  }
`
const DYNAMIC_OP = "GetPackListing_DynamicData"

const EDITIONS_QUERY = `
  query GetPackEditions($input: GetPackListingInput!, $after: ID) {
    getPackListing(input: $input) {
      data {
        packEditionsV3(after: $after) {
          pageInfo { endCursor hasNextPage }
          edges {
            node {
              count
              remaining
              edition {
                id
                tier
                set { id }
                play { id }
              }
            }
          }
        }
      }
    }
  }
`
const EDITIONS_OP = "GetPackEditions"

const STUDIO_PACK_LISTINGS_QUERY = `
  query searchPackNftAggregation_searchPacks($after: String, $first: Int, $filters: [PackNftFilter!]) {
    searchPackNftAggregation(searchInput: {after: $after, first: $first, filters: $filters}) {
      pageInfo { endCursor hasNextPage }
      totalCount
      edges {
        node {
          dist_id { key value }
          listing { price { min } }
        }
      }
    }
  }
`

const STUDIO_SEALED_FILTERS = [
  {
    status: { eq: "Sealed" },
    listing: {
      exists: true,
      ft_vault_type: { eq: "A.ead892083b3e2c6c.DapperUtilityCoin.Vault" },
    },
    owner_address: { ne: "0b2a3299cc857e29" },
    excludeReserved: { eq: true },
    type_name: { eq: "A.0b2a3299cc857e29.PackNFT.NFT" },
    distribution: {
      tier: { ignore_case: true, in: [] },
      series_ids: { contains: [], contains_type: "ANY" },
      title: { ignore_case: true, partial_match: true, in: [] },
    },
  },
]

interface DynamicData {
  getPackListing?: {
    data?: {
      forSale?: boolean
      packListingContentRemaining?: {
        unopened?: number
        totalPackCount?: number
      }
    }
  }
}

interface EditionNode {
  count: number
  remaining: number
  edition: {
    id: string
    tier: string
    set: { id: string } | null
    play: { id: string } | null
  }
}

interface EditionsResponse {
  getPackListing?: {
    data?: {
      packEditionsV3?: {
        pageInfo: { endCursor: string; hasNextPage: boolean }
        edges: Array<{ node: EditionNode }>
      }
    }
  }
}

// SearchEditionBackfill — same GQL shape used by scripts/rehydrate-null-topshot-editions.mjs.
// Hydrates UUID:UUID skeleton edition rows that seed_topshot_editions could
// not populate (it only parses set_id_onchain / play_id_onchain when external_id
// is an integer-pair). Returned through the topshot-proxy worker just like the
// pack-ev queries above so it shares headers, retries, and rate-limit handling.
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
                set { flowId flowName flowSeriesNumber }
                play {
                  flowID
                  stats {
                    playerName
                    teamAtMoment
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
const SEARCH_EDITION_OP = "SearchEditionBackfill"

interface EditionGqlRow {
  tier?: string | null
  circulationCount?: number | string | null
  set?: {
    flowId?: number | string | null
    flowName?: string | null
    flowSeriesNumber?: number | string | null
  } | null
  play?: {
    flowID?: number | string | null
    stats?: {
      playerName?: string | null
      teamAtMoment?: string | null
      playCategory?: string | null
      playType?: string | null
      dateOfMoment?: string | null
      homeTeamName?: string | null
      awayTeamName?: string | null
    } | null
  } | null
}

interface SearchEditionsResp {
  searchEditions?: {
    searchSummary?: {
      data?: { data?: EditionGqlRow[] }
    }
  }
}

interface TargetRow {
  dist_id: string
  pack_listing_uuid: string
  title: string | null
  tier: string | null
  slots: number | null
  retail_price_usd: string | number | null
}

interface GqlFailure {
  opName: string
  error: string
  status?: number
  body?: string
}

type FetchOutcome =
  | { tag: "success"; target: TargetRow; totalUnopened: number; totalPackCount: number; forSale: boolean; editions: EditionNode[] }
  | { tag: "no_dynamic"; target: TargetRow }
  | { tag: "no_editions"; target: TargetRow }
  | { tag: "zero_unopened"; target: TargetRow }
  | { tag: "gql_error"; target: TargetRow; failure: GqlFailure }

type PriceSource = "primary" | "secondary" | "min" | "none"
interface DualPrice {
  packPrice: number
  primaryPrice: number | null
  secondaryAsk: number | null
  primaryAvailable: boolean
  secondaryAvailable: boolean
  priceSource: PriceSource
}

// Verbatim port of computeDualPrice from app/api/pack-ev/route.ts. Keep
// the name and shape identical so future audits can grep both paths.
function computeDualPrice(args: {
  requestedPrice: number
  totalUnopened: number
  forSale: boolean
  secondaryAsk: number | null
}): DualPrice {
  const primaryAvailable = args.totalUnopened > 0 && args.forSale === true
  const secondaryAvailable = args.secondaryAsk != null && args.secondaryAsk > 0
  const primaryPrice = primaryAvailable && args.requestedPrice > 0 ? args.requestedPrice : null
  const secondaryAskValue = secondaryAvailable ? args.secondaryAsk : null

  let packPrice = 0
  let priceSource: PriceSource = "none"

  if (primaryPrice != null && secondaryAskValue != null) {
    if (primaryPrice <= secondaryAskValue) {
      packPrice = primaryPrice
      priceSource = "primary"
    } else {
      packPrice = secondaryAskValue
      priceSource = "secondary"
    }
    if (primaryPrice > 0 && Math.abs(primaryPrice - secondaryAskValue) / primaryPrice <= 0.01) {
      priceSource = "min"
    }
  } else if (primaryPrice != null) {
    packPrice = primaryPrice
    priceSource = "primary"
  } else if (secondaryAskValue != null) {
    packPrice = secondaryAskValue
    priceSource = "secondary"
  }

  return {
    packPrice,
    primaryPrice,
    secondaryAsk: secondaryAskValue,
    primaryAvailable,
    secondaryAvailable,
    priceSource,
  }
}

async function gqlCall<T>(
  opName: string,
  query: string,
  variables: Record<string, unknown>,
  timeoutMs = 15000,
): Promise<{ ok: true; data: T } | { ok: false; failure: GqlFailure }> {
  for (let attempt = 1; attempt <= MAX_1015_RETRIES; attempt++) {
    let res: Response
    try {
      res = await fetch(GQL_ENDPOINT, {
        method: "POST",
        headers: GQL_HEADERS,
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      return {
        ok: false,
        failure: { opName, error: `fetch: ${err instanceof Error ? err.message : String(err)}` },
      }
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      const bodyTrimmed = body.slice(0, 500)
      const is1015 = res.status === 429 && body.includes("1015")
      if (is1015 && attempt < MAX_1015_RETRIES) {
        if (retryEvents.length < ERRORS_SAMPLE_CAP) {
          retryEvents.push({
            op: opName,
            attempt,
            status: res.status,
            body: bodyTrimmed,
            marker: "retried_after_1015",
          })
        }
        console.log(`[compute-topshot-pack-ev] 1015 retry op=${opName} attempt=${attempt}, sleeping ${RETRY_BACKOFF_MS}ms`)
        await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS))
        continue
      }
      return {
        ok: false,
        failure: { opName, error: `HTTP ${res.status}`, status: res.status, body: bodyTrimmed },
      }
    }
    const text = await res.text()
    let json:
      | { data?: T; errors?: Array<{ message: string }> }
      | null = null
    try { json = JSON.parse(text) } catch { json = null }
    if (!json) {
      return {
        ok: false,
        failure: { opName, error: "not-json", status: res.status, body: text.slice(0, 500) },
      }
    }
    if (json.errors?.length) {
      return {
        ok: false,
        failure: {
          opName,
          error: json.errors[0].message,
          status: res.status,
          body: JSON.stringify(json.errors).slice(0, 500),
        },
      }
    }
    return { ok: true, data: (json.data ?? {}) as T }
  }
  return {
    ok: false,
    failure: { opName, error: `HTTP 429 (1015) after ${MAX_1015_RETRIES} retries`, status: 429, body: "exhausted_1015_retries" },
  }
}

async function fetchAllEditions(packListingId: string): Promise<{
  ok: true; editions: EditionNode[]
} | { ok: false; failure: GqlFailure }> {
  const all: EditionNode[] = []
  let cursor: string | null = null
  let pages = 0
  while (pages < MAX_EDITION_PAGES) {
    pages++
    const r = await gqlCall<EditionsResponse>(EDITIONS_OP, EDITIONS_QUERY, {
      input: { packListingId },
      after: cursor ?? undefined,
    })
    if (!r.ok) return { ok: false, failure: r.failure }
    const conn = r.data?.getPackListing?.data?.packEditionsV3
    const edges = conn?.edges ?? []
    for (const e of edges) if (e?.node) all.push(e.node)
    if (conn?.pageInfo?.hasNextPage !== true) break
    cursor = conn.pageInfo.endCursor ?? null
    if (!cursor) break
  }
  return { ok: true, editions: all }
}

// Pulls every sealed DUC-denominated pack listing from Dapper Studio and
// builds Map<distId, lowestAsk>. lowestAsk is normalized from Flow's
// UFix64 ×1e8 wire format to USD-per-pack. Returns an empty map on
// failure so the per-pack loop falls back to primary-only pricing
// (priceSource: "primary" or "none") rather than crashing.
async function fetchSecondaryAskMap(): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  let cursor: string | null = null
  let pages = 0
  try {
    while (pages < MAX_LISTING_PAGES) {
      pages++
      const res = await fetch(STUDIO_GRAPHQL, {
        method: "POST",
        headers: STUDIO_HEADERS,
        body: JSON.stringify({
          operationName: "searchPackNftAggregation_searchPacks",
          query: STUDIO_PACK_LISTINGS_QUERY,
          variables: { first: 2000, after: cursor, filters: STUDIO_SEALED_FILTERS },
        }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => "")
        console.log(`[compute-topshot-pack-ev] secondary asks HTTP ${res.status}: ${body.slice(0, 200)}`)
        return result
      }
      // deno-lint-ignore no-explicit-any
      const json: any = await res.json().catch(() => null)
      if (!json || json.errors?.length) {
        const msg = json?.errors?.[0]?.message ?? "no json"
        console.log(`[compute-topshot-pack-ev] secondary asks gql err: ${msg}`)
        return result
      }
      const conn = json?.data?.searchPackNftAggregation
      const edges = conn?.edges ?? []
      for (const e of edges) {
        const node = e?.node
        const distId = node?.dist_id?.value
        if (!distId) continue
        const askRaw = parseInt(node?.listing?.price?.min ?? "0", 10)
        const ask = askRaw / 100_000_000
        if (!Number.isFinite(ask) || ask <= 0) continue
        const cur = result.get(distId)
        if (cur === undefined || ask < cur) result.set(distId, ask)
      }
      if (conn?.pageInfo?.hasNextPage !== true) break
      cursor = conn.pageInfo.endCursor ?? null
      if (!cursor) break
    }
  } catch (err) {
    console.log(`[compute-topshot-pack-ev] secondary asks fetch err: ${err instanceof Error ? err.message : String(err)}`)
  }
  return result
}

function normalizeTier(raw: unknown): string | null {
  if (!raw) return null
  const t = String(raw).toUpperCase()
  if (t.includes("ULTIMATE")) return "ULTIMATE"
  if (t.includes("LEGENDARY")) return "LEGENDARY"
  if (t.includes("RARE")) return "RARE"
  if (t.includes("FANDOM")) return "FANDOM"
  if (t.includes("COMMON")) return "COMMON"
  return null
}

// Inline hydration for freshly-seeded UUID:UUID edition skeletons. Without
// this the stubs accumulate (~10/day) and never resolve: topshot-stub-resolver
// only matches integer-pair stubs (its target RPC requires set_id_onchain IS
// NOT NULL) and the manual rehydrate script is the only fallback.
//
// Time-budgeted against HARD_CEILING_MS so the EV path always wins — stops
// cleanly when budget is exhausted and reports the unprocessed count so the
// next run can pick up the slack via its own seed cycle (any external_id not
// hydrated this tick will reappear as `unseeded` again next tick because
// editionByExternalId is rebuilt from get_topshot_editions_by_setplay, which
// matches on external_id only — a NULL-metadata row resolves but the inline
// hydration loop below will still attempt it on subsequent runs via the
// safety filter `.is("set_id_onchain", null)` on the update). Defensive: the
// update is conditional on set_id_onchain still being NULL so we never
// overwrite a row that was hydrated by some other path.
async function hydrateSeededEditions(
  externalIds: string[],
  startedAt: number,
): Promise<{
  hydrated: number
  failed: number
  skipped_shape: number
  skipped_budget: number
  errors: Array<{ external_id: string; reason: string }>
}> {
  const out = {
    hydrated: 0,
    failed: 0,
    skipped_shape: 0,
    skipped_budget: 0,
    errors: [] as Array<{ external_id: string; reason: string }>,
  }

  for (let i = 0; i < externalIds.length; i++) {
    const ext = externalIds[i]
    if (Date.now() - startedAt > HARD_CEILING_MS - HYDRATE_BUDGET_RESERVE_MS) {
      out.skipped_budget = externalIds.length - i
      break
    }
    const parts = ext.split(":")
    if (parts.length !== 2 || !UUID_RE.test(parts[0]) || !UUID_RE.test(parts[1])) {
      out.skipped_shape++
      continue
    }
    const [setUuid, playUuid] = parts

    const r = await gqlCall<SearchEditionsResp>(
      SEARCH_EDITION_OP,
      SEARCH_EDITION_QUERY,
      {
        input: {
          filters: { bySetIDs: [setUuid], byPlayIDs: [playUuid] },
          searchInput: { pagination: { cursor: "", direction: "RIGHT", limit: 1 } },
        },
      },
      HYDRATE_PER_CALL_TIMEOUT_MS,
    )
    if (!r.ok) {
      out.failed++
      if (out.errors.length < ERRORS_SAMPLE_CAP) {
        out.errors.push({ external_id: ext, reason: r.failure.error.slice(0, 200) })
      }
      continue
    }
    const row = r.data?.searchEditions?.searchSummary?.data?.data?.[0]
    if (!row) {
      out.failed++
      if (out.errors.length < ERRORS_SAMPLE_CAP) {
        out.errors.push({ external_id: ext, reason: "no_row" })
      }
      continue
    }
    const stats = row.play?.stats ?? {}
    const playerName = stats.playerName ? String(stats.playerName).trim() : null
    const setName = row.set?.flowName ? String(row.set.flowName).trim() : null
    if (!playerName && !setName) {
      out.failed++
      if (out.errors.length < ERRORS_SAMPLE_CAP) {
        out.errors.push({ external_id: ext, reason: "no_player_or_set_name" })
      }
      continue
    }

    const setFlowId =
      row.set?.flowId != null && Number.isFinite(Number(row.set.flowId))
        ? Number(row.set.flowId)
        : null
    const playFlowId =
      row.play?.flowID != null && Number.isFinite(Number(row.play.flowID))
        ? Number(row.play.flowID)
        : null
    const circulation =
      row.circulationCount != null && Number.isFinite(Number(row.circulationCount))
        ? Number(row.circulationCount)
        : null
    const series =
      row.set?.flowSeriesNumber != null && Number.isFinite(Number(row.set.flowSeriesNumber))
        ? Number(row.set.flowSeriesNumber)
        : null
    const tier = normalizeTier(row.tier)
    const name =
      playerName && setName
        ? `${playerName} — ${setName}`
        : (playerName ?? setName)

    const dateRaw = stats.dateOfMoment ? String(stats.dateOfMoment).slice(0, 10) : null
    const gameDate = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null

    // deno-lint-ignore no-explicit-any
    const patch: Record<string, any> = {}
    if (name) patch.name = name
    if (playerName) patch.player_name = playerName
    if (setName) patch.set_name = setName
    if (stats.teamAtMoment) patch.team_name = String(stats.teamAtMoment).trim()
    if (tier) patch.tier = tier
    if (series != null) patch.series = series
    if (circulation != null) patch.circulation_count = circulation
    if (setFlowId != null) patch.set_id_onchain = setFlowId
    if (playFlowId != null) patch.play_id_onchain = playFlowId
    if (stats.playType ?? stats.playCategory) {
      patch.play_type = stats.playType ?? stats.playCategory
    }
    if (gameDate) patch.game_date = gameDate
    if (stats.homeTeamName) patch.home_team = String(stats.homeTeamName).trim()
    if (stats.awayTeamName) patch.away_team = String(stats.awayTeamName).trim()

    if (Object.keys(patch).length === 0) {
      out.failed++
      if (out.errors.length < ERRORS_SAMPLE_CAP) {
        out.errors.push({ external_id: ext, reason: "empty_patch" })
      }
      continue
    }

    const { error: upErr } = await supabase
      .from("editions")
      .update(patch)
      .eq("collection_id", TOPSHOT_COLLECTION_ID)
      .eq("external_id", ext)
      .is("set_id_onchain", null)
    if (upErr) {
      out.failed++
      if (out.errors.length < ERRORS_SAMPLE_CAP) {
        out.errors.push({
          external_id: ext,
          reason: `update_err: ${upErr.message.slice(0, 200)}`,
        })
      }
      continue
    }
    out.hydrated++
  }

  return out
}

async function fetchOnePack(target: TargetRow): Promise<FetchOutcome> {
  const dyn = await gqlCall<DynamicData>(DYNAMIC_OP, DYNAMIC_QUERY, {
    input: { packListingId: target.pack_listing_uuid },
  })
  if (!dyn.ok) return { tag: "gql_error", target, failure: dyn.failure }

  const data = dyn.data?.getPackListing?.data
  const cr = data?.packListingContentRemaining
  if (!cr) return { tag: "no_dynamic", target }
  const totalUnopened = cr.unopened ?? 0
  const totalPackCount = cr.totalPackCount ?? 0
  const forSale = data?.forSale === true
  if (totalUnopened === 0) return { tag: "zero_unopened", target }

  const eds = await fetchAllEditions(target.pack_listing_uuid)
  if (!eds.ok) return { tag: "gql_error", target, failure: eds.failure }
  if (eds.editions.length === 0) return { tag: "no_editions", target }

  return { tag: "success", target, totalUnopened, totalPackCount, forSale, editions: eds.editions }
}

async function logPipelineRun(args: {
  startedAt: string; rowsFound: number; rowsWritten: number; rowsSkipped: number
  ok: boolean; error?: string | null; extra: Record<string, unknown>
}) {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabase as any).rpc("log_pipeline_run", {
      p_pipeline: "compute-topshot-pack-ev",
      p_started_at: args.startedAt,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error ?? null,
      p_collection_slug: "nba-top-shot",
      p_cursor_before: null, p_cursor_after: null,
      p_extra: args.extra,
    })
  } catch { /* ignore */ }
}

async function runBackgroundWork(startedAtIso: string, started: number) {
  retryEvents.length = 0
  const counters = {
    nodes_processed: 0,
    nodes_no_editions: 0,
    nodes_no_dynamic: 0,
    nodes_zero_unopened: 0,
    pool_rows_written: 0,
    fmv_resolved: 0,
    editions_resolved: 0,
    editions_seeded: 0,
    editions_seed_updated: 0,
    editions_resolved_after_seed: 0,
    editions_hydrated: 0,
    editions_hydration_failed: 0,
    editions_hydration_skipped_shape: 0,
    editions_hydration_skipped_budget: 0,
    ev_rows_written: 0,
    pool_empty_sentinels: 0,
    rpc_not_ok: 0,
    rpc_errors: 0,
    gql_errors: 0,
    secondary_asks_count: 0,
    secondary_asks_matched: 0,
  }

  const errorsSample: Array<{
    op: string
    flow_id: string
    dist_id: string
    error: string
    status?: number
    body?: string
  }> = []
  const rpcNotOkSample: Array<{
    dist_id: string
    pack_price: number
    slots: number
    payload: unknown
  }> = []

  try {
    const { data: targets, error: targetsErr } = await supabase
      .from("topshot_pack_ev_targets")
      .select("dist_id, pack_listing_uuid, title, tier, slots, retail_price_usd")
      .order("last_ev_at", { ascending: true, nullsFirst: true })
      .limit(BATCH_SIZE)
    if (targetsErr) {
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: false, error: `targets: ${targetsErr.message}`,
        extra: { counters, elapsed_ms: Date.now() - started, function_version: FUNCTION_VERSION, using_proxy: USING_PROXY },
      })
      return
    }

    const targetRows = (targets ?? []) as TargetRow[]
    if (targetRows.length === 0) {
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: true,
        extra: { counters, elapsed_ms: Date.now() - started, function_version: FUNCTION_VERSION, using_proxy: USING_PROXY, message: "no targets" },
      })
      return
    }

    await logPipelineRun({
      startedAt: startedAtIso, rowsFound: targetRows.length, rowsWritten: 0, rowsSkipped: 0,
      ok: true,
      extra: {
        message: "heartbeat:started",
        target_count: targetRows.length,
        elapsed_ms: Date.now() - started,
        function_version: FUNCTION_VERSION,
        using_proxy: USING_PROXY,
        batch_size: BATCH_SIZE,
      },
    })

    // Build secondary ask map up front (one Dapper Studio paginated call,
    // cached for the lifetime of this invocation). Failure here is
    // non-fatal — the per-pack loop just sees secondaryAsk=null and
    // falls back to primary-only pricing.
    const secondaryAskMap = await fetchSecondaryAskMap()
    counters.secondary_asks_count = secondaryAskMap.size

    const fetchStart = Date.now()
    const fetchResults: PromiseSettledResult<FetchOutcome>[] = []
    for (let i = 0; i < targetRows.length; i += FETCH_CONCURRENCY) {
      const chunk = targetRows.slice(i, i + FETCH_CONCURRENCY)
      const chunkResults = await Promise.allSettled(chunk.map(t => fetchOnePack(t)))
      fetchResults.push(...chunkResults)
    }
    const fetchPhaseMs = Date.now() - fetchStart

    const fetched: Array<Extract<FetchOutcome, { tag: "success" }>> = []
    const seenExternalIds = new Set<string>()

    for (const r of fetchResults) {
      counters.nodes_processed++
      if (r.status === "rejected") {
        counters.gql_errors++
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason)
        if (errorsSample.length < ERRORS_SAMPLE_CAP) {
          errorsSample.push({
            op: "settled-rejected",
            flow_id: "",
            dist_id: "",
            error: reason.slice(0, 500),
          })
        }
        console.log(`[compute-topshot-pack-ev] settled-rejected: ${reason}`)
        continue
      }
      const o = r.value
      switch (o.tag) {
        case "success":
          fetched.push(o)
          for (const node of o.editions) {
            const setId = node.edition.set?.id
            const playId = node.edition.play?.id
            if (setId && playId) seenExternalIds.add(`${setId}:${playId}`)
          }
          break
        case "no_dynamic":
          counters.nodes_no_dynamic++
          break
        case "no_editions":
          counters.nodes_no_editions++
          console.log(`[compute-topshot-pack-ev] bundle dist=${o.target.dist_id} listing=${o.target.pack_listing_uuid}`)
          break
        case "zero_unopened":
          counters.nodes_zero_unopened++
          break
        case "gql_error":
          counters.gql_errors++
          if (errorsSample.length < ERRORS_SAMPLE_CAP) {
            errorsSample.push({
              op: o.failure.opName,
              flow_id: o.target.pack_listing_uuid,
              dist_id: o.target.dist_id,
              error: o.failure.error.slice(0, 500),
              status: o.failure.status,
              body: o.failure.body,
            })
          }
          console.log(`[compute-topshot-pack-ev] gql err op=${o.failure.opName} dist=${o.target.dist_id}: ${o.failure.error}`)
          break
      }
    }

    if (fetched.length === 0) {
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: targetRows.length, rowsWritten: 0,
        rowsSkipped: targetRows.length, ok: true,
        extra: {
          counters,
          errors_sample: [...errorsSample, ...retryEvents],
          rpc_not_ok_sample: rpcNotOkSample,
          elapsed_ms: Date.now() - started,
          function_version: FUNCTION_VERSION,
          using_proxy: USING_PROXY,
          fetch_phase_ms: fetchPhaseMs,
        },
      })
      return
    }

    if (Date.now() - started > TIME_BUDGET_MS) {
      console.log(`[compute-topshot-pack-ev] time budget exceeded after fetch phase`)
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: targetRows.length, rowsWritten: 0,
        rowsSkipped: targetRows.length, ok: false, error: "time_budget_exceeded_after_fetch",
        extra: {
          counters,
          errors_sample: [...errorsSample, ...retryEvents],
          rpc_not_ok_sample: rpcNotOkSample,
          elapsed_ms: Date.now() - started,
          function_version: FUNCTION_VERSION,
          using_proxy: USING_PROXY,
          fetch_phase_ms: fetchPhaseMs,
        },
      })
      return
    }

    const dbStart = Date.now()
    const externalIdList = Array.from(seenExternalIds)
    const editionByExternalId = new Map<string, { id: string; tier: string | null }>()
    if (externalIdList.length > 0) {
      const { data: edRows, error: edErr } = await supabase.rpc(
        "get_topshot_editions_by_setplay",
        { p_keys: externalIdList },
      )
      if (edErr) throw new Error(`get_topshot_editions_by_setplay: ${edErr.message}`)
      // deno-lint-ignore no-explicit-any
      for (const r of (edRows ?? []) as any[]) {
        editionByExternalId.set(String(r.external_id), { id: r.edition_id, tier: r.tier })
      }
    }
    counters.editions_resolved = editionByExternalId.size

    const unseededExternalIds: string[] = []
    for (const ext of externalIdList) {
      if (!editionByExternalId.has(ext)) unseededExternalIds.push(ext)
    }
    if (unseededExternalIds.length > 0) {
      const { data: seedResult, error: seedErr } = await supabase.rpc(
        "seed_topshot_editions",
        { p_external_ids: unseededExternalIds },
      )
      if (seedErr) {
        console.log(`[compute-topshot-pack-ev] seed err: ${seedErr.message}`)
      } else if (seedResult) {
        // deno-lint-ignore no-explicit-any
        const sr = seedResult as any
        counters.editions_seeded = Number(sr.inserted ?? 0)
        counters.editions_seed_updated = Number(sr.updated ?? 0)
      }

      const { data: postSeedRows, error: postSeedErr } = await supabase.rpc(
        "get_topshot_editions_by_setplay",
        { p_keys: unseededExternalIds },
      )
      if (postSeedErr) {
        console.log(`[compute-topshot-pack-ev] re-resolve err: ${postSeedErr.message}`)
      } else {
        // deno-lint-ignore no-explicit-any
        for (const r of (postSeedRows ?? []) as any[]) {
          if (!editionByExternalId.has(String(r.external_id))) {
            editionByExternalId.set(String(r.external_id), { id: r.edition_id, tier: r.tier })
            counters.editions_resolved_after_seed++
          }
        }
      }
    }

    const editionUuids = Array.from(editionByExternalId.values()).map(v => v.id)
    const fmvByEditionId = new Map<string, number>()
    if (editionUuids.length > 0) {
      const { data: fmvRows, error: fmvErr } = await supabase.rpc("get_fmv_for_editions", {
        p_collection_id: TOPSHOT_COLLECTION_ID,
        p_edition_ids: editionUuids,
      })
      if (fmvErr) throw new Error(`get_fmv_for_editions: ${fmvErr.message}`)
      // deno-lint-ignore no-explicit-any
      for (const r of (fmvRows ?? []) as any[]) {
        if (r.fmv_usd != null) fmvByEditionId.set(String(r.edition_id), Number(r.fmv_usd))
      }
    }
    counters.fmv_resolved = fmvByEditionId.size

    const nowIso = new Date().toISOString()
    for (const f of fetched) {
      const distId = f.target.dist_id
      const poolRows: Array<Record<string, unknown>> = []
      for (const node of f.editions) {
        const setId = node.edition.set?.id
        const playId = node.edition.play?.id
        if (!setId || !playId) continue
        const ext = `${setId}:${playId}`
        const ed = editionByExternalId.get(ext)
        if (!ed) continue
        const weight = f.totalUnopened > 0 ? node.remaining / f.totalUnopened : 0
        poolRows.push({
          collection_id: TOPSHOT_COLLECTION_ID,
          dist_id: distId,
          edition_id: ed.id,
          edition_flow_id: ext,
          drop_weight: weight,
          slot_name: "default",
          pool_source: "gql",
          last_refreshed_at: nowIso,
        })
      }

      await supabase.from("pack_drop_pool")
        .delete()
        .eq("collection_id", TOPSHOT_COLLECTION_ID)
        .eq("dist_id", distId)

      if (poolRows.length === 0) continue
      for (let i = 0; i < poolRows.length; i += 500) {
        const chunk = poolRows.slice(i, i + 500)
        const { error: ie } = await supabase.from("pack_drop_pool").insert(chunk)
        if (!ie) counters.pool_rows_written += chunk.length
        else console.log(`[compute-topshot-pack-ev] pool insert err dist=${distId}: ${ie.message}`)
      }
    }

    const evRows: Array<Record<string, unknown>> = []
    let dbLoopEarlyExit = false
    const clamp = (v: number) => Math.max(-10000, Math.min(1000000, v))
    for (const f of fetched) {
      // Graceful early-exit: if the per-pack RPC loop is about to blow the
      // hard ceiling, stop iterating and let the existing evRows insert
      // below flush whatever we've already computed. The next cron tick
      // picks up the unprocessed packs (targets view orders by
      // last_ev_at NULLS FIRST).
      if (Date.now() - started > HARD_CEILING_MS) {
        dbLoopEarlyExit = true
        break
      }
      const distId = f.target.dist_id
      const slots = Math.max(1, f.target.slots ?? 1)
      const retailPrice = f.target.retail_price_usd != null ? Number(f.target.retail_price_usd) : 0
      const secondaryAsk = secondaryAskMap.get(distId) ?? null
      if (secondaryAsk != null) counters.secondary_asks_matched++

      const dual = computeDualPrice({
        requestedPrice: retailPrice,
        totalUnopened: f.totalUnopened,
        forSale: f.forSale,
        secondaryAsk,
      })

      // Pass the dual-resolved price to the RPC so gross_ev is computed
      // against the same anchor we'll persist. The RPC also returns
      // pack_ev and is_positive_ev — we override both in JS below to
      // match the route's behavior exactly (price_source 'none' must
      // suppress isPositive, and pack_ev = gross_ev - dual.packPrice
      // regardless of what the RPC returns).
      const { data: rpcResult, error: rpcErr } = await supabase.rpc(
        "compute_pack_ev_per_edition_weighted",
        {
          p_collection_id: TOPSHOT_COLLECTION_ID,
          p_dist_id: distId,
          p_pack_price: dual.packPrice,
          p_slots: slots,
        },
      )
      if (rpcErr) {
        counters.rpc_errors++
        console.log(`[compute-topshot-pack-ev] rpc err dist=${distId}: ${rpcErr.message}`)
        continue
      }
      // deno-lint-ignore no-explicit-any
      const ev = rpcResult as any
      if (!ev || ev.ok !== true) {
        counters.rpc_not_ok++
        if (rpcNotOkSample.length < ERRORS_SAMPLE_CAP) {
          rpcNotOkSample.push({
            dist_id: distId,
            pack_price: dual.packPrice,
            slots,
            payload: ev,
          })
        }
        // pool_empty / zero_total_weight: drop pool is missing or every
        // edition has weight=0. Write a sentinel row so pack_ev_latest
        // is no longer NULL for this dist_id and the targets view stops
        // re-selecting it on every cron tick. Sentinels still carry the
        // dual-price columns so the UI shows the live primary/secondary
        // state even when EV is unavailable.
        if (ev?.reason === "pool_empty" || ev?.reason === "zero_total_weight") {
          counters.pool_empty_sentinels++
          evRows.push({
            pack_listing_id: f.target.pack_listing_uuid,
            collection_id: TOPSHOT_COLLECTION_ID,
            dist_id: distId,
            pack_name: f.target.title,
            pack_price: dual.packPrice,
            primary_price: dual.primaryPrice,
            secondary_ask: dual.secondaryAsk,
            price_source: dual.priceSource,
            primary_available: dual.primaryAvailable,
            secondary_available: dual.secondaryAvailable,
            gross_ev: 0,
            pack_ev: 0,
            is_positive_ev: false,
            value_ratio: null,
            fmv_coverage_pct: null,
            edition_count: 0,
            total_unopened: 0,
            depletion_pct: 100,
            snapshotted_at: nowIso,
          })
        }
        continue
      }

      const grossEv = Number(ev.gross_ev)
      const packEv = Math.round((grossEv - dual.packPrice) * 100) / 100
      const isPositiveEv = dual.priceSource !== "none" && packEv > 0
      const valueRatio = dual.packPrice > 0
        ? Math.round((grossEv / dual.packPrice) * 1000) / 1000
        : null

      const depletionPct = f.totalPackCount > 0
        ? Math.min(100, Math.max(0, Math.round(((f.totalPackCount - f.totalUnopened) / f.totalPackCount) * 100)))
        : null

      evRows.push({
        pack_listing_id: f.target.pack_listing_uuid,
        collection_id: TOPSHOT_COLLECTION_ID,
        dist_id: distId,
        pack_name: f.target.title,
        pack_price: dual.packPrice,
        primary_price: dual.primaryPrice,
        secondary_ask: dual.secondaryAsk,
        price_source: dual.priceSource,
        primary_available: dual.primaryAvailable,
        secondary_available: dual.secondaryAvailable,
        gross_ev: clamp(grossEv),
        pack_ev: clamp(packEv),
        is_positive_ev: isPositiveEv,
        value_ratio: valueRatio,
        fmv_coverage_pct: Number(ev.fmv_coverage_pct),
        edition_count: Math.min(Number(ev.edition_count), 32767),
        total_unopened: f.totalUnopened,
        depletion_pct: depletionPct,
        snapshotted_at: nowIso,
      })
    }

    if (evRows.length > 0) {
      const { error: evErr } = await supabase.from("pack_ev_history").insert(evRows)
      if (!evErr) counters.ev_rows_written = evRows.length
      else {
        await logPipelineRun({
          startedAt: startedAtIso, rowsFound: targetRows.length, rowsWritten: 0,
          rowsSkipped: targetRows.length, ok: false,
          error: `insert pack_ev_history: ${evErr.message}`,
          extra: {
            counters,
            errors_sample: [...errorsSample, ...retryEvents],
            rpc_not_ok_sample: rpcNotOkSample,
            elapsed_ms: Date.now() - started,
            function_version: FUNCTION_VERSION,
            using_proxy: USING_PROXY,
            fetch_phase_ms: fetchPhaseMs,
          },
        })
        return
      }
    }

    // ── Inline UUID:UUID skeleton hydration ─────────────────────────────────
    // Runs LAST so the EV write path is never blocked. Hydrates the rows that
    // seed_topshot_editions just inserted with NULL metadata (because its
    // integer-pair regex doesn't match UUID:UUID external_ids). One Top Shot
    // GQL call per row; time-budgeted, short-circuits cleanly if HARD_CEILING
    // is approached. See docs/code-todos.md item #1.
    const hydrationErrors: Array<{ external_id: string; reason: string }> = []
    if (unseededExternalIds.length > 0) {
      const hydrateResult = await hydrateSeededEditions(unseededExternalIds, started)
      counters.editions_hydrated = hydrateResult.hydrated
      counters.editions_hydration_failed = hydrateResult.failed
      counters.editions_hydration_skipped_shape = hydrateResult.skipped_shape
      counters.editions_hydration_skipped_budget = hydrateResult.skipped_budget
      hydrationErrors.push(...hydrateResult.errors)
      console.log(
        `[compute-topshot-pack-ev] hydration done — hydrated=${hydrateResult.hydrated} failed=${hydrateResult.failed} skipped_shape=${hydrateResult.skipped_shape} skipped_budget=${hydrateResult.skipped_budget}`,
      )
    }

    const dbPhaseMs = Date.now() - dbStart
    const elapsed = Date.now() - started
    await logPipelineRun({
      startedAt: startedAtIso,
      rowsFound: targetRows.length,
      rowsWritten: counters.ev_rows_written,
      rowsSkipped: counters.nodes_no_editions
        + counters.nodes_no_dynamic
        + counters.nodes_zero_unopened
        + counters.gql_errors
        + counters.rpc_not_ok
        + counters.rpc_errors,
      ok: true,
      extra: {
        ...counters,
        editions_requested: seenExternalIds.size,
        errors_sample: [...errorsSample, ...retryEvents],
        rpc_not_ok_sample: rpcNotOkSample,
        hydration_errors_sample: hydrationErrors.slice(0, ERRORS_SAMPLE_CAP),
        elapsed_ms: elapsed,
        fetch_phase_ms: fetchPhaseMs,
        db_phase_ms: dbPhaseMs,
        function_version: FUNCTION_VERSION,
        using_proxy: USING_PROXY,
        batch_size: BATCH_SIZE,
        db_loop_early_exit: dbLoopEarlyExit,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[compute-topshot-pack-ev] bg fatal: ${msg}`)
    await logPipelineRun({
      startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false, error: msg,
      extra: {
        counters,
        errors_sample: [...errorsSample, ...retryEvents],
        rpc_not_ok_sample: rpcNotOkSample,
        elapsed_ms: Date.now() - started,
        function_version: FUNCTION_VERSION,
        using_proxy: USING_PROXY,
      },
    })
  }
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("Authorization") ?? ""
  if (auth !== `Bearer ${INGEST_SECRET_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 })
  }

  const started = Date.now()
  const startedAtIso = new Date(started).toISOString()

  // deno-lint-ignore no-explicit-any
  const edgeRuntime = (globalThis as any).EdgeRuntime
  const workPromise = runBackgroundWork(startedAtIso, started)
  if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(workPromise)
  } else {
    workPromise.catch((e) =>
      console.log(`waitUntil fallback err: ${e instanceof Error ? e.message : String(e)}`)
    )
  }

  return new Response(
    JSON.stringify({
      ok: true,
      message: "queued",
      started_at: startedAtIso,
      using_proxy: USING_PROXY,
      note: "Real results will appear in pipeline_runs within ~30-60s.",
    }),
    { headers: { "Content-Type": "application/json" } },
  )
})
