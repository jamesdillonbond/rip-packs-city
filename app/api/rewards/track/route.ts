// app/api/rewards/track/route.ts
//
// POST { event } — the ONLY client-triggerable earn. Used for engagement earns
// that fire from a public/read surface (e.g. viewing the squeeze board) where
// there's no server-side write to hang an award off of.
//
// SECURITY: the body NEVER carries an action_key or a points amount. The client
// sends only a fixed `event` string, which is mapped here — server-side —
// against a hardcoded allowlist to a capped earn rule. Anything not in the
// allowlist is rejected. The user id is session-resolved (requireUser →
// auth.uid()), and every mapped rule is daily-capped in the DB, so even though
// the client triggers it, the earn is tightly bounded.

import { NextRequest, NextResponse } from "next/server";
import { awardPoints } from "@/lib/rewards";
import { requireUser } from "@/lib/auth/supabase-server";

export const dynamic = "force-dynamic";

// event (client-supplied, fixed string) → action_key (capped points_rules row).
// Keep this list tight; never accept an arbitrary action_key from the body.
const EVENT_TO_ACTION: Record<string, string> = {
  view_squeeze: "view_squeeze_board",
  share_profile: "share_profile",
};

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  let body: { event?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const event = String(body?.event ?? "");
  const actionKey = EVENT_TO_ACTION[event];
  if (!actionKey) {
    return NextResponse.json({ error: "unknown_event" }, { status: 400 });
  }

  // Capped/cooldowned server-side — repeat calls are harmless no-ops.
  const result = await awardPoints(user.id, actionKey);
  return NextResponse.json({ ok: true, awarded: result?.awarded ?? false });
}
