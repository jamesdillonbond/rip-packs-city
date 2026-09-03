// app/api/profile/trophy/route.ts
//
// Phase 4: auth.uid()-keyed trophy moments. Supports up to 6 pinned slots
// across all published collections. The collection_id defaults to NBA Top
// Shot when not supplied, so older clients still work.
//
// Public /profile/[username] lookups go through /api/public/profile/[username]
// (service-role read). This handler is strictly authenticated.

import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-error";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";
import { sanitizeTrophyThumbnail } from "@/lib/profile/trophy-thumbnail";

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
    return apiErrorResponse(error, "api/profile/trophy");
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

  const resolvedCollectionId = collectionId ?? NBA_TOP_SHOT_UUID;

  // ── What the CLIENT may assert, and what it may not ───────────────────────
  //
  // Most display fields here are harmless because `get_trophy_slab_data` renders
  // public slabs with `COALESCE(e.<field>, tm.<field>)` — the live `editions`
  // row WINS, so a forged player/tier/FMV/badge is overridden as soon as the
  // edition resolves. Two stored fields are NOT coalesced and go out as-is:
  // `serial_number` and `thumbnail_url`. Those are the ones handled below.
  //
  // ⚠ Re-derive that COALESCE before trusting this comment — it is the whole
  // reason this fix is two fields rather than the twelve a reading of this
  // handler alone would suggest.
  //
  // SERIAL: resolved from the user-independent moment index when we have it.
  // A serial is a claim about a specific NFT ("#1 of 15,000" is the trophy), and
  // it was taken from the request body. Every moment the picker offers is in
  // wallet_moments_cache, so this closes the forge for the real path; a manual
  // pin of a moment we have never indexed keeps the submitted value rather than
  // losing it, which is the status quo and not a regression.
  let verifiedSerial: number | null = null;
  try {
    const { data: wmcRow } = await supabase
      .from("wallet_moments_cache")
      .select("serial_number")
      .eq("moment_id", momentId)
      .eq("collection_id", resolvedCollectionId)
      .not("serial_number", "is", null)
      .limit(1)
      .maybeSingle();
    if (wmcRow && typeof wmcRow.serial_number === "number") {
      verifiedSerial = wmcRow.serial_number;
    }
  } catch (err) {
    // A failed lookup must not upgrade the client's claim to "verified", and
    // must not block the pin either. Fall through to the submitted value.
    console.error("[trophy POST] serial verify failed:", err instanceof Error ? err.message : err);
  }

  const { data, error } = await supabase
    .from("trophy_moments")
    .upsert(
      {
        user_id: user.id,
        slot,
        moment_id: momentId,
        collection_id: resolvedCollectionId,
        edition_id: editionId ?? null,
        player_name: playerName ?? null,
        set_name: setName ?? null,
        serial_number: verifiedSerial ?? serialNumber ?? null,
        circulation_count: circulationCount ?? null,
        tier: tier ?? null,
        // ART: allowlisted. This URL is rendered on a public profile AND fetched
        // SERVER-SIDE by /api/og/profile/[username], which inlines trophy art as
        // data URIs — so an arbitrary value is both an arbitrary image on
        // someone's public page and a server-side fetch of a host they chose.
        // Rejected values become null and the slab falls back, rather than 400ing
        // a pin that is otherwise fine.
        thumbnail_url: sanitizeTrophyThumbnail(thumbnailUrl),
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
    return apiErrorResponse(error, "api/profile/trophy");
  }
  return NextResponse.json({ trophy: data });
}

/** Longest caption the slab can render without clipping. */
export const MAX_NOTE_LEN = 90;

/**
 * PATCH — edit the caption on an ALREADY-PINNED slot.
 *
 * `note` is the only field on a trophy the collector authors themselves; every
 * other column is denormalized moment metadata. It has been writable by POST,
 * stored, returned by the slab RPC and rendered in the trophy-case PDF since
 * the feature shipped — and no UI ever set it, so all 16 pinned trophies in
 * production carry a null note. This is the missing write path.
 *
 * ⚠ It is a PATCH and not a reuse of POST for a load-bearing reason: POST
 * UPSERTS THE WHOLE ROW. A client that sent `{slot, momentId, note}` to add a
 * caption would blank the player name, tier, art and FMV of the trophy it was
 * captioning. A partial write needs a partial verb.
 *
 * ⚠ It also updates, never inserts. `upsert` here would let a caption on an
 * empty slot conjure a trophy with no moment behind it — a row the slab
 * renderer has no way to draw. A caption for a slot that holds nothing is a
 * 404, which is the truth.
 */
export async function PATCH(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const body = await req.json().catch(() => null);
  const slot = Number(body?.slot);
  const rawNote = body?.note;

  if (!Number.isInteger(slot) || slot < 1 || slot > 6) {
    return NextResponse.json({ error: "slot must be between 1 and 6" }, { status: 400 });
  }
  if (rawNote != null && typeof rawNote !== "string") {
    return NextResponse.json({ error: "note must be a string or null" }, { status: 400 });
  }

  // Collapse whitespace so a caption of spaces/newlines cannot pass the length
  // check and then render as a blank line under the slab, and so the emptied
  // case round-trips to NULL rather than "" (the slab branches on presence).
  const trimmed = typeof rawNote === "string" ? rawNote.replace(/\s+/g, " ").trim() : "";
  if (trimmed.length > MAX_NOTE_LEN) {
    return NextResponse.json(
      { error: `note must be ${MAX_NOTE_LEN} characters or fewer` },
      { status: 400 }
    );
  }
  const note = trimmed.length > 0 ? trimmed : null;

  const { data, error } = await supabase
    .from("trophy_moments")
    .update({ note })
    .eq("user_id", user.id)
    .eq("slot", slot)
    .select()
    .maybeSingle();

  if (error) {
    console.error("[trophy PATCH]", error);
    return apiErrorResponse(error, "api/profile/trophy");
  }
  if (!data) {
    return NextResponse.json({ error: "No trophy pinned in that slot" }, { status: 404 });
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
    return apiErrorResponse(error, "api/profile/trophy");
  }
  return NextResponse.json({ ok: true });
}
