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

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseServer } from "@/lib/auth/supabase-server";

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
    if (!messageId && !sessionId) {
      return NextResponse.json({ error: "messageId or sessionId required" }, { status: 400 });
    }

    const feedbackValue = `${feedback}${comment ? `: ${comment}` : ""}`;
    const identity = await deriveIdentity();
    // Only backfill identity columns when the cookie carries an authed user.
    // Anonymous feedback writes (rare — proxy.ts gates everything but defensive)
    // leave existing values untouched.
    const identityPatch: Record<string, string> = {};
    if (identity.email) identityPatch.user_email = identity.email;
    if (identity.ownerKey) identityPatch.owner_key = identity.ownerKey;
    if (identity.userWallet) identityPatch.user_wallet = identity.userWallet;

    // Preferred path: target by primary key id (the streaming meta payload
    // includes the support_conversations row id as messageId).
    if (typeof messageId === "number" && Number.isFinite(messageId)) {
      const { error } = await supabase
        .from("support_conversations")
        .update({ feedback: feedbackValue, ...identityPatch })
        .eq("id", messageId);
      if (error) {
        console.error("[feedback] update by id failed:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
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
      return NextResponse.json({ error: selectErr.message }, { status: 500 });
    }
    if (!latest?.id) {
      return NextResponse.json({ error: "no row found for session" }, { status: 404 });
    }

    const { error: updateErr } = await supabase
      .from("support_conversations")
      .update({ feedback: feedbackValue, ...identityPatch })
      .eq("id", latest.id);
    if (updateErr) {
      console.error("[feedback] update by latest-id failed:", updateErr);
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, target: "session_latest", id: latest.id });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
