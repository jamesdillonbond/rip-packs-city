import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";

// POST /api/admin/error-triage/instances
// Authorization: Bearer <RPC_ADMIN_TOKEN>
// Body: { signature: string, limit?: number }
// Thin proxy onto get_error_triage_instances(p_signature, p_limit).

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface PostBody {
  signature?: string;
  limit?: number;
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

  const rawLimit = typeof body.limit === "number" ? Math.floor(body.limit) : 20;
  const limit = Math.min(Math.max(rawLimit, 1), 200);

  const { data, error } = await supabaseAdmin.rpc("get_error_triage_instances", {
    p_signature: signature,
    p_limit: limit,
  });

  if (error) {
    console.log(`[error-triage/instances] rpc error: ${error.message}`);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // RPC returns JSONB: { found, source, pipeline?, instances: [...] }
  // Pass through unchanged.
  return NextResponse.json(data ?? { found: 0, source: null, instances: [] });
}
