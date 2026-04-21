// app/api/profile/favorites/route.ts
//
// Phase 4: favorite collections (news-feed feeder). Users can star from the
// published collections; starred entries power the News Feed widget on /profile.
//   GET    — list favorited collections (just collection_ids)
//   POST   { collectionId } — favorite
//   DELETE { collectionId } — unfavorite

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const { data, error } = await supabase
    .from("collection_preferences")
    .select("collection_id, favorited, created_at")
    .eq("user_id", user.id)
    .eq("favorited", true)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[favorites GET]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ favorites: data ?? [] });
}

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const body = await req.json();
  const { collectionId } = body;
  if (!collectionId) {
    return NextResponse.json({ error: "collectionId required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("collection_preferences")
    .upsert(
      { user_id: user.id, collection_id: collectionId, favorited: true },
      { onConflict: "user_id,collection_id" }
    )
    .select()
    .single();

  if (error) {
    console.error("[favorites POST]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ favorite: data });
}

export async function DELETE(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const body = await req.json();
  const { collectionId } = body;
  if (!collectionId) {
    return NextResponse.json({ error: "collectionId required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("collection_preferences")
    .delete()
    .eq("user_id", user.id)
    .eq("collection_id", collectionId);

  if (error) {
    console.error("[favorites DELETE]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
