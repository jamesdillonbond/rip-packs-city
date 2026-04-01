import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET ?ownerKey=xxx  → all 3 trophy slots for this owner
// GET ?username=xxx  → same but by username (for public profile page)
export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey");
  const username = req.nextUrl.searchParams.get("username");
  const key = ownerKey ?? username;
  if (!key) {
    return NextResponse.json({ error: "ownerKey or username required" }, { status: 400 });
  }
  const { data, error } = await supabase
    .from("trophy_moments")
    .select("*")
    .eq("owner_key", key)
    .order("slot", { ascending: true });
  if (error) {
    console.error("[trophy GET]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ trophies: data ?? [] });
}

// POST { ownerKey, slot, momentId, editionId?, playerName?, setName?,
//        serialNumber?, circulationCount?, tier?, thumbnailUrl?,
//        videoUrl?, fmv?, badges? }
// → upsert into the given slot (replaces existing)
export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    ownerKey, slot, momentId, editionId,
    playerName, setName, serialNumber, circulationCount,
    tier, thumbnailUrl, videoUrl, fmv, badges,
  } = body;

  if (!ownerKey || !slot || !momentId) {
    return NextResponse.json(
      { error: "ownerKey, slot, and momentId required" },
      { status: 400 }
    );
  }
  if (slot < 1 || slot > 3) {
    return NextResponse.json({ error: "slot must be 1, 2, or 3" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("trophy_moments")
    .upsert(
      {
        owner_key: ownerKey,
        slot,
        moment_id: momentId,
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
        pinned_at: new Date().toISOString(),
      },
      { onConflict: "owner_key,slot" }
    )
    .select()
    .single();

  if (error) {
    console.error("[trophy POST]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ trophy: data });
}

// DELETE { ownerKey, slot }  → clear that slot
export async function DELETE(req: NextRequest) {
  const body = await req.json();
  const { ownerKey, slot } = body;
  if (!ownerKey || !slot) {
    return NextResponse.json({ error: "ownerKey and slot required" }, { status: 400 });
  }
  const { error } = await supabase
    .from("trophy_moments")
    .delete()
    .eq("owner_key", ownerKey)
    .eq("slot", slot);
  if (error) {
    console.error("[trophy DELETE]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}