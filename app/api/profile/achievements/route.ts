import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { requireOwnedKey } from "@/lib/auth/owner-key-guard";
import { apiErrorResponse } from "@/lib/api-error";

const supabase = supabaseAdmin as any;

export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey");
  if (!ownerKey) {
    return NextResponse.json({ error: "ownerKey required" }, { status: 400 });
  }
  try {
    const { data, error } = await supabase
      .from("profile_achievements")
      .select("achievement_key, tier, progress, unlocked_at")
      .eq("owner_key", ownerKey)
      .order("unlocked_at", { ascending: true });
    // ⚠ A failed read must NOT return `{achievements: []}` at 200 (deep-audit
    // R13). That is byte-identical to "you have unlocked nothing", so a
    // database outage silently erased a collector's achievements from their own
    // profile — and it was invisible to BOTH driver-message leak guards,
    // because swallowing the message entirely leaks nothing to find.
    if (error) {
      return apiErrorResponse(error, "api/profile/achievements GET");
    }
    return NextResponse.json({ achievements: data ?? [] });
  } catch (err: any) {
    return apiErrorResponse(err, "api/profile/achievements GET");
  }
}

// NOTE: this GET deliberately has NO ownership check. `profile_achievements`
// carries an explicit `"public read achievements"` RLS policy
// (roles={public}, qual=true), so these rows are already anon-readable
// directly — adding a gate here would imply a privacy property the table does
// not have. The WRITE path below is the one that needed fixing.

export async function POST(req: NextRequest) {
  const token = process.env.INGEST_SECRET_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "Server misconfigured: INGEST_SECRET_TOKEN not set" },
      { status: 500 }
    );
  }
  try {
    const body = await req.json().catch(() => ({}));
    const ownerKey: string | undefined = body?.ownerKey;
    if (!ownerKey) {
      return NextResponse.json({ triggered: false, error: "ownerKey required" }, { status: 400 });
    }

    // ⚠ CONFUSED DEPUTY, fixed (deep-audit R13). This handler took `ownerKey`
    // straight from the request BODY and then called the edge function with the
    // SERVER's INGEST_SECRET_TOKEN — so any caller could make RPC recompute (and
    // write) achievements for an arbitrary owner_key using our own operator
    // credential. Every sibling /api/profile/** writer carries this guard; this
    // one was missed. It fails closed on 401 / 403 / any resolution error.
    const gate = await requireOwnedKey(ownerKey);
    if (gate instanceof Response) return gate;
    const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
    const r = await fetch(`${url}/functions/v1/compute-achievements`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ owner_key: ownerKey }),
    });
    const result = await r.json().catch(() => ({}));
    if (!r.ok) {
      return NextResponse.json({ triggered: false, error: result?.error ?? `status ${r.status}` });
    }
    return NextResponse.json({ triggered: true, result });
  } catch (err: any) {
    // ⚠ TWO defects in one line. It leaked `err.message` (the /api/sets shape), and it
    // returned HTTP 200 for a FAILED recompute — so any consumer checking `r.ok` read
    // "succeeded, nothing triggered". The GET paths above already use the helper.
    return apiErrorResponse(err, "api/profile/achievements POST");
  }
}
