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

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

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

    // Preferred path: target by primary key id (the streaming meta payload
    // includes the support_conversations row id as messageId).
    if (typeof messageId === "number" && Number.isFinite(messageId)) {
      const { error } = await supabase
        .from("support_conversations")
        .update({ feedback: feedbackValue })
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
      .update({ feedback: feedbackValue })
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
