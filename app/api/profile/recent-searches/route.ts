import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

const VALID_TYPES = ["wallet", "moment", "edition", "player", "set"];

function inferType(query: string): string {
  if (/^0x[0-9a-fA-F]{16}$/.test(query)) return "wallet";
  if (/^[a-z0-9_]+$/.test(query)) return "wallet";
  if (/S\d+$/i.test(query)) return "edition";
  return "player";
}

export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey");
  if (!ownerKey) {
    return NextResponse.json({ error: "ownerKey required" }, { status: 400 });
  }
  const { data, error } = await supabase
    .from("recent_searches")
    .select("*")
    .eq("owner_key", ownerKey)
    .order("searched_at", { ascending: false })
    .limit(20);
  if (error) {
    console.error("[recent-searches GET]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ searches: data ?? [] });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { ownerKey, query, queryType } = body;
  if (!ownerKey || !query) {
    return NextResponse.json({ error: "ownerKey and query required" }, { status: 400 });
  }
  const resolvedType = VALID_TYPES.includes(queryType) ? queryType : inferType(query);

  await supabase
    .from("recent_searches")
    .delete()
    .eq("owner_key", ownerKey)
    .eq("query", query);

  const { data, error } = await supabase
    .from("recent_searches")
    .insert({
      owner_key: ownerKey,
      query,
      query_type: resolvedType,
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