// app/api/profile/trophy-cases/fill/route.ts
//
// POST { caseId, confirm?: boolean } → "Fill my case" for a challenge entry
// (2026-11-08 weekend review; see lib/trophy/fill-case.ts for why and for the
// order). Without `confirm` it PROPOSES the pieces for the empty slots and writes
// nothing; with `confirm: true` it pins them.
//
// ⚠ EVERY PROPOSED PIECE PASSES THE SAME GATE AS A HAND PIN (`checkChallengePin`:
// collection, player, ownership through the wallet index) before it is offered,
// and again before it is written — the ranking is a proposal, not the gate. A
// check that could not RUN is a 503, never a silent skip that would read as
// "you don't own enough".
// ⚠ Top Shot (Flow) pieces only: a Panini card is verified against a linked
// username by its own resolver one card at a time, which this bulk path does not
// do. The response says how many Panini-eligible pieces it did NOT consider.
// ⚠ `pinned` counts rows the upsert RETURNED, not rows attempted.

import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-error";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";
import { boundedRead } from "@/lib/api/bounded-read";
import { warmCardsLater } from "@/lib/og/card-warm";
import { loadOwnCase, parseCaseId, refuseClosedChallenge } from "@/lib/trophy/cases";
import { checkChallengePin, parseChallengeRules } from "@/lib/trophy/challenge-rules";
import { PANINI_COLLECTION_ID } from "@/lib/trophy/slab-href";
import { rankFillCandidates, topShotThumbnail, type FillCandidateRow } from "@/lib/trophy/fill-case";
import { sanitizeTrophyThumbnail } from "@/lib/profile/trophy-thumbnail";
import { syncRecentTopShotBuysForWallets } from "@/lib/trophy/recent-buys";

export const dynamic = "force-dynamic";

const ROUTE = "api/profile/trophy-cases/fill";
const UNCHECKED = "Couldn't check your pieces against the challenge right now — try again in a moment.";

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
  const confirm = body?.confirm === true;

  const own = await loadOwnCase(supabase, user.id, caseId);
  if (!own.ok) return apiErrorResponse(own.error, ROUTE);
  if (!own.case) return NextResponse.json({ error: "That trophy case doesn't exist." }, { status: 404 });
  const challenge = own.case.challenge;
  if (!challenge) return NextResponse.json({ error: "Only a challenge entry can be filled this way." }, { status: 400 });
  const closed = refuseClosedChallenge(own.case);
  if (closed) return closed;

  const rules = parseChallengeRules(challenge.rules);
  if (rules.playerNames.length === 0) {
    return NextResponse.json({ error: `${challenge.title} has no player rule to fill from.` }, { status: 400 });
  }

  const [caseRes, walletsRes, colsRes] = await Promise.all([
    boundedRead(
      supabase.from("trophy_moments").select("slot, moment_id, edition_id").eq("user_id", user.id).eq("case_id", caseId),
      `${ROUTE}/entry`
    ),
    boundedRead(supabase.from("saved_wallets").select("wallet_addr").eq("user_id", user.id), `${ROUTE}/wallets`),
    rules.collectionSlugs
      ? boundedRead(supabase.from("collections").select("id, slug").in("slug", rules.collectionSlugs), `${ROUTE}/collections`)
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (caseRes.error) return apiErrorResponse(caseRes.error, ROUTE);
  if (walletsRes.error) return apiErrorResponse(walletsRes.error, ROUTE);
  if (colsRes.error) return apiErrorResponse(colsRes.error, ROUTE);

  const inCase = (caseRes.data ?? []) as unknown as { slot: number; moment_id: string; edition_id: string | null }[];
  const free = [1, 2, 3, 4, 5, 6].filter((s) => !inCase.some((p) => p.slot === s));
  if (free.length === 0) return NextResponse.json({ need: 0, picks: [], short: 0, pinned: 0 });

  const wallets = [
    ...new Set(
      ((walletsRes.data ?? []) as { wallet_addr: unknown }[])
        .map((r) => (typeof r.wallet_addr === "string" ? r.wallet_addr : null))
        .filter((w): w is string => !!w)
    ),
  ];
  if (wallets.length === 0) {
    return NextResponse.json({ error: `${challenge.title} only takes pieces you hold — add your wallet to your profile first.` }, { status: 403 });
  }
  // 2026-11-10: a piece bought after the wallet's last walk is not in the cache
  // the candidates (and checkChallengePin) read — spitehouse stopped at 5 of 6
  // holding a sixth. Pull purchases since the last walk in, verified on-chain,
  // first. A failed sync leaves the cache as it was (stricter, never looser).
  const synced = await syncRecentTopShotBuysForWallets(supabase, wallets);
  for (const r of synced) if (r.error) console.warn(`[trophy-cases fill] recent-buys sync ${r.wallet}: ${r.error}`);

  const ruledCols = colsRes.data
    ? ((colsRes.data as { id: string }[]).map((c) => c.id))
    : null;
  const flowCols = ruledCols ? ruledCols.filter((id) => id !== PANINI_COLLECTION_ID) : null;
  const paniniRuled = !ruledCols || ruledCols.includes(PANINI_COLLECTION_ID);

  let cq = supabase
    .from("wallet_moments_cache")
    .select("wallet_address, moment_id, collection_id, edition_key, fmv_usd, serial_number, last_seen_at, is_locked, lock_checked_at, player_name, set_name, tier, mint_count")
    .in("wallet_address", wallets)
    .in("player_name", rules.playerNames)
    .neq("collection_id", PANINI_COLLECTION_ID)
    .limit(1000);
  if (flowCols) cq = cq.in("collection_id", flowCols);
  // The newest row per wallet anchors the "seen in the latest walk" test.
  // ⚠ NOT NULL first: a DESC sort puts NULLs FIRST in Postgres.
  const newestReads = wallets.map((w) =>
    boundedRead(
      supabase
        .from("wallet_moments_cache")
        .select("last_seen_at")
        .eq("wallet_address", w)
        .not("last_seen_at", "is", null)
        .order("last_seen_at", { ascending: false })
        .limit(1),
      `${ROUTE}/newest`
    )
  );
  const [candRes, ...newestRes] = await Promise.all([boundedRead(cq, `${ROUTE}/candidates`), ...newestReads]);
  if (candRes.error) return apiErrorResponse(candRes.error, ROUTE);
  const walletNewestMs = new Map<string, number>();
  newestRes.forEach((r, i) => {
    // A failed newest read leaves that wallet on the locked branch only — stricter, never looser.
    const at = !r.error ? ((r.data ?? []) as { last_seen_at: string }[])[0]?.last_seen_at : null;
    const ms = at ? Date.parse(at) : NaN;
    if (Number.isFinite(ms)) walletNewestMs.set(wallets[i], ms);
  });

  const rows = (candRes.data ?? []) as unknown as (FillCandidateRow & {
    collection_id: string
    player_name: string | null
    set_name: string | null
    tier: string | null
    mint_count: number | null
  })[];
  const ranked = rankFillCandidates(rows, {
    pinnedMomentIds: new Set(inCase.map((p) => String(p.moment_id))),
    pinnedEditions: new Set(inCase.map((p) => p.edition_id).filter((e): e is string => !!e)),
    walletNewestMs,
    nowMs: Date.now(),
  }) as typeof rows;

  // Gate each proposal exactly as a hand pin is gated, until the free slots are covered.
  const picks: (typeof rows)[number][] = [];
  for (const r of ranked) {
    if (picks.length >= free.length) break;
    const check = await checkChallengePin(supabase, rules, challenge.title, {
      userId: user.id,
      momentId: String(r.moment_id),
      collectionId: String(r.collection_id),
      paniniPlayerName: null,
    });
    if (check.kind === "unchecked") return apiErrorResponse(check.error, ROUTE, UNCHECKED);
    if (check.kind === "eligible") picks.push(r);
  }

  const short = free.length - picks.length;
  const proposal = picks.map((p, i) => ({
    slot: free[i],
    moment_id: String(p.moment_id),
    player_name: p.player_name,
    set_name: p.set_name,
    tier: p.tier,
    serial_number: p.serial_number,
    fmv: p.fmv_usd == null ? null : Number(p.fmv_usd),
  }));
  if (!confirm) {
    return NextResponse.json({ need: free.length, picks: proposal, short, paniniNotConsidered: paniniRuled });
  }
  // All six are needed to complete (Trevor, 11-08) — a confirm that cannot reach 6
  // still pins what it can, and says how many it could not.
  if (picks.length === 0) return NextResponse.json({ need: free.length, picks: [], short, pinned: 0 });

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("trophy_moments")
    .upsert(
      picks.map((p, i) => ({
        user_id: user.id,
        case_id: caseId,
        slot: free[i],
        moment_id: String(p.moment_id),
        collection_id: p.collection_id,
        edition_id: p.edition_key,
        player_name: p.player_name,
        set_name: p.set_name,
        serial_number: p.serial_number,
        circulation_count: p.mint_count,
        tier: p.tier,
        thumbnail_url: sanitizeTrophyThumbnail(topShotThumbnail(String(p.moment_id))),
        fmv: p.fmv_usd == null ? null : Number(p.fmv_usd),
        pinned_at: now,
      })),
      // Only EMPTY slots are written (free[] above), so this never displaces a pin.
      { onConflict: "user_id,case_id,slot", ignoreDuplicates: true }
    )
    .select("slot");
  if (error) {
    console.error("[trophy-cases fill] insert failed");
    return apiErrorResponse(error, ROUTE, "Couldn't fill your case right now.");
  }
  warmCardsLater(supabase, user.id, caseId);
  const pinned = Array.isArray(data) ? data.length : 0;
  return NextResponse.json({ need: free.length, picks: proposal, short: free.length - pinned, pinned });
}
