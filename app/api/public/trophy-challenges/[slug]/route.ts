// app/api/public/trophy-challenges/[slug]/route.ts
//
// GET → { challenge, entry_count, entries: [{ username, slabs, ... }] } for a
// trophy challenge board. Unknown slug → 404. A failed read → 503 (never an
// empty board: "no entries yet" is a claim about the challenge).
//
// `reward` (2026-11-10): the OPEN giveaway drop whose packs are for this
// challenge's finishers, so the board can send them to claim. A failed reward
// read is `reward: null, reward_error: true` — the board still loads and simply
// shows no claim link; it is never reported as "no reward".

import { NextRequest, NextResponse } from "next/server";
import { supabase as supabaseAnon, supabaseAdmin } from "@/lib/supabase";
import { openRewardDropForChallenge, type RewardDrop } from "@/lib/giveaways/challenge-reward";
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";
import { challengeIsOpen } from "@/lib/trophy/cases";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const client: any = supabaseAnon;
  const { data, error } = await boundedRead(
    client.rpc("get_trophy_challenge_entries", { p_slug: slug, p_limit: 48 }),
    "api/public/trophy-challenges/get_trophy_challenge_entries"
  );
  if (error) {
    console.error("[public trophy-challenges]", error);
    return apiErrorResponse(error, "api/public/trophy-challenges");
  }
  if (data == null) return NextResponse.json({ error: "No such challenge" }, { status: 404 });
  // `is_open` is decided here, server-side, so the client never reads the wall
  // clock during render (hydration guard). Same rule the entry route enforces.
  const ch = (data as { challenge?: { is_active?: boolean; starts_at?: string | null; ends_at?: string | null } }).challenge
  const is_open = ch ? challengeIsOpen({ is_active: ch.is_active === true, starts_at: ch.starts_at ?? null, ends_at: ch.ends_at ?? null }) : false
  let reward: RewardDrop | null = null
  let reward_error = false
  {
    const r = await boundedRead(
      openRewardDropForChallenge(supabaseAdmin as never, slug).then(
        (d) => ({ data: d, error: null }),
        (e: unknown) => ({ data: null, error: { message: e instanceof Error ? e.message : String(e) } }),
      ),
      "api/public/trophy-challenges/reward_drop"
    );
    if (r.error) {
      reward_error = true
      console.warn("[public trophy-challenges] reward drop read:", r.error.message ?? r.error)
    } else {
      reward = r.data as RewardDrop | null
    }
  }
  return NextResponse.json({ ...(data as object), is_open, reward, reward_error }, {
    headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" },
  });
}
