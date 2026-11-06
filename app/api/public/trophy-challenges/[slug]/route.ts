// app/api/public/trophy-challenges/[slug]/route.ts
//
// GET → { challenge, entry_count, entries: [{ username, slabs, ... }] } for a
// trophy challenge board. Unknown slug → 404. A failed read → 503 (never an
// empty board: "no entries yet" is a claim about the challenge).

import { NextRequest, NextResponse } from "next/server";
import { supabase as supabaseAnon } from "@/lib/supabase";
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const client: any = supabaseAnon;
  const { data, error } = await boundedRead(
    client.rpc("get_trophy_challenge_entries", { p_slug: slug, p_limit: 48 }),
    "api/public/trophy-challenges/get_trophy_challenge_entries"
  );
  if (error) {
    console.error("[public trophy-challenges]", error);
    return apiErrorResponse(error, "api/public/trophy-challenges");
  }
  if (data == null) return NextResponse.json({ error: "No such challenge" }, { status: 404 });
  return NextResponse.json(data, {
    headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" },
  });
}
