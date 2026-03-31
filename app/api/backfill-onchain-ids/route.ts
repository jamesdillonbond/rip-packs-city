import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any

const TOPSHOT_GQL = "https://public-api.nbatopshot.com/graphql"

const GET_SET_PLAY_IDS = `
  query GetSetPlayIds($setID: ID!, $playID: ID!) {
    getEditionByPlayAndSet(input: { setID: $setID, playID: $playID }) {
      id
      set { id flowID }
      play { id flowID }
    }
  }
`

async function resolveOnChainIds(
  setUuid: string,
  playUuid: string
): Promise<{ setIdOnchain: number; playIdOnchain: number } | null> {
  try {
    const res = await fetch(TOPSHOT_GQL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationName: "GetSetPlayIds",
        query: GET_SET_PLAY_IDS,
        variables: { setID: setUuid, playID: playUuid },
      }),
    })
    if (!res.ok) return null
    const json = await res.json()
    const edition = json?.data?.getEditionByPlayAndSet
    if (!edition) return null
    const setIdOnchain  = parseInt(edition.set?.flowID,  10)
    const playIdOnchain = parseInt(edition.play?.flowID, 10)
    if (isNaN(setIdOnchain) || isNaN(playIdOnchain)) return null
    return { setIdOnchain, playIdOnchain }
  } catch { return null }
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
  const errors: string[] = []

  for (const edition of editions) {
    const parts = (edition.external_id as string).split(":")
    if (parts.length !== 2) { failed++; continue }
    const [setUuid, playUuid] = parts

    const ids = await resolveOnChainIds(setUuid, playUuid)
    if (!ids) {
      failed++
      errors.push(`Failed: ${edition.external_id}`)
      continue
    }

    const { error: updateErr } = await supabase
      .from("editions")
      .update({ set_id_onchain: ids.setIdOnchain, play_id_onchain: ids.playIdOnchain })
      .eq("id", edition.id)

    if (updateErr) {
      failed++
      errors.push(`Update failed for ${edition.id}: ${updateErr.message}`)
    } else {
      updated++
    }

    if (edition.set_id) {
      await supabase.from("sets")
        .update({ set_id_onchain: ids.setIdOnchain })
        .eq("id", edition.set_id)
        .is("set_id_onchain", null)
    }

    await new Promise((r) => setTimeout(r, 50))
  }

  return NextResponse.json({
    processed: editions.length, updated, failed,
    errors: errors.slice(0, 10),
    nextOffset: offset + limit,
    hint: failed > 0 ? `Retry with ?offset=${offset}&limit=${limit}` : undefined,
  })
}
