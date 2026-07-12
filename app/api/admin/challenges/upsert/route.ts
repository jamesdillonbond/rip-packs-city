// app/api/admin/challenges/upsert/route.ts
//
// Seed / update a Top Shot challenge and its required-edition list. This is the single
// write seam for the challenge tracker: the operator uses it to define a challenge by
// hand today, and a future Top Shot-GraphQL ingest cron POSTs the same shape into it
// (with source:"topshot_gql") once the live challenge feed is wired through the
// topshot-proxy. Idempotent on (collection, slug) — re-POSTing replaces the edition list.
//
// POST /api/admin/challenges/upsert   Authorization: Bearer $INGEST_SECRET_TOKEN
// Body: {
//   slug, name, challengeType?('set_locking'|'crafting'|'collecting'),
//   description?, rewardKind?('pack'|'moment'|'other'),
//   rewardPackDistId?(string, pack_ev_latest.dist_id), rewardMomentExternalId?(setID:playID),
//   rewardLabel?, startsAt?(ISO), endsAt?(ISO),
//   totalRewardAllocation?(int), completedCount?(int),
//   status?('active'|'ended'|'upcoming'), source?('operator'|'topshot_gql'),
//   externalId?, imageUrl?,
//   editions: [{ externalId:'setID:playID', playIdOnchain?:int, required?:bool }]  // required-moment list
// }

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"
export const maxDuration = 30

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }

  const slug = String(body?.slug ?? "").trim()
  const name = String(body?.name ?? "").trim()
  if (!slug || !name) {
    return NextResponse.json({ error: "slug and name are required" }, { status: 400 })
  }

  // Normalize the required-edition list to the RPC's snake_case jsonb shape.
  const editions = Array.isArray(body?.editions)
    ? body.editions
        .map((e: any) => ({
          external_id: String(e?.externalId ?? e?.external_id ?? "").trim(),
          play_id_onchain:
            e?.playIdOnchain ?? e?.play_id_onchain ?? null,
          required: e?.required ?? true,
        }))
        .filter((e: any) => e.external_id)
    : []

  try {
    const { data, error } = await (supabaseAdmin as any).rpc("upsert_challenge", {
      p_slug: slug,
      p_name: name,
      p_challenge_type: body?.challengeType ?? "set_locking",
      p_description: body?.description ?? null,
      p_reward_kind: body?.rewardKind ?? null,
      p_reward_pack_dist_id: body?.rewardPackDistId != null ? String(body.rewardPackDistId) : null,
      p_reward_moment_external_id: body?.rewardMomentExternalId ?? null,
      p_reward_label: body?.rewardLabel ?? null,
      p_starts_at: body?.startsAt ?? null,
      p_ends_at: body?.endsAt ?? null,
      p_total_reward_allocation: body?.totalRewardAllocation ?? null,
      p_completed_count: body?.completedCount ?? null,
      p_status: body?.status ?? "active",
      p_source: body?.source ?? "operator",
      p_external_id: body?.externalId ?? null,
      p_image_url: body?.imageUrl ?? null,
      p_editions: editions,
    })
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json(
      { ok: true, challengeId: data, slug, editionCount: editions.length },
      { status: 200 }
    )
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}
