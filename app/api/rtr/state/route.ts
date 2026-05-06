// app/api/rtr/state/route.ts
//
// Authenticated read+write of the user's self-reported Road to the Ring state
// (total points + spendable balance). Tier is derived from total points using
// the v1 thresholds — no calibration data yet.

import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"

export const dynamic = "force-dynamic"

const ROUTE_HEADERS: Record<string, string> = { "X-RPC-Route": "rtr-state" }

type TierName =
  | "Prospect"
  | "Starter"
  | "All-Star"
  | "All-NBA"
  | "MVP"
  | "Legend"

function tierFromPoints(points: number): TierName {
  if (points >= 200000) return "Legend"
  if (points >= 100000) return "MVP"
  if (points >= 40000) return "All-NBA"
  if (points >= 10000) return "All-Star"
  if (points >= 1000) return "Starter"
  return "Prospect"
}

const postSchema = z.object({
  reportedTotalPoints: z.coerce.number().int().min(0).max(10_000_000),
  reportedSpendableBalance: z.coerce.number().int().min(0).max(10_000_000),
})

export async function GET() {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }
  try {
    const { data, error } = await supabase
      .from("rtr_user_state")
      .select("reported_total_points, reported_spendable_balance, current_tier, reported_at, updated_at")
      .eq("user_id", user.id)
      .maybeSingle()
    if (error) {
      console.error("[rtr-state GET]", error.message)
      return NextResponse.json(
        { error: "internal_error", detail: error.message },
        { status: 500, headers: ROUTE_HEADERS },
      )
    }
    if (!data) {
      return NextResponse.json(
        {
          reportedTotalPoints: 0,
          reportedSpendableBalance: 0,
          currentTier: "Prospect" as TierName,
          reportedAt: null,
          updatedAt: null,
        },
        { headers: ROUTE_HEADERS },
      )
    }
    return NextResponse.json(
      {
        reportedTotalPoints: Number(data.reported_total_points ?? 0),
        reportedSpendableBalance: Number(data.reported_spendable_balance ?? 0),
        currentTier: (data.current_tier ?? "Prospect") as TierName,
        reportedAt: data.reported_at,
        updatedAt: data.updated_at,
      },
      { headers: ROUTE_HEADERS },
    )
  } catch (err: any) {
    console.error("[rtr-state GET]", err?.message ?? err)
    return NextResponse.json(
      { error: "internal_error", detail: err?.message ?? String(err) },
      { status: 500, headers: ROUTE_HEADERS },
    )
  }
}

export async function POST(req: NextRequest) {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: "malformed_json" }, { status: 400, headers: ROUTE_HEADERS })
  }
  const parsed = postSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.format() },
      { status: 400, headers: ROUTE_HEADERS },
    )
  }
  const { reportedTotalPoints, reportedSpendableBalance } = parsed.data
  const currentTier = tierFromPoints(reportedTotalPoints)
  const nowIso = new Date().toISOString()

  try {
    const { data, error } = await supabase
      .from("rtr_user_state")
      .upsert(
        {
          user_id: user.id,
          reported_total_points: reportedTotalPoints,
          reported_spendable_balance: reportedSpendableBalance,
          current_tier: currentTier,
          reported_at: nowIso,
          updated_at: nowIso,
        },
        { onConflict: "user_id" },
      )
      .select("reported_total_points, reported_spendable_balance, current_tier, reported_at, updated_at")
      .single()

    if (error || !data) {
      console.error("[rtr-state POST]", error?.message)
      return NextResponse.json(
        { error: "internal_error", detail: error?.message },
        { status: 500, headers: ROUTE_HEADERS },
      )
    }

    return NextResponse.json(
      {
        reportedTotalPoints: Number(data.reported_total_points ?? 0),
        reportedSpendableBalance: Number(data.reported_spendable_balance ?? 0),
        currentTier: (data.current_tier ?? "Prospect") as TierName,
        reportedAt: data.reported_at,
        updatedAt: data.updated_at,
      },
      { headers: ROUTE_HEADERS },
    )
  } catch (err: any) {
    console.error("[rtr-state POST]", err?.message ?? err)
    return NextResponse.json(
      { error: "internal_error", detail: err?.message ?? String(err) },
      { status: 500, headers: ROUTE_HEADERS },
    )
  }
}
