import { NextRequest, NextResponse } from "next/server";

/* ------------------------------------------------------------------ */
/*  POST /api/support-chat/feedback                                    */
/*  Body: { messageId, sessionId, feedback: "up" | "down" }           */
/* ------------------------------------------------------------------ */

import { createClient } from "@supabase/supabase-js";
const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const { messageId, sessionId, feedback } = await req.json();

    if (!sessionId || !feedback || !["up", "down"].includes(feedback)) {
      return NextResponse.json(
        { error: "sessionId and feedback ('up'|'down') required" },
        { status: 400 }
      );
    }

    // Update the most recent bot response in this session
    // messageId is the numeric Supabase id if available, otherwise update latest
    if (messageId) {
      await supabase
        .from("support_conversations")
        .update({ feedback })
        .eq("id", messageId)
        .eq("session_id", sessionId);
    } else {
      // Fallback: update the most recent message in this session
      const { data } = await supabase
        .from("support_conversations")
        .select("id")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: false })
        .limit(1);

      if (data && data.length > 0) {
        await supabase
          .from("support_conversations")
          .update({ feedback })
          .eq("id", data[0].id);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("Feedback error:", err?.message || err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
