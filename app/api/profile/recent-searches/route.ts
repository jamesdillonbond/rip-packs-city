// app/api/profile/recent-searches/route.ts
//
// Phase 4: auth.uid()-keyed recent searches. Optional collection_id scope.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";

const VALID_TYPES = ["wallet", "moment", "edition", "player", "set"];
const NBA_TOP_SHOT_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";

function inferType(query: string): string {
  if (/^0x[0-9a-fA-F]{16}$/.test(query)) return "wallet";
  if (/^[a-z0-9_]+$/.test(query)) return "wallet";
  if (/S\d+$/i.test(query)) return "edition";
  return "player";
}

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const { data, error } = await supabase
    .from("recent_searches")
    .select("*")
    .eq("user_id", user.id)
    .order("searched_at", { ascending: false })
    .limit(20);

  if (error) {
    console.error("[recent-searches GET]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ searches: data ?? [] });
}

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const body = await req.json();
  const { query, queryType, collectionId } = body;
  if (!query) {
    return NextResponse.json({ error: "query required" }, { status: 400 });
  }
  const resolvedType = VALID_TYPES.includes(queryType) ? queryType : inferType(query);

  await supabase
    .from("recent_searches")
    .delete()
    .eq("user_id", user.id)
    .eq("query", query);

  const { data, error } = await supabase
    .from("recent_searches")
    .insert({
      user_id: user.id,
      query,
      query_type: resolvedType,
      collection_id: collectionId ?? NBA_TOP_SHOT_UUID,
      searched_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    console.error("[recent-searches POST]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ search: data });
}
