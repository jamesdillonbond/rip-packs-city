// app/api/alerts/pack-chase/route.ts
//
// Session-authed Top Shot pack-chase watches (pack_chase_watches). owner_key is
// ALWAYS the session user id — never a body field (same invariant as /api/alerts).
//
//   GET    -> this user's watches, each with its CURRENT reading (or null when the
//             reading is unknown — stale, refuted, or the read failed; never a 0).
//   POST   -> create/update { dist_id, tier, min_vs_launch } (upsert on owner+dist+tier).
//   DELETE -> ?id= (scoped to owner_key).
//
// Fired by the pack-chase leg of /api/cron/alerts-dispatch (lib/packs/chase-alerts.ts).
// Not anon-public: proxy.ts gates /api/alerts/** for signed-out callers.

export const maxDuration = 10
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"
import { CHASE_TIERS, type ChaseTier } from "@/lib/packs/chase-odds"
import { readingFor, type ChaseReading } from "@/lib/packs/chase-alerts"
import { asOfObservedFloors } from "@/lib/pack-dist/observed-as-of"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabase
const DIST_RE = /^[0-9]{1,9}$/
const MAX_WATCHES = 50

export async function GET() {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }
  const { data: watches, error } = await boundedRead(sb
    .from("pack_chase_watches")
    .select("id, dist_id, title, tier, min_vs_launch, active, armed, last_fired_at, last_fired_vs, created_at")
    .eq("owner_key", user.id)
    .order("created_at", { ascending: false }), "api/alerts/pack-chase/watches")
  if (error) return apiErrorResponse(error, "api/alerts/pack-chase")
  const list = (watches ?? []) as Array<{ id: string; dist_id: string; tier: ChaseTier }>
  if (list.length === 0) return NextResponse.json({ watches: [], readings_ok: true })

  const ids = [...new Set(list.map((w) => w.dist_id))]
  const [{ data: atlas, error: aErr }, { data: meta, error: mErr }] = await Promise.all([
    boundedRead(sb.from("topshot_atlas_dists")
      .select("dist_id, title, summary_fetched_at, unopened_count, total_pack_count, remaining_by_tier, original_by_tier")
      .in("dist_id", ids), "api/alerts/pack-chase/atlas"),
    boundedRead(sb.from("pack_table_rows").select("dist_id, observed_packs_opened").eq("collection_slug", "nba-top-shot").in("dist_id", ids), "api/alerts/pack-chase/meta"),
  ])
  // A failed reading read is reported as such: the watches still list, each with
  // reading null and readings_ok false, so the page says "couldn't load", not "0".
  const readingsOk = !aErr && !mErr
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const atlasById = new Map<string, any>((readingsOk ? atlas ?? [] : []).map((a: any) => [a.dist_id, a]))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obsAll = new Map<string, any>((readingsOk ? meta ?? [] : []).map((m: any) => [m.dist_id, m.observed_packs_opened]))
  // Floor as of each payload's stamp (lib/pack-dist/observed-as-of.ts).
  const obsById = readingsOk ? await asOfObservedFloors(sb, [...atlasById.values()], obsAll) : obsAll
  const now = Date.now()
  const out = list.map((w) => {
    const reading: ChaseReading | null = readingsOk ? readingFor(atlasById.get(w.dist_id), obsById.get(w.dist_id), w.tier, now) : null
    return { ...w, reading }
  })
  return NextResponse.json({ watches: out, readings_ok: readingsOk })
}

export async function POST(req: NextRequest) {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const distId = String(body?.dist_id ?? "").trim()
  const tier = String(body?.tier ?? "").trim().toLowerCase()
  const min = Number(body?.min_vs_launch ?? 2)
  if (!DIST_RE.test(distId)) return NextResponse.json({ error: "dist_id must be a Top Shot pack distribution id" }, { status: 400 })
  if (!(CHASE_TIERS as readonly string[]).includes(tier)) return NextResponse.json({ error: "tier must be legendary, ultimate or rare" }, { status: 400 })
  if (!Number.isFinite(min) || min < 1 || min > 1000) return NextResponse.json({ error: "min_vs_launch must be between 1 and 1000" }, { status: 400 })

  // The dist must be a Top Shot dist we have live counts for — a watch on an id we
  // can never read would sit silently forever.
  const { data: dist, error: dErr } = await boundedRead(sb.from("topshot_atlas_dists").select("dist_id, title").eq("dist_id", distId).maybeSingle(), "api/alerts/pack-chase/dist")
  if (dErr) return apiErrorResponse(dErr, "api/alerts/pack-chase")
  if (!dist) return NextResponse.json({ error: "No live pack counts for that distribution" }, { status: 404 })

  const { count, error: cErr } = await boundedRead(sb.from("pack_chase_watches").select("id", { count: "exact", head: true }).eq("owner_key", user.id), "api/alerts/pack-chase/count")
  if (cErr) return apiErrorResponse(cErr, "api/alerts/pack-chase")
  if (count == null) return NextResponse.json({ error: "Couldn't check your watch count; try again." }, { status: 503 })
  if (count >= MAX_WATCHES) {
    // The upsert below UPDATES an existing (owner, dist, tier) watch rather than
    // adding one, so a collector at the cap may still edit what they have
    // (2026-11-07 review: changing min_vs_launch at 50 watches was refused).
    const { data: existing, error: eErr } = await boundedRead(
      sb.from("pack_chase_watches").select("id").eq("owner_key", user.id).eq("dist_id", distId).eq("tier", tier).limit(1),
      "api/alerts/pack-chase/existing",
    )
    if (eErr) return apiErrorResponse(eErr, "api/alerts/pack-chase")
    if (!Array.isArray(existing) || existing.length === 0) {
      return NextResponse.json({ error: `You can watch up to ${MAX_WATCHES} packs.` }, { status: 409 })
    }
  }

  const { data, error } = await sb
    .from("pack_chase_watches")
    .upsert(
      {
        owner_key: user.id, // session-resolved, never from the body
        dist_id: distId,
        title: dist.title ?? null,
        tier,
        min_vs_launch: min,
        active: true,
        armed: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "owner_key,dist_id,tier" },
    )
    .select("id, dist_id, title, tier, min_vs_launch, active, armed")
  if (error) return apiErrorResponse(error, "api/alerts/pack-chase")
  if (!data || data.length === 0) return NextResponse.json({ error: "The watch was not saved." }, { status: 500 })
  return NextResponse.json({ ok: true, watch: data[0] })
}

export async function DELETE(req: NextRequest) {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }
  const id = req.nextUrl.searchParams.get("id")
  if (!id) return NextResponse.json({ error: "id query param is required" }, { status: 400 })
  const { data, error } = await sb.from("pack_chase_watches").delete().eq("id", id).eq("owner_key", user.id).select("id")
  if (error) return apiErrorResponse(error, "api/alerts/pack-chase")
  if (!data || data.length === 0) return NextResponse.json({ error: "Watch not found" }, { status: 404 })
  return NextResponse.json({ ok: true, deleted: data.length })
}
