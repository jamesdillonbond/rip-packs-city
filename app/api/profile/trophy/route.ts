// app/api/profile/trophy/route.ts
//
// Phase 4: auth.uid()-keyed trophy moments. Supports up to 6 pinned slots
// across all published collections. The collection_id defaults to NBA Top
// Shot when not supplied, so older clients still work.
//
// Public /profile/[username] lookups go through /api/public/profile/[username]
// (service-role read). This handler is strictly authenticated.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";

const NBA_TOP_SHOT_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const { data, error } = await supabase
    .from("trophy_moments")
    .select("*")
    .eq("user_id", user.id)
    .order("slot", { ascending: true });

  if (error) {
    console.error("[trophy GET]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ trophies: data ?? [] });
}

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const body = await req.json();
  const {
    slot,
    momentId,
    collectionId,
    editionId,
    playerName,
    setName,
    serialNumber,
    circulationCount,
    tier,
    thumbnailUrl,
    videoUrl,
    fmv,
    badges,
    note,
  } = body;

  if (!slot || !momentId) {
    return NextResponse.json(
      { error: "slot and momentId required" },
      { status: 400 }
    );
  }
  if (slot < 1 || slot > 6) {
    return NextResponse.json({ error: "slot must be between 1 and 6" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("trophy_moments")
    .upsert(
      {
        user_id: user.id,
        slot,
        moment_id: momentId,
        collection_id: collectionId ?? NBA_TOP_SHOT_UUID,
        edition_id: editionId ?? null,
        player_name: playerName ?? null,
        set_name: setName ?? null,
        serial_number: serialNumber ?? null,
        circulation_count: circulationCount ?? null,
        tier: tier ?? null,
        thumbnail_url: thumbnailUrl ?? null,
        video_url: videoUrl ?? null,
        fmv: fmv ?? null,
        badges: badges ?? null,
        note: note ?? null,
        pinned_at: new Date().toISOString(),
      },
      { onConflict: "user_id,slot" }
    )
    .select()
    .single();

  if (error) {
    console.error("[trophy POST]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ trophy: data });
}

export async function DELETE(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const body = await req.json();
  const { slot } = body;
  if (!slot) {
    return NextResponse.json({ error: "slot required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("trophy_moments")
    .delete()
    .eq("user_id", user.id)
    .eq("slot", slot);

  if (error) {
    console.error("[trophy DELETE]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
