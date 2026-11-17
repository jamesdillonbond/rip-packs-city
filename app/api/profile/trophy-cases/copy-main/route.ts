// app/api/profile/trophy-cases/copy-main/route.ts
//
// POST { caseId } → copy the owner's MAIN-case pins into one of their CHALLENGE
// entries (2026-11-07). WHY: the first real Dame Time entrant outside the team
// (peanpean) pinned six Damian Lillard pieces into his MAIN case and never
// entered the challenge — the main case heads the Trophy tab and the challenge
// row sits under it. The dashboard now offers "Enter with my N Dame pieces";
// this is what that button calls (right after creating the entry).
//
// ⚠ EVERY COPIED PIN PASSES THE SAME GATE AS A HAND PIN: the challenge must be
// open, a Panini card must still resolve as held under a linked username, and
// `checkChallengePin` must say eligible (collection, player, ownership). A pin
// that fails is SKIPPED with its reason — never copied on the strength of
// having been in the main case. A check that could not RUN is a 503, never a
// silent skip that would read as "not eligible".
// ⚠ Fills only EMPTY slots, in the main case's order, and never duplicates a
// piece already in the entry. The main case is not touched.
// ⚠ `copied` counts rows the insert RETURNED, not rows attempted.

import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-error";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";
import { boundedRead } from "@/lib/api/bounded-read";
import { warmCardsLater } from "@/lib/og/card-warm";
import { loadOwnCase, parseCaseId, refuseClosedChallenge } from "@/lib/trophy/cases";
import { checkChallengePin, parseChallengeRules } from "@/lib/trophy/challenge-rules";
import { resolvePaniniTrophyCard } from "@/lib/trophy/panini-card";
import { PANINI_COLLECTION_ID } from "@/lib/trophy/slab-href";

export const dynamic = "force-dynamic";

const ROUTE = "api/profile/trophy-cases/copy-main";

/** Columns a pin carries that are copied verbatim (the moment's metadata + the owner's caption). */
const COPIED = [
  "moment_id",
  "collection_id",
  "edition_id",
  "player_name",
  "set_name",
  "serial_number",
  "circulation_count",
  "tier",
  "thumbnail_url",
  "video_url",
  "fmv",
  "badges",
  "note",
] as const;

type Pin = Record<(typeof COPIED)[number] | "slot", any>;

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const body = await req.json().catch(() => null);
  const caseId = parseCaseId(body?.caseId);
  if (!caseId) return NextResponse.json({ error: "caseId must be a trophy case id" }, { status: 400 });

  const own = await loadOwnCase(supabase, user.id, caseId);
  if (!own.ok) return apiErrorResponse(own.error, ROUTE);
  if (!own.case) return NextResponse.json({ error: "That trophy case doesn't exist." }, { status: 404 });
  const challenge = own.case.challenge;
  if (!challenge) {
    return NextResponse.json({ error: "Only a challenge entry can be filled from your main case." }, { status: 400 });
  }
  const closed = refuseClosedChallenge(own.case);
  if (closed) return closed;

  // Bounded: a hung read must still reach the honest error below, not a 504.
  const [mainRes, caseRes] = await Promise.all([
    boundedRead(
      supabase
        .from("trophy_moments")
        .select(["slot", ...COPIED].join(", "))
        .eq("user_id", user.id)
        .is("case_id", null)
        .order("slot", { ascending: true }),
      `${ROUTE}/main`
    ),
    boundedRead(
      supabase.from("trophy_moments").select("slot, moment_id, collection_id").eq("user_id", user.id).eq("case_id", caseId),
      `${ROUTE}/entry`
    ),
  ]);
  if (mainRes.error) return apiErrorResponse(mainRes.error, ROUTE);
  if (caseRes.error) return apiErrorResponse(caseRes.error, ROUTE);

  const inCase = (caseRes.data ?? []) as unknown as { slot: number; moment_id: string; collection_id: string }[];
  const held = new Set(inCase.map((p) => `${p.collection_id}:${p.moment_id}`));
  const free = [1, 2, 3, 4, 5, 6].filter((s) => !inCase.some((p) => p.slot === s));
  const rules = parseChallengeRules(challenge.rules);

  const rows: Record<string, unknown>[] = [];
  const skipped: { slot: number; player_name: string | null; reason: string }[] = [];
  for (const pin of (mainRes.data ?? []) as unknown as Pin[]) {
    if (held.has(`${pin.collection_id}:${pin.moment_id}`)) continue; // already in the entry
    if (rows.length >= free.length) break; // entry is full

    let paniniPlayerName: string | null = null;
    if (pin.collection_id === PANINI_COLLECTION_ID) {
      const res = await resolvePaniniTrophyCard(supabase, user.id, String(pin.moment_id));
      if (!res.ok) return apiErrorResponse(res.error, ROUTE, "Couldn't verify your Panini cards right now — try again in a moment.");
      if (!res.card) {
        skipped.push({ slot: pin.slot, player_name: pin.player_name, reason: "That card isn't under a Panini username linked to your profile." });
        continue;
      }
      paniniPlayerName = res.card.playerName;
    }

    const check = await checkChallengePin(supabase, rules, challenge.title, {
      userId: user.id,
      momentId: String(pin.moment_id),
      collectionId: String(pin.collection_id),
      paniniPlayerName,
    });
    if (check.kind === "unchecked") {
      return apiErrorResponse(check.error, ROUTE, "Couldn't check your pieces against the challenge right now — try again in a moment.");
    }
    if (check.kind === "ineligible") {
      skipped.push({ slot: pin.slot, player_name: pin.player_name, reason: check.error });
      continue;
    }

    const row: Record<string, unknown> = { user_id: user.id, case_id: caseId, slot: free[rows.length], pinned_at: new Date().toISOString() };
    for (const k of COPIED) row[k] = pin[k] ?? null;
    rows.push(row);
  }

  if (rows.length === 0) return NextResponse.json({ copied: 0, skipped });

  const { data, error } = await supabase
    .from("trophy_moments")
    .upsert(rows, { onConflict: "user_id,case_id,slot" })
    .select("slot");
  if (error) {
    console.error("[trophy-cases copy-main] insert failed");
    return apiErrorResponse(error, ROUTE, "Couldn't copy your pieces into that case.");
  }
  warmCardsLater(supabase, user.id, caseId);
  return NextResponse.json({ copied: Array.isArray(data) ? data.length : 0, skipped });
}
