// lib/challenges/topshot-ingest.ts
//
// Automated ingest of Top Shot challenge DEFINITIONS into the challenge tracker.
// This is the one piece gated on confirming Top Shot's challenge GraphQL shape — run
// scripts/probe-topshot-challenges.mjs from a session with TS_PROXY_SECRET, then fill the
// two marked spots below (CHALLENGE_QUERY + mapChallenge) with the confirmed field names.
//
// Until then the ingest is DISABLED (CHALLENGE_INGEST_ENABLED unset/false): the cron route
// no-ops, and even if forced on, fetchTopshotChallenges() throws on any shape it doesn't
// recognize rather than writing guessed data. The storage + intelligence layer works today
// via operator-seeded challenges (POST /api/admin/challenges/upsert); this just automates
// the seed once the schema is confirmed.
//
// Reaches public-api.nbatopshot.com through the topshot-proxy worker (Cloudflare blocks
// direct Vercel/Supabase egress), exactly like lib/verify-wallet-gql.ts.

const TS_GQL = process.env.TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET || ""

export function challengeIngestEnabled(): boolean {
  return process.env.CHALLENGE_INGEST_ENABLED === "true"
}

// The upsert shape consumed by the upsert_challenge RPC (camelCase → route → snake_case).
export interface ChallengeUpsert {
  slug: string
  name: string
  challengeType: "set_locking" | "crafting" | "collecting"
  description?: string | null
  rewardKind?: "pack" | "moment" | "other" | null
  rewardPackDistId?: string | null
  rewardMomentExternalId?: string | null
  rewardLabel?: string | null
  startsAt?: string | null
  endsAt?: string | null
  totalRewardAllocation?: number | null
  completedCount?: number | null
  status: "active" | "ended" | "upcoming"
  source: "topshot_gql"
  externalId?: string | null
  imageUrl?: string | null
  editions: Array<{ externalId: string; playIdOnchain?: number | null }>
}

// ── CONFIRM VIA PROBE ────────────────────────────────────────────────────────
// Replace with the real query once scripts/probe-topshot-challenges.mjs confirms the
// field/arg names. The required-moment list is the key part — a challenge's builder
// exposes its required editions as setID:playID pairs; map those to `externalId`.
const CHALLENGE_QUERY = `
  query RpcActiveChallenges {
    __CONFIRM_ME__ {
      id
      title
      endTime
      # required moments → externalId 'setID:playID'
      # reward → rewardKind + rewardPackDistId / rewardMomentExternalId
    }
  }
`

// ── CONFIRM VIA PROBE ────────────────────────────────────────────────────────
// Map one raw challenge node from the confirmed response to a ChallengeUpsert.
// Throw if a node is missing the fields we depend on — better a logged skip than a
// half-formed challenge with no required-moment list.
function mapChallenge(node: any): ChallengeUpsert {
  const id = String(node?.id ?? "").trim()
  const name = String(node?.title ?? node?.name ?? "").trim()
  const editions: ChallengeUpsert["editions"] = [] // TODO: derive from node's required-moment list
  if (!id || !name || editions.length === 0) {
    throw new Error(`unmappable challenge node (id=${id || "?"}, editions=${editions.length})`)
  }
  return {
    slug: `ts-${id}`,
    name,
    challengeType: "set_locking",
    endsAt: node?.endTime ?? null,
    status: "active",
    source: "topshot_gql",
    externalId: id,
    editions,
  }
}

async function gql(query: string): Promise<any> {
  const res = await fetch(TS_GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-proxy-secret": TS_PROXY_SECRET },
    body: JSON.stringify({ query }),
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

// Fetch + map active challenges. Throws (rather than returning junk) if the query is still
// the placeholder or the response doesn't match the confirmed shape — the cron logs it and
// writes nothing.
export async function fetchTopshotChallenges(): Promise<ChallengeUpsert[]> {
  if (!TS_PROXY_SECRET) throw new Error("TS_PROXY_SECRET not set — cannot reach Top Shot GraphQL")
  if (CHALLENGE_QUERY.includes("__CONFIRM_ME__")) {
    throw new Error("CHALLENGE_QUERY not yet confirmed — run scripts/probe-topshot-challenges.mjs and fill in lib/challenges/topshot-ingest.ts")
  }
  const data = await gql(CHALLENGE_QUERY)
  // The confirmed query's root field name replaces this scan; until then, take the first
  // array-valued field on the response as the node list.
  const nodes: any[] = Array.isArray(data)
    ? data
    : Object.values(data ?? {}).flatMap((v: any) =>
        Array.isArray(v) ? v : Array.isArray(v?.edges) ? v.edges.map((e: any) => e.node) : Array.isArray(v?.data) ? v.data : []
      )
  const out: ChallengeUpsert[] = []
  for (const node of nodes) {
    try { out.push(mapChallenge(node)) } catch { /* skip unmappable node; total is logged by the caller */ }
  }
  return out
}

// Upsert each fetched challenge through the RPC. Returns per-run counts for pipeline_runs.
export async function ingestTopshotChallenges(
  supabaseAdmin: any
): Promise<{ fetched: number; upserted: number; skipped: number }> {
  const challenges = await fetchTopshotChallenges()
  let upserted = 0
  let skipped = 0
  for (const c of challenges) {
    const { error } = await supabaseAdmin.rpc("upsert_challenge", {
      p_slug: c.slug,
      p_name: c.name,
      p_challenge_type: c.challengeType,
      p_description: c.description ?? null,
      p_reward_kind: c.rewardKind ?? null,
      p_reward_pack_dist_id: c.rewardPackDistId ?? null,
      p_reward_moment_external_id: c.rewardMomentExternalId ?? null,
      p_reward_label: c.rewardLabel ?? null,
      p_starts_at: c.startsAt ?? null,
      p_ends_at: c.endsAt ?? null,
      p_total_reward_allocation: c.totalRewardAllocation ?? null,
      p_completed_count: c.completedCount ?? null,
      p_status: c.status,
      p_source: "topshot_gql",
      p_external_id: c.externalId ?? null,
      p_image_url: c.imageUrl ?? null,
      p_editions: c.editions.map((e) => ({ external_id: e.externalId, play_id_onchain: e.playIdOnchain ?? null })),
    })
    if (error) skipped++
    else upserted++
  }
  return { fetched: challenges.length, upserted, skipped }
}
