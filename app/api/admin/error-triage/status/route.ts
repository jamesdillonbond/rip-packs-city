import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";

// POST /api/admin/error-triage/status
// Authorization: Bearer <RPC_ADMIN_TOKEN>
// Body: { signature, status, fix_action?, resolution_notes?, resolved_by? }
// Thin proxy onto set_error_triage_status(p_signature, p_status, p_fix_action,
// p_resolution_notes, p_resolved_by).

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const VALID_STATUSES = new Set([
  "open",
  "auto_fixable",
  "fixed",
  "needs_trevor",
  "wontfix",
  "duplicate",
]);

const VALID_RESOLVED_BY = new Set(["claude", "trevor", "auto"]);

interface PostBody {
  signature?: string;
  status?: string;
  fix_action?: string | null;
  resolution_notes?: string | null;
  resolved_by?: string | null;
}

export async function POST(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();

  let body: PostBody = {};
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const signature = typeof body.signature === "string" ? body.signature.trim() : "";
  if (!signature) {
    return NextResponse.json({ error: "signature required" }, { status: 400 });
  }

  const status = typeof body.status === "string" ? body.status.trim() : "";
  if (!VALID_STATUSES.has(status)) {
    return NextResponse.json(
      { error: `status must be one of: ${[...VALID_STATUSES].join(", ")}` },
      { status: 400 }
    );
  }

  const fix_action =
    typeof body.fix_action === "string" && body.fix_action.length > 0
      ? body.fix_action
      : null;
  const resolution_notes =
    typeof body.resolution_notes === "string" && body.resolution_notes.length > 0
      ? body.resolution_notes
      : null;

  let resolved_by: string | null = null;
  if (typeof body.resolved_by === "string" && body.resolved_by.length > 0) {
    if (!VALID_RESOLVED_BY.has(body.resolved_by)) {
      return NextResponse.json(
        { error: `resolved_by must be one of: ${[...VALID_RESOLVED_BY].join(", ")}` },
        { status: 400 }
      );
    }
    resolved_by = body.resolved_by;
  }

  const { data, error } = await supabaseAdmin.rpc("set_error_triage_status", {
    p_signature: signature,
    p_status: status,
    p_fix_action: fix_action,
    p_resolution_notes: resolution_notes,
    p_resolved_by: resolved_by,
  });

  if (error) {
    console.log(`[error-triage/status] rpc error: ${error.message}`);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, result: data ?? null });
}
