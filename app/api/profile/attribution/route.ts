// app/api/profile/attribution/route.ts
//
// POST — store the signed-in user's FIRST-TOUCH attribution, once (2026-11-09,
// signup-wave remediation P2). The body is the browser's `rpc_ft` record
// (lib/first-touch.ts); components/FirstTouchCapture.tsx sends it once per
// account per browser.
//
// ⚠ FIRST WRITE WINS, in the WHERE (`first_touch_at IS NULL`), not by a read
// then a write — two tabs signing in at once cannot both land.
// ⚠ A touch dated AFTER the account was created is refused (`after_signup`):
// it is a later visit, not how the collector found us, and storing it under
// "first touch" would mislabel it. That one rule also keeps every pre-11-09
// account out — their browsers mint `rpc_ft` only now.
//
// Answers: 200 { ok:true, stored:true|false } — `stored:false` means a first
// touch was already on record (the claim is complete either way, so the client
// stops sending); 400 { ok:false, reason } for a record it will never accept
// (the client also stops); 401 signed out; a failed write is an honest error
// (apiErrorResponse), so the client retries on a later page.

import { NextRequest, NextResponse } from "next/server"
import { requireUser } from "@/lib/auth/supabase-server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { validateFirstTouch } from "@/lib/first-touch"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, reason: "malformed" }, { status: 400 })
  }

  const verdict = validateFirstTouch(body, (user as { created_at?: string }).created_at ?? null, new Date())
  if (!verdict.ok) {
    return NextResponse.json({ ok: false, reason: verdict.reason }, { status: 400 })
  }

  // The profile row normally exists (auth confirm / callback touch it), but a
  // claim must not depend on that ordering: insert-if-absent first.
  const ensure = await boundedRead(
    (supabaseAdmin as any)
      .from("user_profiles")
      .upsert({ id: user.id }, { onConflict: "id", ignoreDuplicates: true }),
    "profile/attribution/ensure",
  )
  if (ensure.error) return apiErrorResponse(ensure.error, "api/profile/attribution")

  const { data, error } = await boundedRead(
    (supabaseAdmin as any)
      .from("user_profiles")
      .update(verdict.row)
      .eq("id", user.id)
      .is("first_touch_at", null)
      .select("id"),
    "profile/attribution/write",
  )
  if (error) return apiErrorResponse(error, "api/profile/attribution")

  // `stored` is DERIVED from whether the write landed, never assumed.
  const stored = Array.isArray(data) && data.length > 0
  return NextResponse.json({ ok: true, stored })
}
