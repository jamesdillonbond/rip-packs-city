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
import { apiErrorResponse } from "@/lib/api-error";
import { loadOwnCase, parseCaseId, refuseClosedChallenge } from "@/lib/trophy/cases";

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

  // Optional case scope (2026-11-06): absent = the main case. The RPC scopes
  // its delete/re-insert to this one case, so reordering a challenge entry can
  // never touch the main case's rows (or the reverse).
  const caseId = parseCaseId((body as { caseId?: unknown })?.caseId);
  if (caseId === false) {
    return NextResponse.json({ error: "caseId must be a trophy case id" }, { status: 400 });
  }
  if (caseId != null) {
    const own = await loadOwnCase(supabase, user.id, caseId);
    if (!own.ok) return apiErrorResponse(own.error, "api/profile/trophy/reorder", "Couldn't save your arrangement.");
    if (!own.case) return NextResponse.json({ error: "That trophy case doesn't exist." }, { status: 404 });
    const closed = refuseClosedChallenge(own.case);
    if (closed) return closed;
  }

  const { error } = await supabase.rpc("reorder_trophy_slots", {
    p_user_id: user.id,
    p_ordered_ids: orderedIds,
    p_case_id: caseId,
  });

  if (error) {
    console.error("[trophy reorder]", error);
    // A mismatch (stale client) surfaces here; 409 tells the client to refetch.
    // Reading the message SERVER-SIDE to make that decision is fine — what was
    // not fine is publishing it. `app/dashboard/page.tsx` throws `data.error`
    // and renders it straight into a toast, so a statement timeout was being
    // shown to the collector as the reason their arrangement did not save.
    const stale = /mismatch|not owned|duplicate/i.test(error.message || "");
    if (stale) {
      // Not a failure to hide: it is an actionable, non-driver condition, so it
      // gets copy the toast can show as-is.
      return NextResponse.json(
        { error: "Your trophy case changed on another device. Refresh and try again.", code: "conflict" },
        { status: 409 }
      );
    }
    return apiErrorResponse(error, "api/profile/trophy/reorder", "Couldn't save your arrangement.");
  }

  return NextResponse.json({ ok: true });
}
