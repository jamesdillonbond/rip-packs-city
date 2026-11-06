// app/api/public/trophy-cases/route.ts
//
// GET ?username=<u> → a collector's EXTRA trophy cases (named cases + challenge
// entries), each with its slabs, for /profile/<username>. Anon-public, same
// posture as /api/profile/trophy-slabs?username= (the main case).
//
// ⚠ A FAILED READ IS NOT "NO EXTRA CASES": it is a retryable 503 via
// apiErrorResponse, never `{ cases: [] }` at 200.

import { NextRequest, NextResponse } from "next/server";
import { supabase as supabaseAnon } from "@/lib/supabase";
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";

export const dynamic = "force-dynamic";

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
  return NextResponse.json(
    { cases: Array.isArray(data) ? data : [] },
    { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } }
  );
}
