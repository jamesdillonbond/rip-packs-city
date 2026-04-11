import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any

const TOPSHOT_GQL_DIRECT = "https://public-api.nbatopshot.com/graphql"

// Query a single moment listing to get setID + playID integers from a UUID-format external_id.
// We look up by playUuid using searchMomentListings which is known to work from the sniper feed.
const GET_EDITION_IDS = `
  query GetEditionIds($playID: ID!, $setID: ID!) {
    getEditionByPlayAndSet(input: { playID: $playID, setID: $setID }) {
      id
      play { id stats { playerID } }
      set { id flowName flowID }
      flowID
    }
  }
`

// Fallback: use searchMomentListings with a filter to get one moment and extract setID/playID
const SEARCH_BY_EDITION = `
  query SearchByEdition($setID: String!, $playID: String!) {
    searchMomentListings(
      input: {
        filters: { byEditions: [{ setID: $setID, playID: $playID }] }
        sortBy: { field: UPDATED_AT, direction: DESC }
        pagination: { cursor: "", direction: AFTER, limit: 1 }
      }
    ) {
      data {
        moment {
          flowRetired
          setPlay { setID playID}
        }
      }
    }
  }
`

async function resolveFromUuids(
  setUuid: string,
  playUuid: string
): Promise<{ setIdOnchain: number; playIdOnchain: number } | null> {
  try {
    // Route through the Cloudflare Worker proxy when configured — Cloudflare
    // blocks Vercel IPs from hitting public-api.nbatopshot.com directly.
    const proxyUrl = process.env.TS_PROXY_URL
    const proxySecret = process.env.TS_PROXY_SECRET
    const url = proxyUrl || TOPSHOT_GQL_DIRECT
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (proxyUrl && proxySecret) {
      headers["X-Proxy-Secret"] = proxySecret
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        operationName: "SearchByEdition",
        query: SEARCH_BY_EDITION,
        variables: { setID: setUuid, playID: playUuid },
      }),
    })
    if (!res.ok) return null
    const json = await res.json()

    const moments = json?.data?.searchMomentListings?.data
    if (moments && moments.length > 0) {
      const sp = moments[0]?.moment?.setPlay
      if (sp) {
        const setIdOnchain  = parseInt(sp.setID,  10)
        const playIdOnchain = parseInt(sp.playID, 10)
        if (!isNaN(setIdOnchain) && !isNaN(playIdOnchain)) {
          return { setIdOnchain, playIdOnchain }
        }
      }
    }
    return null
  } catch (e) {
    console.error("resolveFromUuids error:", e)
    return null
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  if (searchParams.get("secret") !== process.env.INGEST_SECRET_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const limit  = parseInt(searchParams.get("limit")  ?? "100")
  const offset = parseInt(searchParams.get("offset") ?? "0")

  const { data: editions, error } = await supabase
    .from("editions")
    .select("id, external_id, set_id")
    .is("set_id_onchain", null)
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!editions || editions.length === 0) {
    return NextResponse.json({ message: "All editions backfilled", total: 0 })
  }

  let updated = 0
  let failed  = 0
  let direct  = 0
  const errors: string[] = []

  for (const edition of editions) {
    const extId = edition.external_id as string
    const parts = extId.split(":")
    if (parts.length !== 2) { failed++; continue }

    const [left, right] = parts
    let ids: { setIdOnchain: number; playIdOnchain: number } | null = null

    // Check if already integers (old format like "37:1199")
    const leftInt  = parseInt(left,  10)
    const rightInt = parseInt(right, 10)

    if (!isNaN(leftInt) && !isNaN(rightInt) && String(leftInt) === left && String(rightInt) === right) {
      // Already in setId:playId integer format — use directly
      ids = { setIdOnchain: leftInt, playIdOnchain: rightInt }
      direct++
    } else {
      // UUID format — query Top Shot GQL
      ids = await resolveFromUuids(left, right)
      if (!ids) {
        failed++
        if (errors.length < 10) errors.push(`Failed: ${extId}`)
        continue
      }
      await new Promise((r) => setTimeout(r, 50)) // rate limit only for GQL calls
    }

    const { error: updateErr } = await supabase
      .from("editions")
      .update({ set_id_onchain: ids.setIdOnchain, play_id_onchain: ids.playIdOnchain })
      .eq("id", edition.id)

    if (updateErr) {
      failed++
      if (errors.length < 10) errors.push(`Update failed ${edition.id}: ${updateErr.message}`)
    } else {
      updated++
      // Denorm to sets table
      if (edition.set_id) {
        await supabase.from("sets")
          .update({ set_id_onchain: ids.setIdOnchain })
          .eq("id", edition.set_id)
          .is("set_id_onchain", null)
      }
    }
  }

  return NextResponse.json({
    processed: editions.length, updated, failed, direct,
    errors: errors.slice(0, 10),
    nextOffset: offset + limit,
    hint: failed > 0 ? `Some GQL lookups failed — check Top Shot API or retry` : undefined,
  })
}
