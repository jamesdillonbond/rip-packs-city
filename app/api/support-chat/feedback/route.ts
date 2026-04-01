// app/api/support-chat/feedback/route.ts
// POST /api/support-chat/feedback
// Body: { sessionId, rating: "up" | "down", comment? }

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const { sessionId, rating, comment } = await req.json();

    if (!sessionId || !rating) {
      return NextResponse.json({ error: "sessionId and rating required" }, { status: 400 });
    }

    const feedbackValue = `${rating}${comment ? `: ${comment}` : ""}`;

    const { error } = await supabase
      .from("support_conversations")
      .update({ feedback: feedbackValue })
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) {
      console.error("[feedback] Supabase error:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
