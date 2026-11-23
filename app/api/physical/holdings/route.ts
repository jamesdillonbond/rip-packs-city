// app/api/physical/holdings/route.ts
//
// Physical cards a user owns (prototype). OFF (404) unless PHYSICAL_CARDS=1 and
// HCI_API_KEY are set, and the tables in docs/physical/physical-holdings-draft.sql exist.
//
//   GET                — { holdings: [...] } for the signed-in user
//   POST   { cardId, grader, grade, certNumber? , rawCondition?, quantity?, costBasisUsd?, acquiredOn? }
//   DELETE { id }
//
// Values are NOT returned here: the portfolio view reads physical_value_cache
// and totals with lib/physical/portfolio.ts (unpriced is never $0).

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { physicalEnabled } from "@/lib/physical/flags"
import { parseHoldingInput } from "@/lib/physical/holding-input"

export const dynamic = "force-dynamic"
const NO_STORE = { "Cache-Control": "no-store" }
// PostgREST clamps every read at 1,000 rows (postgrest-clamps-set-returning-rpc-results), so a larger bound would be false.
const MAX_HOLDINGS = 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const off = () => NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE })

async function user() {
  try {
    return { user: await requireUser() }
  } catch (res) {
    return { res: res as Response }
  }
}

export async function GET() {
  if (!physicalEnabled()) return off()
  const u = await user()
  if (!u.user) return u.res
  const { data, error } = await boundedRead(
    supabase
      .from("physical_holdings")
      .select("id, card_id, grader, grade, cert_number, raw_condition, quantity, cost_basis_usd, acquired_on, created_at")
      .eq("user_id", u.user.id)
      .order("created_at", { ascending: false })
      .limit(MAX_HOLDINGS),
    "api/physical/holdings/list",
  )
  if (error) return apiErrorResponse(error, "api/physical/holdings")
  return NextResponse.json({ holdings: data ?? [] }, { headers: NO_STORE })
}

export async function POST(req: NextRequest) {
  if (!physicalEnabled()) return off()
  let body: unknown
  try {
    body = await req.json()
  } catch {
    body = null
  }
  const parsed = parseHoldingInput(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE })
  const u = await user()
  if (!u.user) return u.res
  const v = parsed.value
  const { data, error } = await supabase
    .from("physical_holdings")
    .insert({
      user_id: u.user.id,
      card_id: v.cardId,
      grader: v.grader,
      grade: v.grade,
      cert_number: v.certNumber,
      raw_condition: v.rawCondition,
      quantity: v.quantity,
      cost_basis_usd: v.costBasisUsd,
      acquired_on: v.acquiredOn,
    })
    .select("id")
    .single()
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return NextResponse.json({ error: "You already added that slab." }, { status: 409, headers: NO_STORE })
    }
    return apiErrorResponse(error, "api/physical/holdings/insert")
  }
  return NextResponse.json({ id: (data as { id: string }).id }, { status: 201, headers: NO_STORE })
}

export async function DELETE(req: NextRequest) {
  if (!physicalEnabled()) return off()
  let id = ""
  try {
    id = String(((await req.json()) as { id?: unknown })?.id ?? "")
  } catch {
    /* fall through */
  }
  if (!UUID.test(id)) return NextResponse.json({ error: "id required" }, { status: 400, headers: NO_STORE })
  const u = await user()
  if (!u.user) return u.res
  // user_id in the filter: the service role bypasses RLS, so ownership is enforced here.
  const { error } = await supabase.from("physical_holdings").delete().eq("id", id).eq("user_id", u.user.id)
  if (error) return apiErrorResponse(error, "api/physical/holdings/delete")
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}
