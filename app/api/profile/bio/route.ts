import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET ?ownerKey=xxx  → bio record
export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey") ?? req.nextUrl.searchParams.get("username");
  if (!ownerKey) return NextResponse.json({ error: "ownerKey required" }, { status: 400 });

  const { data, error } = await supabase
    .from("profile_bio")
    .select("*")
    .eq("owner_key", ownerKey)
    .single();

  if (error && error.code !== "PGRST116") {
    console.error("[bio GET]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ bio: data ?? null });
}

// POST { ownerKey, displayName?, tagline?, favoriteTeam?, twitter?, discord? }
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { ownerKey, displayName, tagline, favoriteTeam, twitter, discord } = body;
  if (!ownerKey) return NextResponse.json({ error: "ownerKey required" }, { status: 400 });

  const { data, error } = await supabase
    .from("profile_bio")
    .upsert({
      owner_key: ownerKey,
      display_name: displayName ?? null,
      tagline: tagline ?? null,
      favorite_team: favoriteTeam ?? null,
      twitter: twitter ?? null,
      discord: discord ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "owner_key" })
    .select()
    .single();

  if (error) {
    console.error("[bio POST]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ bio: data });
}