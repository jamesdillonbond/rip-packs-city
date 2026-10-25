// app/api/admin/visitor-journeys/route.ts
//
// GET /api/admin/visitor-journeys?hours=24
// Authorization: Bearer <RPC_ADMIN_TOKEN | INGEST_SECRET_TOKEN>
//
// Backs /admin/visitor-journeys (2026-10-03): one timeline per HUMAN visit,
// joining page views (usage_events.metadata.sid), funnel events, outbound
// clicks and concierge chats (support_conversations.visit_session_id), plus
// returning-visitor and AI-assistant referral counts. All of it is computed by
// public.admin_visitor_journeys (service-role only; pinned in
// supabase/tests/admin_visitor_journeys.sql).
//
// ⚠ A failed read FAILS the request. A board of zero sessions is a claim that
// nobody visited; it must never be what an RPC error renders as.

import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/auth/bearer-secret";
import { supabaseAdmin } from "@/lib/supabase";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

function isAuthorized(req: NextRequest): boolean {
  // Constant-time, fail-closed (lib/auth/bearer-secret.ts; security audit 2026-10-25, R134 step 1).
  return bearerMatches(req.headers.get("authorization"), "INGEST_SECRET_TOKEN", "RPC_ADMIN_TOKEN");
}

/** 1..168 hours; anything unparseable is the 24 h default, never a 0-hour window. */
export function parseHours(raw: string | null): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return 24;
  return Math.min(168, Math.max(1, Math.round(n)));
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const hours = parseHours(req.nextUrl.searchParams.get("hours"));
  try {
    const { data, error } = await (supabaseAdmin as any).rpc("admin_visitor_journeys", {
      p_hours: hours,
      p_max_sessions: 150,
    });
    if (error) throw new Error(`admin_visitor_journeys: ${error.message}`);
    if (!data || typeof data !== "object" || !Array.isArray((data as any).sessions)) {
      throw new Error("admin_visitor_journeys returned no payload");
    }
    return NextResponse.json(data);
  } catch (err) {
    // Operator-secret-gated route: the driver message is the diagnostic.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[admin/visitor-journeys]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
