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

// Read lazily inside the functions (env may be set after module load, e.g. in tests).
const tsGql = () => process.env.TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"
const tsProxySecret = () => process.env.TS_PROXY_SECRET || ""

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

// Confirmed via scripts/probe-topshot-challenges.mjs (introspection disabled → schema
// reconstructed from validation errors). UserChallenge exposes the required-moment list as
// `slots[].{setID,playID}` and the reward as a moment `reward.{setID,playID}`. No
// deadline/status/completion field is exposed by this endpoint, so those stay null.
const CHALLENGE_QUERY = `
  query RpcActiveChallenges {
    getActiveChallenges {
      challenges {
        id
        name
        description
        type
        reward { setID playID }
        slots { setID playID }
      }
    }
  }
`

// setID/playID → our edition external_id "setID:playID". Both must be present + non-zero.
function extId(setID: unknown, playID: unknown): string | null {
  const s = Number(setID)
  const p = Number(playID)
  if (!Number.isFinite(s) || !Number.isFinite(p) || s <= 0 || p <= 0) return null
  return `${s}:${p}`
}

// Best-effort map of Top Shot's challenge `type` string to our challenge_type CHECK values.
function mapType(raw: unknown): ChallengeUpsert["challengeType"] {
  const t = String(raw ?? "").toLowerCase()
  if (t.includes("craft")) return "crafting"
  if (t.includes("collect")) return "collecting"
  return "set_locking" // lock / default
}

// Map one UserChallenge node to a ChallengeUpsert. Throws if it has no required-moment
// list (better a logged skip than a half-formed challenge).
export function mapChallenge(node: any): ChallengeUpsert {
  const id = String(node?.id ?? "").trim()
  const name = String(node?.name ?? "").trim()

  const seen = new Set<string>()
  const editions: ChallengeUpsert["editions"] = []
  for (const slot of Array.isArray(node?.slots) ? node.slots : []) {
    const ext = extId(slot?.setID, slot?.playID)
    if (ext && !seen.has(ext)) {
      seen.add(ext)
      editions.push({ externalId: ext, playIdOnchain: Number(slot.playID) })
    }
  }
  if (!id || !name || editions.length === 0) {
    throw new Error(`unmappable challenge node (id=${id || "?"}, editions=${editions.length})`)
  }

  const rewardExt = extId(node?.reward?.setID, node?.reward?.playID)
  return {
    slug: `ts-${id}`,
    name,
    challengeType: mapType(node?.type),
    description: typeof node?.description === "string" ? node.description : null,
    rewardKind: rewardExt ? "moment" : null,
    rewardMomentExternalId: rewardExt,
    status: "active",
    source: "topshot_gql",
    externalId: id,
    editions,
  }
}

async function gql(query: string): Promise<any> {
  const res = await fetch(tsGql(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-proxy-secret": tsProxySecret() },
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

// Fetch + map active challenges. Throws (rather than returning junk) if the response
// doesn't match the confirmed shape — the cron logs it and writes nothing.
export async function fetchTopshotChallenges(): Promise<ChallengeUpsert[]> {
  if (!tsProxySecret()) throw new Error("TS_PROXY_SECRET not set — cannot reach Top Shot GraphQL")
  const data = await gql(CHALLENGE_QUERY)
  const nodes: any[] = data?.getActiveChallenges?.challenges
  if (!Array.isArray(nodes)) {
    throw new Error("unexpected getActiveChallenges shape — expected { getActiveChallenges: { challenges: [...] } }")
  }
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
