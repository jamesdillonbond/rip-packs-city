// lib/challenges/topshot-ingest.ts
//
// Automated ingest of Top Shot Challenge-Builder VARIABLE challenges into the challenge
// tracker. Confirmed shape (from a live browser SearchChallenges capture, 2026-07-13):
// every active challenge is `type: "VARIABLE"` with an empty fixed `slots` list; the
// required moments live in `variableChallenge.variableSlots[]`, each a QUERY
// (byPlayers = NBA stats id, bySets = Top Shot set UUID, bySeries, byPlayCategory) — NOT a
// concrete setID:playID. See docs/audits/challenge-tracker-review-2026-07-13.md and the
// slot model in supabase/migrations/*_challenge_slots_model.sql.
//
// The `searchChallenges` root field is reachable server-side through the topshot-proxy
// worker (probe-confirmed on public-api.nbatopshot.com). This fetches active VARIABLE
// challenges, upserts each challenge + its raw slot queries via upsert_challenge_from_gql,
// then runs resolve_challenge_slots() (slot query -> eligible editions, honoring
// set/player/play-category, and backfilling players.nba_stats_id) + refresh_challenge_costs().
//
// DISABLED by default (CHALLENGE_INGEST_ENABLED !== "true"): the cron no-ops until an
// operator flips the flag, and fetchTopshotChallenges() throws on any shape it doesn't
// recognize rather than writing guessed data. Env is read lazily so tests can set it.

const tsGql = () => process.env.TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"
const tsProxySecret = () => process.env.TS_PROXY_SECRET || ""

export function challengeIngestEnabled(): boolean {
  return process.env.CHALLENGE_INGEST_ENABLED === "true"
}

// One resolved slot as it goes to the DB (raw query, not yet resolved to editions).
export interface ChallengeSlot {
  slotOrder: number
  label: string | null
  nbaStatsId: string | null
  playCategory: string | null
  series: string | null
  helpText: string | null
}

// One mapped challenge ready for upsert_challenge_from_gql.
export interface ChallengeUpsert {
  externalId: string
  name: string
  description: string | null
  endsAt: string | null
  completedCount: number | null
  totalRewardAllocation: number | null
  imageUrl: string | null
  setExternalId: string | null
  slots: ChallengeSlot[]
}

// The exact operation from the live capture. Only the fields the ingest consumes are
// requested. searchInput.pagination.limit caps the page; ACTIVE + VARIABLE filters mirror
// the website's own challenge board. TRADE_IN variable challenges are excluded (they aren't
// set-completion locks).
const CHALLENGE_QUERY = `
  query SearchChallenges($byChallengeExpiryState: ChallengeExpiryStateFilter, $byChallengeTypes: [ChallengeType!], $byExcludedVariableChallengeTypes: [VariableChallengeType!], $searchInput: BaseSearchInput!, $sortBy: ChallengeSortType) {
    searchChallenges(input: {sortBy: $sortBy, filters: {byChallengeExpiryState: $byChallengeExpiryState, byChallengeTypes: $byChallengeTypes, byExcludedVariableChallengeTypes: $byExcludedVariableChallengeTypes}, searchInput: $searchInput}) {
      data {
        searchSummary {
          data {
            ... on UserChallenges {
              data {
                id
                name
                description
                expirationDate
                numUsersCompleted
                type
                variableChallenge {
                  prize
                  assets { image }
                  variableSlots {
                    slotOrder
                    label
                    helpText
                    query { byPlayers bySets bySeries byPlayCategory }
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

const CHALLENGE_VARIABLES = {
  sortBy: "EXPIRATION_DATE_ASC",
  byChallengeExpiryState: "ACTIVE",
  byChallengeTypes: ["VARIABLE"],
  byExcludedVariableChallengeTypes: ["TRADE_IN"],
  searchInput: { pagination: { cursor: "", direction: "RIGHT", limit: 100 } },
}

const first = (a: unknown): string | null => {
  if (Array.isArray(a) && a.length && a[0] != null) return String(a[0])
  return null
}

// Map one VARIABLE UserChallenge node to a ChallengeUpsert. Throws if it has no usable slot
// list (better a logged skip than a half-formed challenge). All slots of a challenge share
// one set UUID; it's hoisted to the challenge for edition resolution.
export function mapChallenge(node: any): ChallengeUpsert {
  const externalId = String(node?.id ?? "").trim()
  const name = String(node?.name ?? "").trim()
  const vslots: any[] = Array.isArray(node?.variableChallenge?.variableSlots)
    ? node.variableChallenge.variableSlots
    : []

  const slots: ChallengeSlot[] = []
  let setExternalId: string | null = null
  for (const s of vslots) {
    const order = Number(s?.slotOrder)
    if (!Number.isFinite(order)) continue
    const setId = first(s?.query?.bySets)
    if (setId && !setExternalId) setExternalId = setId
    slots.push({
      slotOrder: order,
      label: typeof s?.label === "string" ? s.label : null,
      nbaStatsId: first(s?.query?.byPlayers),
      playCategory: first(s?.query?.byPlayCategory),
      series: first(s?.query?.bySeries),
      helpText: typeof s?.helpText === "string" ? s.helpText : null,
    })
  }

  if (!externalId || !name || slots.length === 0 || !setExternalId) {
    throw new Error(`unmappable challenge node (id=${externalId || "?"}, slots=${slots.length})`)
  }

  const completed = Number(node?.numUsersCompleted)
  return {
    externalId,
    name,
    description: typeof node?.description === "string" ? node.description : null,
    endsAt: typeof node?.expirationDate === "string" ? node.expirationDate : null,
    completedCount: Number.isFinite(completed) ? completed : null,
    totalRewardAllocation: null, // not exposed by this endpoint
    imageUrl: typeof node?.variableChallenge?.assets?.image === "string" ? node.variableChallenge.assets.image : null,
    setExternalId,
    slots,
  }
}

async function gql(query: string, variables: any): Promise<any> {
  const res = await fetch(tsGql(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-proxy-secret": tsProxySecret() },
    body: JSON.stringify({ operationName: "SearchChallenges", query, variables }),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`Top Shot GQL HTTP ${res.status}: ${raw.slice(0, 160)}`)
  const json = JSON.parse(raw)
  if (Array.isArray(json.errors) && json.errors.length) {
    throw new Error(json.errors.map((e: any) => e?.message).filter(Boolean).join("; ").slice(0, 200))
  }
  return json.data
}

// Fetch + map active VARIABLE challenges. Throws (rather than returning junk) if the
// response doesn't match the confirmed shape — the cron logs it and writes nothing.
export async function fetchTopshotChallenges(): Promise<ChallengeUpsert[]> {
  if (!tsProxySecret()) throw new Error("TS_PROXY_SECRET not set — cannot reach Top Shot GraphQL")
  const data = await gql(CHALLENGE_QUERY, CHALLENGE_VARIABLES)
  const nodes: any[] = data?.searchChallenges?.data?.searchSummary?.data?.data
  if (!Array.isArray(nodes)) {
    throw new Error(
      "unexpected searchChallenges shape — expected searchChallenges.data.searchSummary.data.data[]"
    )
  }
  const out: ChallengeUpsert[] = []
  for (const node of nodes) {
    try {
      out.push(mapChallenge(node))
    } catch {
      /* skip unmappable node; total is logged by the caller */
    }
  }
  return out
}

// Upsert each fetched challenge + its slots, then resolve slots -> eligible editions and
// refresh cached costs. Accepts either a Supabase admin client or a bare { rpc } for tests.
export async function ingestTopshotChallenges(
  supabaseAdmin: any
): Promise<{ fetched: number; upserted: number; skipped: number; expired: number }> {
  const challenges = await fetchTopshotChallenges()
  let upserted = 0
  let skipped = 0
  for (const c of challenges) {
    const { error } = await supabaseAdmin.rpc("upsert_challenge_from_gql", {
      p_external_id: c.externalId,
      p_name: c.name,
      p_description: c.description ?? null,
      p_ends_at: c.endsAt ?? null,
      p_completed_count: c.completedCount ?? null,
      p_total_alloc: c.totalRewardAllocation ?? null,
      p_image_url: c.imageUrl ?? null,
      p_set_external_id: c.setExternalId ?? null,
      p_slots: c.slots.map((s) => ({
        slot_order: s.slotOrder,
        label: s.label,
        nba_stats_id: s.nbaStatsId,
        play_category: s.playCategory,
        series: s.series,
        help_text: s.helpText,
      })),
    })
    if (error) skipped++
    else upserted++
  }
  if (upserted > 0) {
    // Resolve slot queries -> eligible editions (+ nba_stats_id backfill) and refresh costs.
    await supabaseAdmin.rpc("resolve_challenge_slots", {})
    await supabaseAdmin.rpc("refresh_challenge_costs", {})
  }
  // Expire challenges whose window has closed. Runs EVERY tick, even when nothing upserted:
  // a challenge that drops out of the ACTIVE feed is never re-upserted, so a time-based flip
  // is the only thing that keeps `status` honest. Purely time-based (ends_at < now()), so a
  // transient partial fetch can never wrongly expire a still-future challenge.
  let expired = 0
  const { data: expiredCount } = await supabaseAdmin.rpc("expire_ended_challenges", {})
  if (typeof expiredCount === "number") expired = expiredCount
  return { fetched: challenges.length, upserted, skipped, expired }
}
