// app/api/profile/account/route.ts
//
// DELETE — close the signed-in user's account and erase what RPC holds about
// them. The control that calls this lives on /profile/edit
// (components/profile/DeleteAccountSection.tsx).
//
// Until 2026-10-11 the privacy policy said "you can delete your account from
// the Profile page" and no such route or control existed (platform review C1).
// This is the implementation that makes the sentence true.
//
// ORDER MATTERS, and it is the reverse of the obvious one:
//   1. public.delete_user_account(uuid) — a catalog-walking SECURITY DEFINER
//      purge (supabase/migrations/…delete_user_account_catalog_walk.sql,
//      pinned in supabase/tests/delete_user_account.sql). It needs the auth row
//      and profile_bio to still exist, because it resolves the user's username
//      and wallets from them to find owner_key-keyed rows.
//   2. auth.admin.deleteUser — removes the auth row; FK cascades clear the
//      tables that reference auth.users.
// If step 1 fails nothing has been removed and the user can retry. If step 2
// fails the data is gone but the account remains, which is also retryable.
// Deleting the auth user FIRST would cascade profile_bio away and leave every
// owner_key row unresolvable forever — a silent half-deletion.
//
// Honesty: a failed purge is a 5xx with no "ok"; the client shows it. The
// response never carries emails or keys — only per-table counts.

import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse, errorLogDetail } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { supabaseAdmin } from "@/lib/supabase"
import { requireUser, getSupabaseServer } from "@/lib/auth/supabase-server"

export const dynamic = "force-dynamic"

/** The exact phrase the client must send; a guard against a stray fetch, not a security control. */
export const DELETE_CONFIRMATION = "DELETE"

export async function DELETE(req: NextRequest) {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }

  let body: { confirm?: unknown } = {}
  try {
    body = (await req.json()) as { confirm?: unknown }
  } catch {
    body = {}
  }
  if (body?.confirm !== DELETE_CONFIRMATION) {
    return NextResponse.json(
      { error: "confirmation_required", detail: `Send { confirm: "${DELETE_CONFIRMATION}" } to delete the account.` },
      { status: 400 }
    )
  }

  // 1. Purge the data while the account still exists.
  // Bounded so a wedged purge answers with the honest 5xx below instead of a
  // platform 504 (withBoardBudget resolves into the error branch).
  const { data: report, error: purgeError } = await boundedRead(
    (supabaseAdmin as any).rpc("delete_user_account", { p_user_id: user.id }),
    "api/profile/account/delete_user_account"
  )
  if (purgeError) {
    console.error("[profile/account DELETE] purge failed", { userId: user.id, detail: errorLogDetail(purgeError) })
    return apiErrorResponse(purgeError, "api/profile/account")
  }
  if (!report || report.ok !== true) {
    // A purge that returned without `ok` is not a success we can report as one.
    console.error("[profile/account DELETE] purge returned no ok", { userId: user.id })
    return NextResponse.json({ error: "purge_incomplete" }, { status: 502 })
  }

  // 2. Remove the auth user. FK cascades clear the remaining references.
  const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(user.id)
  if (authError) {
    console.error("[profile/account DELETE] auth delete failed after purge", { userId: user.id, detail: errorLogDetail(authError) })
    return NextResponse.json(
      {
        error: "auth_delete_failed",
        detail: "Your data was removed but the sign-in account could not be closed. Try again, or contact us.",
        rows: report.rows ?? {},
      },
      { status: 502 }
    )
  }

  // 3. End this browser's session so the response is not a signed-in page for a user that no longer exists.
  try {
    const supabase = await getSupabaseServer()
    await supabase.auth.signOut()
  } catch {
    // The account is gone; a sign-out failure only means the cookie outlives it by its TTL.
  }

  const res = NextResponse.json({ ok: true, rows: report.rows ?? {} })
  // The proxy's 60 s allow-list cache cookie must not keep answering for a deleted account.
  res.cookies.set({ name: "rpc_al_check", value: "", maxAge: 0, path: "/" })
  return res
}
