import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const TOPSHOT_GQL = "https://public-api.nbatopshot.com/graphql"
const GQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "rip-packs-city/1.0",
}

const WALLET = "0xbd94cade097e50ac"
const BATCH_SIZE = 50
const CONCURRENCY = 8
const GQL_TIMEOUT_MS = 8000

export const maxDuration = 300

function formatTier(tier: string | null | undefined): string {
  if (!tier) return "COMMON"
  const t = tier.toUpperCase()
  if (t.includes("ULTIMATE")) return "ULTIMATE"
  if (t.includes("LEGENDARY")) return "LEGENDARY"
  if (t.includes("RARE")) return "RARE"
  if (t.includes("FANDOM")) return "FANDOM"
  return "COMMON"
}

async function fetchMomentGQL(momentId: string): Promise<{ tier: string; acquiredAt: string | null }> {
  const query = `
    query GetMoment($id: ID!) {
      getMintedMoment(momentId: $id) {
        data {
          tier
          createdAt
        }
      }
    }
  `
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), GQL_TIMEOUT_MS)
  try {
    const res = await fetch(TOPSHOT_GQL, {
      method: "POST",
      headers: GQL_HEADERS,
      body: JSON.stringify({ query, variables: { id: momentId } }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`GQL ${res.status}`)
    const json = await res.json()
    const data = json?.data?.getMintedMoment?.data
    return {
      tier: formatTier(data?.tier),
      acquiredAt: data?.createdAt ?? null,
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function runWorker() {
    while (true) {
      const i = nextIndex++
      if (i >= items.length) return
      results[i] = await worker(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker))
  return results
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token")
  if (token !== process.env.INGEST_SECRET_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const offset = parseInt(req.nextUrl.searchParams.get("offset") ?? "0")
  const limit = parseInt(req.nextUrl.searchParams.get("limit") ?? String(BATCH_SIZE))

  const startTime = Date.now()

  const { data: rows, error: fetchErr } = await supabase
    .from("wallet_moments_cache")
    .select("moment_id, edition_key")
    .eq("wallet_address", WALLET)
    .is("tier", null)
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1)

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  if (!rows || rows.length === 0) {
    return NextResponse.json({ message: "All moments have tier — backfill complete", total: 0 })
  }

  type GQLResult = {
    momentId: string
    editionKey: string | null
    tier: string
    acquiredAt: string | null
    ok: boolean
  }

  const results: GQLResult[] = await mapWithConcurrency(rows, CONCURRENCY, async (row: any) => {
    try {
      const { tier, acquiredAt } = await fetchMomentGQL(row.moment_id)
      return { momentId: row.moment_id, editionKey: row.edition_key, tier, acquiredAt, ok: true }
    } catch {
      return { momentId: row.moment_id, editionKey: row.edition_key, tier: "COMMON", acquiredAt: null, ok: false }
    }
  })

  const successful = results.filter(r => r.ok)
  const failed = results.filter(r => !r.ok)

  await Promise.all(
    successful.map(r =>
      supabase
        .from("wallet_moments_cache")
        .update({ tier: r.tier, acquired_at: r.acquiredAt })
        .eq("wallet_address", WALLET)
        .eq("moment_id", r.momentId)
    )
  )

  const tierPriority: Record<string, number> = { ULTIMATE: 4, LEGENDARY: 3, RARE: 2, FANDOM: 1, COMMON: 0 }
  const editionTierMap = new Map<string, string>()
  for (const r of successful) {
    if (!r.editionKey) continue
    const existing = editionTierMap.get(r.editionKey)
    if (!existing || (tierPriority[r.tier] ?? 0) > (tierPriority[existing] ?? 0)) {
      editionTierMap.set(r.editionKey, r.tier)
    }
  }

  let editionUpdated = 0
  let editionErrors = 0
  for (const [editionKey, tier] of editionTierMap) {
    const { error } = await supabase
      .from("editions")
      .update({ tier })
      .eq("external_id", editionKey)
      .is("tier", null)
    if (error) editionErrors++
    else editionUpdated++
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

  const { count: remaining } = await supabase
    .from("wallet_moments_cache")
    .select("moment_id", { count: "exact", head: true })
    .eq("wallet_address", WALLET)
    .is("tier", null)

  return NextResponse.json({
    processed: rows.length,
    successful: successful.length,
    failed: failed.length,
    editionUpdated,
    editionErrors,
    editionKeysProcessed: editionTierMap.size,
    remainingInCache: remaining ?? "unknown",
    nextOffset: offset + limit,
    elapsed: `${elapsed}s`,
    hint: (remaining ?? 1) > 0
      ? `Run again with ?offset=${offset + limit}&token=...`
      : "All moments processed!",
  })
}
