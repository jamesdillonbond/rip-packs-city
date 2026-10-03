// app/api/support-chat/history/route.ts
// DELETE /api/support-chat/history — a signed-in user removes their own
// concierge transcripts (2026-10-03 audit: there was a 90-day purge and no
// user-initiated path).
//
// Identity is the Supabase session cookie ONLY — the body carries nothing that
// selects rows, so a caller can never name another user. Scope:
//   • support_conversations rows that are plain conversation turns
//     (feedback_type IS NULL) and belong to this user by email OR allow-list
//     username → DELETED.
//   • support_conversations rows that are logged feedback (feedback_type set —
//     the bug / feature-request / feedback queue the team triages) → kept, but
//     ANONYMISED: user_email / owner_key / user_wallet / session_id nulled. The
//     team keeps the report; the person is no longer attached to it.
//   • chat_sessions rows carrying this identity → identity columns nulled and
//     the recalled topics cleared, so the next open does not greet from them.
// Nothing is touched for an anonymous caller (401). Counts are the rows the
// statements RETURNED, never a self-report.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseServer } from "@/lib/auth/supabase-server";
import { apiErrorResponse } from "@/lib/api-error";
import { mineFilter } from "@/lib/concierge/history-filter";
import { boundedRead } from "@/lib/api/bounded-read";

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function deriveIdentity(): Promise<{ email: string | null; ownerKey: string | null }> {
  try {
    const sb = await getSupabaseServer();
    const { data, error } = await sb.auth.getUser();
    const email = data?.user?.email ?? null;
    if (error || !email) return { email: null, ownerKey: null };
    const { data: row } = await supabase
      .from("allow_list")
      .select("username")
      .ilike("email", email)
      .limit(1)
      .maybeSingle();
    return { email, ownerKey: row?.username ?? null };
  } catch {
    return { email: null, ownerKey: null };
  }
}

export async function DELETE() {
  const identity = await deriveIdentity();
  if (!identity.email) {
    return NextResponse.json({ error: "Sign in to delete your chat history." }, { status: 401 });
  }
  const filter = mineFilter(identity.email, identity.ownerKey);
  try {
    // 1. Transcript turns → deleted.
    // Each statement is bounded: an overrun resolves into the error branch
    // (lib/api/bounded-read.ts) instead of a platform 504 after the work.
    const { data: deleted, error: delErr } = await boundedRead(
      supabase
        .from("support_conversations")
        .delete()
        .is("feedback_type", null)
        .or(filter)
        .select("id"),
      "api/support-chat/history/delete-turns",
      8000,
    );
    if (delErr) return apiErrorResponse(delErr, "api/support-chat/history");

    // 2. Logged feedback → anonymised, kept for triage.
    const { data: anonymised, error: anonErr } = await boundedRead(
      supabase
        .from("support_conversations")
        .update({ user_email: null, owner_key: null, user_wallet: null, session_id: "deleted-by-user" })
        .not("feedback_type", "is", null)
        .or(filter)
        .select("id"),
      "api/support-chat/history/anonymise-feedback",
      8000,
    );
    if (anonErr) return apiErrorResponse(anonErr, "api/support-chat/history");

    // 3. Session memory → identity + recalled topics cleared.
    const { data: sessions, error: sessErr } = await boundedRead(
      supabase
        .from("chat_sessions")
        .update({ user_email: null, owner_key: null, user_wallet: null, last_topics: [], last_player_searched: null })
        .or(filter)
        .select("session_id"),
      "api/support-chat/history/clear-sessions",
      8000,
    );
    if (sessErr) return apiErrorResponse(sessErr, "api/support-chat/history");

    return NextResponse.json({
      ok: true,
      deleted_turns: Array.isArray(deleted) ? deleted.length : 0,
      anonymised_feedback: Array.isArray(anonymised) ? anonymised.length : 0,
      sessions_cleared: Array.isArray(sessions) ? sessions.length : 0,
    });
  } catch (err) {
    return apiErrorResponse(err, "api/support-chat/history");
  }
}
