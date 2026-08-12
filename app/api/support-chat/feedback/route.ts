// app/api/support-chat/feedback/route.ts
// POST /api/support-chat/feedback
// Body: { messageId?: number | null, sessionId: string, feedback: "up" | "down", comment?: string }
//
// Targets the support_conversations row by primary-key id when messageId is
// present (the streaming path returns messageId in the trailing meta payload),
// otherwise falls back to the latest row in the session via select-then-update.
// The previous .update().eq().order().limit(1) shape silently dropped the
// order/limit clauses on the JS client — that bug is why with_feedback was 0
// across hundreds of conversations.
//
// ⚠ SECURITY — sessionId is REQUIRED and every write is scoped by it.
// This route is anon-reachable (proxy.ts allows /api/support-chat/*) and holds a
// SERVICE-ROLE client, so an `.eq("id", messageId)` alone was an unauthenticated
// write IDOR: support_conversations.id is a sequential bigint, so anyone could
// walk it and flip feedback on any row — and, once signed in (the front door is
// open to any email), overwrite user_email / owner_key / user_wallet and destroy
// attribution on rows that carry a real identity. deriveIdentity() was written
// INTO the row but never compared against it.
// The session id is already the capability token for this conversation (it is
// cryptographically random and support_conversations RLS keys on it — see
// getOrCreateSessionId in components/SupportChat.tsx), so scoping the UPDATE by
// (id AND session_id) reuses the existing security model rather than inventing
// one. A caller who does not hold the session id cannot target the row at all.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseServer } from "@/lib/auth/supabase-server";
import { apiErrorResponse } from "@/lib/api-error";

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Resolve the authenticated email + allow_list identity from the cookie so
// feedback writes backfill user_email / owner_key / user_wallet on rows that
// were inserted before identity capture landed.
async function deriveIdentity(): Promise<{
  email: string | null;
  ownerKey: string | null;
  userWallet: string | null;
}> {
  try {
    const sb = await getSupabaseServer();
    const { data, error } = await sb.auth.getUser();
    const email = data?.user?.email ?? null;
    if (error || !email) return { email: null, ownerKey: null, userWallet: null };
    const { data: row } = await supabase
      .from("allow_list")
      .select("username, wallet_addr")
      .ilike("email", email)
      .limit(1)
      .maybeSingle();
    return {
      email,
      ownerKey: row?.username ?? null,
      userWallet: row?.wallet_addr ?? null,
    };
  } catch {
    return { email: null, ownerKey: null, userWallet: null };
  }
}

export async function POST(req: NextRequest) {
  try {
    const { messageId, sessionId, feedback, comment } = await req.json();

    if (!feedback || (feedback !== "up" && feedback !== "down")) {
      return NextResponse.json({ error: "feedback must be 'up' or 'down'" }, { status: 400 });
    }
    // sessionId is the capability that authorizes the write — it is never
    // optional. The only caller (FeedbackButtons in components/SupportChat.tsx)
    // has always sent it alongside messageId, so requiring it breaks nothing.
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      return NextResponse.json({ error: "sessionId required" }, { status: 400 });
    }

    // `feedback` is CHECK-constrained to exactly 'up' | 'down'
    // (support_conversations_feedback_check), so the old
    // `${feedback}: ${comment}` concatenation could only ever violate the
    // constraint and 500 — the comment path had never once persisted. A comment
    // now goes to feedback_details, the existing free-text column for it.
    const feedbackValue = feedback;
    const identity = await deriveIdentity();
    // Only backfill identity columns when the cookie carries an authed user.
    // Anonymous feedback writes (rare — proxy.ts gates everything but defensive)
    // leave existing values untouched.
    const identityPatch: Record<string, string> = {};
    if (identity.email) identityPatch.user_email = identity.email;
    if (identity.ownerKey) identityPatch.owner_key = identity.ownerKey;
    if (identity.userWallet) identityPatch.user_wallet = identity.userWallet;
    if (typeof comment === "string" && comment.trim()) {
      identityPatch.feedback_details = comment.trim().slice(0, 2000);
    }

    // Preferred path: target by primary key id (the streaming meta payload
    // includes the support_conversations row id as messageId).
    if (typeof messageId === "number" && Number.isFinite(messageId)) {
      // Scoped by session_id as well as id: holding the row id is not enough.
      // .select("id") is what makes a non-matching pair observable — without it
      // an UPDATE touching zero rows returns no error and we would report
      // success on someone else's row id.
      const { data: updated, error } = await supabase
        .from("support_conversations")
        .update({ feedback: feedbackValue, ...identityPatch })
        .eq("id", messageId)
        .eq("session_id", sessionId)
        .select("id");
      if (error) {
        console.error("[feedback] update by id failed:", error);
        return apiErrorResponse(error, "api/support-chat/feedback");
      }
      if (!updated || updated.length === 0) {
        // Deliberately does not distinguish "no such id" from "id belongs to
        // another session" — that difference is exactly what an enumerator wants.
        return NextResponse.json({ error: "no row found for session" }, { status: 404 });
      }
      return NextResponse.json({ success: true, target: "id", id: messageId });
    }

    // Fallback: select the most recent row for the session, then update by id.
    const { data: latest, error: selectErr } = await supabase
      .from("support_conversations")
      .select("id")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (selectErr) {
      console.error("[feedback] select latest failed:", selectErr);
      return apiErrorResponse(selectErr, "api/support-chat/feedback");
    }
    if (!latest?.id) {
      return NextResponse.json({ error: "no row found for session" }, { status: 404 });
    }

    const { error: updateErr } = await supabase
      .from("support_conversations")
      .update({ feedback: feedbackValue, ...identityPatch })
      .eq("id", latest.id)
      .eq("session_id", sessionId);
    if (updateErr) {
      console.error("[feedback] update by latest-id failed:", updateErr);
      return apiErrorResponse(updateErr, "api/support-chat/feedback");
    }

    return NextResponse.json({ success: true, target: "session_latest", id: latest.id });
  } catch (err: any) {
    return apiErrorResponse(err, "api/support-chat/feedback");
  }
}
