// app/api/search-editions/route.ts
//
// Lightweight edition search for the alert-create modal. Cookie-auth gated.
// Searches by player_name, set_name, or exact external_id (the edition_key).
// Returns {edition_id, edition_key, player_name, set_name}.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 2) {
    return NextResponse.json({ ok: true, editions: [] });
  }

  const limitRaw = Number(req.nextUrl.searchParams.get("limit") ?? 20);
  const limit = Math.max(1, Math.min(50, isNaN(limitRaw) ? 20 : Math.floor(limitRaw)));

  const like = `%${q}%`;
  const { data, error } = await (supabaseAdmin as any)
    .from("editions")
    .select("id, external_id, player_name, set_name, collection_id")
    .or(`player_name.ilike.${like},set_name.ilike.${like},external_id.ilike.${like}`)
    .not("external_id", "is", null)
    .order("player_name", { ascending: true })
    .limit(limit);

  if (error) {
    console.log(`[search-editions] err: ${error.message}`);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const editions = (data ?? []).map((row: any) => ({
    edition_id: row.id,
    edition_key: row.external_id,
    player_name: row.player_name,
    set_name: row.set_name,
    collection_id: row.collection_id,
  }));

  return NextResponse.json({ ok: true, editions });
}
