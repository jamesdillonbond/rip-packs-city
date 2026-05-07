// app/api/profile/first-run-tour/route.ts
//
// Stamps profile_bio.first_run_completed_at when the user finishes /
// dismisses the FirstRunTour, and exposes a GET that the dashboard reads
// on mount to decide whether to render the tour. Uses requireUser so the
// stamp is always keyed on auth.uid().

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"

export const dynamic = "force-dynamic"

// GET → { completed: boolean, completed_at: ISO | null }
export async function GET(_req: NextRequest) {
  let user
  try { user = await requireUser() } catch (res) { return res as Response }

  const { data, error } = await supabase
    .from("profile_bio")
    .select("first_run_completed_at")
    .eq("user_id", user.id)
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    completed: !!data?.first_run_completed_at,
    completed_at: data?.first_run_completed_at ?? null,
  })
}

// POST { completed: true | false } — true stamps NOW(), false resets to NULL
// (the /settings "restart tour" path).
export async function POST(req: NextRequest) {
  let user
  try { user = await requireUser() } catch (res) { return res as Response }

  let body: { completed?: unknown }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const completed = body.completed === false ? null : new Date().toISOString()

  // Upsert by user_id so a fresh signup without a profile_bio row still
  // captures the stamp. profile_bio.user_id is the FK to auth.users via the
  // Phase 4 schema.
  const { error } = await supabase
    .from("profile_bio")
    .upsert(
      { user_id: user.id, first_run_completed_at: completed, updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    )

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, completed_at: completed })
}
