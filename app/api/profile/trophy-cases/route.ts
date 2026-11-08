// app/api/profile/trophy-cases/route.ts
//
// The signed-in collector's EXTRA trophy cases (2026-11-06) — named cases and
// challenge entries. The main case stays on /api/profile/trophy{,-slabs}.
//
//   GET     → { cases: [...with slabs], challenges: [open challenges] }
//   POST    { name }            → create a named case
//   POST    { challengeSlug }   → enter a challenge (one entry per challenge)
//   PATCH   { caseId, name }    → rename
//   DELETE  { caseId }          → delete the case AND its pins (FK cascade)
//
// ⚠ GET's two reads fail independently and are reported independently. A
// failed cases read is a 503, never `{ cases: [] }` — the dashboard renders an
// empty list as "you have no extra cases", and a collector who has three would
// be invited to rebuild them (CLAUDE.md "Honesty": a failed read must not
// render as an answer).

import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-error";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";
import { boundedRead } from "@/lib/api/bounded-read";
import {
  MAX_CASE_NAME_LEN,
  MAX_EXTRA_CASES,
  challengeIsOpen,
  cleanCaseName,
  parseCaseId,
} from "@/lib/trophy/cases";

export const dynamic = "force-dynamic";

const ROUTE = "api/profile/trophy-cases";

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const client: any = supabase;
  const [cases, challenges, bio] = await Promise.all([
    boundedRead(client.rpc("get_trophy_cases_for_user", { p_user_id: user.id }), `${ROUTE}/get_trophy_cases_for_user`),
    client
      .from("trophy_challenges")
      .select("id, slug, title, tagline, description, starts_at, ends_at, is_active")
      .eq("is_active", true)
      .order("starts_at", { ascending: false })
      .limit(20),
    // 2026-11-07 review: a challenge BOARD lists only collectors with a profile
    // username (get_trophy_challenge_entries joins profile_bio.username IS NOT
    // NULL), so the panel may say "on the board" only when we KNOW one exists.
    client.from("profile_bio").select("username").eq("user_id", user.id).limit(1),
  ]);

  if (cases.error) {
    console.error("[trophy-cases GET] cases read failed");
    return apiErrorResponse(cases.error, ROUTE, "Couldn't load your trophy cases.");
  }

  // The challenge list is a promotion, not the collector's data: if it fails we
  // still return their cases, and say the list is unknown (null) rather than [].
  const openChallenges = challenges.error
    ? null
    : ((challenges.data ?? []) as { is_active: boolean; starts_at: string | null; ends_at: string | null }[]).filter((c) => challengeIsOpen(c));
  if (challenges.error) console.error("[trophy-cases GET] challenges read failed");

  // Three states: a username (listed) · null (read ok, none set → not listed) ·
  // `board_username_known: false` (the read failed — claim neither).
  const bioRow = bio.error ? null : ((bio.data ?? [])[0] as { username?: string | null } | undefined);
  const boardUsername = bio.error ? null : (bioRow?.username ?? null);
  if (bio.error) console.error("[trophy-cases GET] profile_bio read failed");

  return NextResponse.json(
    {
      cases: Array.isArray(cases.data) ? cases.data : [],
      challenges: openChallenges,
      board_username: boardUsername,
      board_username_known: !bio.error,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const body = await req.json().catch(() => null);
  const slug = typeof body?.challengeSlug === "string" ? body.challengeSlug.trim().toLowerCase() : null;

  // Count first so the cap message is accurate.
  const existing = await supabase
    .from("trophy_cases")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);
  if (existing.error) return apiErrorResponse(existing.error, ROUTE);
  // ⚠ `count` is null on a failed count — that branch returned above, so a null
  // here would be a client bug; treat it as unknown rather than zero.
  if (existing.count == null) return apiErrorResponse(new Error("count unavailable"), ROUTE);
  if (existing.count >= MAX_EXTRA_CASES) {
    return NextResponse.json(
      { error: `You can have up to ${MAX_EXTRA_CASES} extra trophy cases. Delete one to make room.` },
      { status: 409 }
    );
  }

  let name: string | null;
  let challengeId: string | null = null;

  if (slug) {
    const ch = await supabase
      .from("trophy_challenges")
      .select("id, title, is_active, starts_at, ends_at")
      .eq("slug", slug)
      .limit(1);
    if (ch.error) return apiErrorResponse(ch.error, ROUTE);
    const row = (ch.data ?? [])[0] as { id: string; title: string; is_active: boolean; starts_at: string | null; ends_at: string | null } | undefined;
    if (!row) return NextResponse.json({ error: "That challenge doesn't exist." }, { status: 404 });
    if (!challengeIsOpen(row)) {
      return NextResponse.json({ error: `${row.title} isn't taking entries.` }, { status: 409 });
    }
    challengeId = row.id;
    name = row.title.slice(0, MAX_CASE_NAME_LEN);
  } else {
    name = cleanCaseName(body?.name);
    if (!name) {
      return NextResponse.json(
        { error: `Give the case a name (1–${MAX_CASE_NAME_LEN} characters).` },
        { status: 400 }
      );
    }
  }

  const { data, error } = await supabase
    .from("trophy_cases")
    .insert({ user_id: user.id, name, challenge_id: challengeId })
    .select("id, name, challenge_id, created_at")
    .single();

  if (error) {
    // 23514 trophy_case_cap_reached: the DB trigger (migration
    // audit_20261107_trophy_cases_extra_cap_enforced_in_db) caught a concurrent
    // insert that passed the count above — the same answer as the count gives.
    if ((error as { code?: string }).code === "23514" && String((error as { message?: string }).message ?? "").includes("trophy_case_cap_reached")) {
      return NextResponse.json(
        { error: `You can have up to ${MAX_EXTRA_CASES} extra trophy cases. Delete one to make room.` },
        { status: 409 }
      );
    }
    // 23505 on (user_id, challenge_id): already entered. Actionable, not a failure.
    if ((error as { code?: string }).code === "23505") {
      return NextResponse.json({ error: "You've already entered this challenge.", code: "already_entered" }, { status: 409 });
    }
    console.error("[trophy-cases POST] insert failed");
    return apiErrorResponse(error, ROUTE, "Couldn't create that trophy case.");
  }
  return NextResponse.json({ case: data }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const body = await req.json().catch(() => null);
  const caseId = parseCaseId(body?.caseId);
  if (!caseId) return NextResponse.json({ error: "caseId required" }, { status: 400 });
  const name = cleanCaseName(body?.name);
  if (!name) {
    return NextResponse.json({ error: `Name must be 1–${MAX_CASE_NAME_LEN} characters.` }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("trophy_cases")
    .update({ name })
    .eq("id", caseId)
    .eq("user_id", user.id)
    .select("id, name")
    .maybeSingle();
  if (error) return apiErrorResponse(error, ROUTE);
  if (!data) return NextResponse.json({ error: "That trophy case doesn't exist." }, { status: 404 });
  return NextResponse.json({ case: data });
}

export async function DELETE(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const body = await req.json().catch(() => null);
  const caseId = parseCaseId(body?.caseId);
  if (!caseId) return NextResponse.json({ error: "caseId required" }, { status: 400 });

  const { data, error } = await supabase
    .from("trophy_cases")
    .delete()
    .eq("id", caseId)
    .eq("user_id", user.id)
    .select("id");
  if (error) return apiErrorResponse(error, ROUTE);
  // `ok` derived from whether a row was actually removed (R120: never a
  // hardcoded success).
  if (!Array.isArray(data) || data.length === 0) {
    return NextResponse.json({ error: "That trophy case doesn't exist." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
