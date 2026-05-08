// app/api/profile/hero-moment/route.ts
//
// Returns the user's Hero Moment via the get_user_hero_moment RPC, which
// honors a manual override on profile_bio (hero_moment_id +
// hero_moment_collection_id) and otherwise falls back to the highest-FMV
// owned moment across the user's saved wallets.
//
// Resolution order for the user_id:
//   1. ?ownerKey=<wallet_addr | username> query param (when supplied)
//   2. Authenticated session (requireUser fallback)
//   3. X-RPC-Smoke-Test header (constant-time-matched against
//      SMOKE_TEST_SESSION_TOKEN) → returns a synthetic stub hero so the
//      smoke harness verifies route shape, not just the 401 fall-through.
//      Mirrors the pattern in /api/support-chat.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";
import { COLLECTIONS } from "@/lib/collections";

function isSmokeTestRequest(req: NextRequest): boolean {
  const presented = req.headers.get("x-rpc-smoke-test");
  const expected = process.env.SMOKE_TEST_SESSION_TOKEN;
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { timingSafeEqual } = require("node:crypto") as typeof import("node:crypto");
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

const SMOKE_TEST_HERO = {
  hero: {
    momentId: "smoke-test-stub",
    playerName: "Smoke Test Player",
    setName: "Smoke Test Set",
    tier: "COMMON",
    serialNumber: 1,
    mintCount: 100,
    imageUrl: null,
    editionKey: "smoke:1",
    fmvUsd: 1,
    isLocked: false,
    isManualOverride: false,
    collectionId: "nba-top-shot",
    collectionUuid: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
    collectionLabel: "NBA Top Shot",
    collectionAccent: "#E03A2F",
    isSmokeTestStub: true,
  },
} as const;

async function resolveUserId(ownerKey: string | null): Promise<string | null> {
  if (ownerKey) {
    const key = ownerKey.trim();
    if (key.startsWith("0x")) {
      const { data } = await supabase
        .from("saved_wallets")
        .select("user_id")
        .eq("wallet_addr", key.toLowerCase())
        .limit(1)
        .maybeSingle();
      if (data?.user_id) return data.user_id as string;
    }
    const { data: bio } = await supabase
      .from("profile_bio")
      .select("user_id")
      .eq("username", key)
      .maybeSingle();
    if (bio?.user_id) return bio.user_id as string;
  }
  const user = await getCurrentUser();
  return user?.id ?? null;
}

export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey");
  const userId = await resolveUserId(ownerKey);
  if (!userId) {
    if (isSmokeTestRequest(req)) {
      return NextResponse.json(SMOKE_TEST_HERO);
    }
    return NextResponse.json({ hero: null, reason: "no_user" }, { status: 401 });
  }

  const { data, error } = await supabase.rpc("get_user_hero_moment", {
    p_user_id: userId,
  });

  if (error) {
    console.error("[profile/hero-moment]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return NextResponse.json({ hero: null, reason: "no_moments" });
  }

  const fmv = Number(row.fmv_usd);
  if (!Number.isFinite(fmv) || fmv <= 0) {
    return NextResponse.json({
      hero: null,
      reason: row.is_manual_override ? "manual_no_fmv" : "no_fmv",
    });
  }

  const coll = COLLECTIONS.find((c) => c.supabaseCollectionId === row.collection_id);

  return NextResponse.json({
    hero: {
      momentId: row.moment_id,
      playerName: row.player_name,
      setName: row.set_name,
      tier: row.tier,
      serialNumber: row.serial_number,
      mintCount: row.mint_count,
      imageUrl: row.image_url,
      editionKey: row.edition_key,
      fmvUsd: fmv,
      isLocked: !!row.is_locked,
      isManualOverride: !!row.is_manual_override,
      collectionId: coll?.id ?? null,
      collectionUuid: row.collection_id ?? null,
      collectionLabel: coll?.label ?? null,
      collectionAccent: coll?.accent ?? null,
    },
  });
}
