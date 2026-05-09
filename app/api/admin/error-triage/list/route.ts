import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";

// POST /api/admin/error-triage/list
// Authorization: Bearer <RPC_ADMIN_TOKEN>
// Body: { status_filter?: string }
// Thin proxy onto get_error_triage_summary(p_status_filter).

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface PostBody {
  status_filter?: string | null;
}

export async function POST(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();

  let body: PostBody = {};
  try {
    body = (await req.json().catch(() => ({}))) as PostBody;
  } catch {
    body = {};
  }

  const status_filter =
    typeof body.status_filter === "string" && body.status_filter.length > 0
      ? body.status_filter
      : null;

  const { data, error } = await supabaseAdmin.rpc("get_error_triage_summary", {
    p_status_filter: status_filter,
  });

  if (error) {
    console.log(`[error-triage/list] rpc error: ${error.message}`);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ rows: data ?? [] });
}
