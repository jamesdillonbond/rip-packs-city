// app/api/profile/trophy/reorder/route.ts
//
// Reorders the authenticated user's trophy-case slots. Backs both the
// Auto-Arrange button (client sorts, then sends the new order) and drag-to-
// reorder. Body: { orderedIds: number[] } — the caller's trophy_moments row ids
// in the desired slot order (index 0 -> slot 1). The set MUST be exactly the
// caller's current trophies; the reorder_trophy_slots RPC validates this and
// rolls back on any mismatch, so a stale client can never corrupt the case.
//
// Undo is a client concern: the client keeps the previous id order and POSTs it
// back here. No separate undo endpoint is needed.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const raw = (body as { orderedIds?: unknown })?.orderedIds;
  if (!Array.isArray(raw) || raw.length === 0) {
    return NextResponse.json(
      { error: "orderedIds must be a non-empty array of row ids" },
      { status: 400 }
    );
  }
  if (raw.length > 6) {
    return NextResponse.json({ error: "at most 6 slots" }, { status: 400 });
  }

  const orderedIds: number[] = [];
  for (const v of raw) {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isInteger(n) || n <= 0) {
      return NextResponse.json(
        { error: "orderedIds must be positive integer row ids" },
        { status: 400 }
      );
    }
    orderedIds.push(n);
  }
  if (new Set(orderedIds).size !== orderedIds.length) {
    return NextResponse.json({ error: "duplicate ids" }, { status: 400 });
  }

  const { error } = await supabase.rpc("reorder_trophy_slots", {
    p_user_id: user.id,
    p_ordered_ids: orderedIds,
  });

  if (error) {
    console.error("[trophy reorder]", error);
    // A mismatch (stale client) surfaces here; 409 tells the client to refetch.
    const stale = /mismatch|not owned|duplicate/i.test(error.message || "");
    return NextResponse.json(
      { error: error.message || "reorder failed" },
      { status: stale ? 409 : 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
