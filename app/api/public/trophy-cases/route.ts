// app/api/public/trophy-cases/route.ts
//
// GET ?username=<u> → a collector's EXTRA trophy cases (named cases + challenge
// entries), each with its slabs, for /profile/<username>. Anon-public, same
// posture as /api/profile/trophy-slabs?username= (the main case).
//
// ⚠ A FAILED READ IS NOT "NO EXTRA CASES": it is a retryable 503 via
// apiErrorResponse, never `{ cases: [] }` at 200.
//
// ⚠ AN UNKNOWN COLLECTOR IS NOT "NO EXTRA CASES" EITHER (known-issues #237,
// 2026-11-08). get_trophy_cases_by_username returns `[]` both for a collector
// with no extra cases and for a username nobody holds, so an empty answer is
// checked against profile_bio — with the RPC's own match (case-insensitive
// equality on the trimmed name) — and a username nobody holds is a 404. Three
// states: 404 (no such collector) · 200 `cases: []` (exists, none) · 200 rows.
// The lookup runs only on the empty answer, so a collector with cases pays
// nothing extra.

import { NextRequest, NextResponse } from "next/server";
import { supabase as supabaseAnon, supabaseAdmin } from "@/lib/supabase";
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";

export const dynamic = "force-dynamic";

const CACHE = { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" };

/** `ilike` with no wildcards = the RPC's `lower(username) = lower(trim(x))`. */
function ilikeLiteral(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

export async function GET(req: NextRequest) {
  const username = req.nextUrl.searchParams.get("username")?.trim() ?? "";
  if (!username) {
    return NextResponse.json({ error: "Provide ?username=<u>" }, { status: 400 });
  }
  const client: any = supabaseAnon;
  const { data, error } = await boundedRead(
    client.rpc("get_trophy_cases_by_username", { p_username: username }),
    "api/public/trophy-cases/get_trophy_cases_by_username"
  );
  if (error) {
    console.error("[public trophy-cases]", error);
    return apiErrorResponse(error, "api/public/trophy-cases");
  }
  const cases = Array.isArray(data) ? data : [];

  if (cases.length === 0) {
    const admin: any = supabaseAdmin;
    const who = await boundedRead(
      admin.from("profile_bio").select("user_id").ilike("username", ilikeLiteral(username)).limit(1),
      "api/public/trophy-cases/profile_bio"
    );
    if (who.error) {
      // Could not tell "no such collector" from "no extra cases" — say so.
      console.error("[public trophy-cases] username lookup", who.error);
      return apiErrorResponse(who.error, "api/public/trophy-cases");
    }
    if (!Array.isArray(who.data) || who.data.length === 0) {
      return NextResponse.json({ error: "not_found" }, { status: 404, headers: CACHE });
    }
  }

  return NextResponse.json({ cases }, { headers: CACHE });
}
