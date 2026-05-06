// app/api/admin/feedback/[id]/route.ts
// PATCH — update feedback_status / admin_note / duplicate_of on a single
// support_conversations row. Bearer-auth-gated.
//
// shipped_at and updated_at are ALWAYS owned by trg_support_conv_updated_at —
// never include them in the update payload here.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

const VALID_STATUSES = new Set([
  "new",
  "reviewed",
  "in_progress",
  "shipped",
  "wontfix",
  "duplicate",
]);

const SELECT_COLUMNS = [
  "id",
  "created_at",
  "updated_at",
  "shipped_at",
  "owner_key",
  "user_wallet",
  "page_context",
  "feedback_type",
  "feedback_summary",
  "feedback_details",
  "feedback_status",
  "admin_note",
  "duplicate_of",
  "user_message",
  "bot_response",
  "session_id",
].join(",");

interface PatchBody {
  feedback_status?: string;
  admin_note?: string | null;
  duplicate_of?: number | null;
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();

  const { id: idParam } = await ctx.params;
  const idNum = Number(idParam);
  if (!Number.isFinite(idNum) || !Number.isInteger(idNum) || idNum <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};

  if (Object.prototype.hasOwnProperty.call(body, "feedback_status")) {
    const next = body.feedback_status;
    if (typeof next !== "string" || !VALID_STATUSES.has(next)) {
      return NextResponse.json(
        { error: `feedback_status must be one of: ${Array.from(VALID_STATUSES).join(", ")}` },
        { status: 400 }
      );
    }
    update.feedback_status = next;
  }

  if (Object.prototype.hasOwnProperty.call(body, "admin_note")) {
    const note = body.admin_note;
    if (note !== null && typeof note !== "string") {
      return NextResponse.json({ error: "admin_note must be a string or null" }, { status: 400 });
    }
    update.admin_note = note;
  }

  if (Object.prototype.hasOwnProperty.call(body, "duplicate_of")) {
    const dup = body.duplicate_of;
    if (dup === null) {
      update.duplicate_of = null;
    } else if (typeof dup === "number" && Number.isInteger(dup) && dup > 0) {
      update.duplicate_of = dup;
    } else {
      return NextResponse.json(
        { error: "duplicate_of must be a positive integer or null" },
        { status: 400 }
      );
    }
  }

  // When the caller is moving the row TO 'duplicate', the canonical id must
  // be supplied (either now or already on the row) and must reference an
  // existing support_conversations row.
  if (update.feedback_status === "duplicate") {
    const proposed =
      update.duplicate_of !== undefined ? update.duplicate_of : undefined;
    let canonicalId: number | null;
    if (proposed === undefined) {
      const { data: existing, error: existingErr } = await supabaseAdmin
        .from("support_conversations")
        .select("duplicate_of")
        .eq("id", idNum)
        .maybeSingle();
      if (existingErr) {
        return NextResponse.json({ error: existingErr.message }, { status: 500 });
      }
      if (!existing) {
        return NextResponse.json({ error: "Row not found" }, { status: 404 });
      }
      canonicalId = (existing.duplicate_of as number | null) ?? null;
    } else {
      canonicalId = proposed as number | null;
    }
    if (canonicalId === null) {
      return NextResponse.json(
        { error: "duplicate_of is required when feedback_status='duplicate'" },
        { status: 400 }
      );
    }
    if (canonicalId === idNum) {
      return NextResponse.json(
        { error: "duplicate_of cannot reference the same row" },
        { status: 400 }
      );
    }
    const { data: target, error: targetErr } = await supabaseAdmin
      .from("support_conversations")
      .select("id")
      .eq("id", canonicalId)
      .maybeSingle();
    if (targetErr) {
      return NextResponse.json({ error: targetErr.message }, { status: 500 });
    }
    if (!target) {
      return NextResponse.json(
        { error: `duplicate_of=${canonicalId} does not reference an existing row` },
        { status: 400 }
      );
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No updatable fields supplied" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("support_conversations")
    .update(update)
    .eq("id", idNum)
    .select(SELECT_COLUMNS)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Row not found" }, { status: 404 });
  }

  return NextResponse.json({ row: data });
}
