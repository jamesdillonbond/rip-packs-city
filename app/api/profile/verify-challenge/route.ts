// app/api/profile/verify-challenge/route.ts
//
// Listing-amount fallback verification. Proof-of-control: RPC PICKS a cheap
// Moment the wallet owns, and asks the user to list THAT Moment at a unique
// price (~100x its FMV, floored at $10, with random cents as the uniqueness
// salt — so it can never be unintentionally bought). The on-demand check
// (verify-challenge/check) confirms the listing live via Top Shot's API.
//
//   POST   { wallet_addr }              → picks a target + mints a challenge
//   GET    ?wallet_addr=...             → returns the active challenge + target
//   PATCH  { wallet_addr? }             → legacy cron resolver pass (harmless)

import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";
import { fetchMomentListingState, topShotMomentUrl } from "@/lib/verify-wallet-gql";
import { fetchOnChainIds } from "@/lib/chains/flow/wallet-backfill-helpers";

const CHALLENGE_TTL_MIN = 30;
const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";

type TargetCandidate = {
  moment_id: string;
  edition_key: string | null;
  serial_number: number | null;
  player_name: string | null;
  set_name: string | null;
  image_url: string | null;
  fmv_usd: number | null;
};

// Price = ~100x FMV, floored at $10, capped at $999, plus 1-99 random cents.
// The 100x markup + $10 floor make the listing economically unbuyable; the
// cents are the per-challenge uniqueness salt. Returns a 2dp number.
function computeChallengeAmount(fmvUsd: number | null): number {
  const fmv = Number.isFinite(fmvUsd as number) && (fmvUsd as number) > 0 ? (fmvUsd as number) : 0.1;
  const base = Math.min(Math.max(Math.round(fmv * 100), 10), 999);
  const cents = Math.floor(Math.random() * 99) + 1; // 1..99
  return Math.round(base * 100 + cents) / 100;
}

function buildTargetCard(c: TargetCandidate) {
  return {
    moment_id: c.moment_id,
    edition_key: c.edition_key,
    serial_number: c.serial_number,
    player_name: c.player_name,
    set_name: c.set_name,
    image_url: c.image_url,
    fmv_usd: c.fmv_usd,
    list_url: topShotMomentUrl(c.moment_id),
  };
}

function normalizeAddr(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t.startsWith("0x")) return null;
  return t.toLowerCase();
}

// Strict picker (cheapest sub-$1 displayable Moments) then a relaxed fallback
// (cheapest displayable Moment overall) when the wallet holds no dust Commons.
async function pickCandidates(wallet: string): Promise<TargetCandidate[]> {
  const { data: strict } = await supabase.rpc("pick_verification_target", {
    p_wallet: wallet,
    p_limit: 8,
  });
  if (Array.isArray(strict) && strict.length) return strict as TargetCandidate[];

  // Relaxed: cheapest displayable TS Moments overall (image present, fmv > 0).
  const { data: relaxed } = await supabase
    .from("wallet_moments_cache")
    .select("moment_id, edition_key, serial_number, player_name, set_name, image_url, fmv_usd")
    .eq("wallet_address", wallet)
    .eq("collection_id", TOPSHOT_COLLECTION_ID)
    .gt("fmv_usd", 0)
    .like("image_url", "http%")
    .order("fmv_usd", { ascending: true })
    .limit(8);
  return (relaxed ?? []) as TargetCandidate[];
}

// Proven TopShot getIDs walk (mirrors app/api/owned-flow-ids + wallet-search):
// borrow the public MomentCollection cap and return the live on-chain ids.
// getIDs() alone is cheap even at 40k+ moments (no per-NFT work).
const TOPSHOT_GETIDS_CADENCE = `
import TopShot from 0x0b2a3299cc857e29
access(all) fun main(address: Address): [UInt64] {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
  if col == nil { return [] }
  return col!.getIDs()
}
`.trim();

// Live on-chain ownership set for the wallet's TopShot moments, as a Set of
// id strings — or null when the Flow read FAILS. wmc is a cache that retains
// rows for moments the wallet has since burned or transferred, and Top Shot's
// getMintedMoment keeps returning a burned moment's metadata (found=true, not
// locked, not for sale), so the GQL confirm can't catch a burn. This gate is
// the only place ownership is actually verified. A transient access-node
// error returns null so the caller falls back to GQL-only checks rather than
// dead-ending verification on a Flow hiccup.
async function fetchOwnedTopShotIds(wallet: string): Promise<Set<string> | null> {
  try {
    const ids = await fetchOnChainIds(TOPSHOT_GETIDS_CADENCE, wallet);
    return new Set(ids.map((id) => String(id)));
  } catch (e) {
    console.warn(
      "[verify-challenge POST] on-chain getIDs failed:",
      e instanceof Error ? e.message : String(e)
    );
    return null;
  }
}

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const wallet = normalizeAddr(body?.wallet_addr ?? body?.walletAddr);
  if (!wallet) {
    return NextResponse.json({ error: "wallet_addr (0x...) required" }, { status: 400 });
  }

  // Confirm the user actually has this wallet saved before issuing a challenge.
  const { data: saved } = await supabase
    .from("saved_wallets")
    .select("wallet_addr")
    .eq("user_id", user.id)
    .eq("wallet_addr", wallet)
    .limit(1);
  if (!saved || saved.length === 0) {
    return NextResponse.json({ error: "Wallet not saved on this account" }, { status: 403 });
  }

  // Pick the target Moment(s) the user will list. Then live-confirm the first
  // candidate that is found, unlocked, and not already listed (a listed moment
  // would falsely match the moment we want them to set the price on).
  const candidates = await pickCandidates(wallet);
  if (!candidates.length) {
    // No candidates can mean two very different things. Distinguish a COLD
    // wallet (never indexed → zero wmc rows, true for a brand-new signup whose
    // prewarm hasn't run) from a wallet that IS indexed but holds nothing
    // listable. A cold wallet shouldn't dead-end — kick off the backfill and
    // tell the user we're indexing.
    const { count: wmcCount } = await supabase
      .from("wallet_moments_cache")
      .select("moment_id", { count: "exact", head: true })
      .eq("wallet_address", wallet)
      .eq("collection_id", TOPSHOT_COLLECTION_ID);

    if (!wmcCount) {
      // Fire-and-forget the TopShot wallet backfill (same Bearer pattern as
      // seed-wallet-refresh). The backfill route returns 202 and runs the
      // heavy walk on its own after() lifetime.
      const token = process.env.INGEST_SECRET_TOKEN;
      if (token) {
        const origin = new URL(req.url).origin;
        after(async () => {
          try {
            await fetch(origin + "/api/wallet-backfill", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({ wallet }),
            });
          } catch {
            // best-effort kick — the user can retry, which re-fires this path.
          }
        });
      }
      return NextResponse.json({
        challenge: null,
        unavailable: true,
        reason: "indexing",
        message: "We're indexing your collection — give it a few minutes and try again.",
      });
    }

    return NextResponse.json({
      challenge: null,
      unavailable: true,
      reason: "no_verifiable_moments",
      message: "Verification by listing isn't available for this wallet (no displayable Moment to list). Owner attestation or Dapper sign-in can be used instead.",
    });
  }

  // On-chain ownership gate. wmc is a CACHE and keeps rows for moments the
  // wallet burned or transferred until the next backfill walk — and a burned
  // moment passes every GQL check below (getMintedMoment still returns its
  // metadata). Confirm the wallet provably holds each candidate right now.
  // Only applies when the Flow read SUCCEEDS; a transient failure (null) falls
  // through to the GQL-only path so a Flow hiccup can't dead-end verification.
  let liveCandidates = candidates;
  const ownedIds = await fetchOwnedTopShotIds(wallet);
  if (ownedIds) {
    liveCandidates = candidates.filter((c) => ownedIds.has(String(c.moment_id)));
    if (!liveCandidates.length) {
      // The cheap tail in wmc is wholly stale (every candidate burned or
      // transferred). Don't fall through to a stale pick — kick a forced
      // re-walk so the next attempt sees fresh rows, and tell the user.
      const token = process.env.INGEST_SECRET_TOKEN;
      if (token) {
        const origin = new URL(req.url).origin;
        after(async () => {
          try {
            await fetch(origin + "/api/wallet-backfill?force=true", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({ wallet }),
            });
          } catch {
            // best-effort kick — the user can retry, which re-fires this path.
          }
        });
      }
      return NextResponse.json({
        challenge: null,
        unavailable: true,
        reason: "indexing",
        message:
          "Your collection cache looks out of date — we're refreshing it now. Try again in a few minutes.",
      });
    }
  }

  let target: TargetCandidate | null = null;
  for (const c of liveCandidates) {
    try {
      const state = await fetchMomentListingState(c.moment_id);
      if (state.found && !state.isLocked && !state.forSale) {
        target = c;
        break;
      }
    } catch {
      // GQL hiccup on this candidate — try the next.
      continue;
    }
  }
  if (!target) {
    return NextResponse.json({
      challenge: null,
      unavailable: true,
      reason: "no_listable_target",
      message: "Couldn't find a free Moment to list right now (your cheapest Moments are locked or already listed). Delist one and try again, or use owner attestation.",
    });
  }

  // Cancel any prior unresolved challenges for the same wallet so each
  // physical wallet only has one open puzzle at a time.
  await supabase
    .from("wallet_verification_challenges")
    .update({ resolved_at: new Date().toISOString(), resolved_via: "superseded" })
    .eq("user_id", user.id)
    .eq("wallet_addr", wallet)
    .is("resolved_at", null);

  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MIN * 60 * 1000).toISOString();
  const amount = computeChallengeAmount(target.fmv_usd);

  const { data: inserted, error } = await supabase
    .from("wallet_verification_challenges")
    .insert({
      user_id: user.id,
      wallet_addr: wallet,
      challenge_amount: amount,
      expires_at: expiresAt,
      target_moment_id: target.moment_id,
      target_edition_key: target.edition_key,
      target_serial: target.serial_number,
      target_fmv: target.fmv_usd,
    })
    .select("id, wallet_addr, challenge_amount, created_at, expires_at, resolved_at, resolved_via, matched_moment_id, target_moment_id")
    .single();

  if (error) {
    console.error("[verify-challenge POST]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    challenge: {
      ...inserted,
      expired: false,
      msRemaining: Math.max(0, new Date(inserted.expires_at).getTime() - Date.now()),
    },
    target: buildTargetCard(target),
  });
}

export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const wallet = normalizeAddr(req.nextUrl.searchParams.get("wallet_addr"));
  if (!wallet) {
    return NextResponse.json({ error: "wallet_addr query param required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("wallet_verification_challenges")
    .select("id, wallet_addr, challenge_amount, created_at, expires_at, resolved_at, resolved_via, matched_moment_id, target_moment_id, target_edition_key, target_serial, target_fmv")
    .eq("user_id", user.id)
    .eq("wallet_addr", wallet)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const row = data?.[0] ?? null;
  if (!row) {
    return NextResponse.json({ challenge: null });
  }

  const expired =
    !row.resolved_at && new Date(row.expires_at).getTime() < Date.now();

  // Enrich the target card from wmc (image/player/set) when the challenge is
  // still actionable, so a reopened modal can re-render the Moment card.
  let target = null;
  if (row.target_moment_id && !row.resolved_at && !expired) {
    const { data: m } = await supabase
      .from("wallet_moments_cache")
      .select("moment_id, edition_key, serial_number, player_name, set_name, image_url, fmv_usd")
      .eq("wallet_address", wallet)
      .eq("collection_id", TOPSHOT_COLLECTION_ID)
      .eq("moment_id", row.target_moment_id)
      .limit(1)
      .maybeSingle();
    target = buildTargetCard({
      moment_id: row.target_moment_id,
      edition_key: m?.edition_key ?? row.target_edition_key ?? null,
      serial_number: m?.serial_number ?? row.target_serial ?? null,
      player_name: m?.player_name ?? null,
      set_name: m?.set_name ?? null,
      image_url: m?.image_url ?? null,
      fmv_usd: m?.fmv_usd ?? row.target_fmv ?? null,
    });
  }

  return NextResponse.json({
    challenge: {
      ...row,
      expired,
      msRemaining: expired ? 0 : Math.max(0, new Date(row.expires_at).getTime() - Date.now()),
    },
    target,
  });
}

export async function PATCH(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const wallet = normalizeAddr(body?.wallet_addr ?? body?.walletAddr);

  // Run the matcher on every call — cheap idempotent SQL pass.
  const { data: resolved, error: resErr } = await supabase.rpc(
    "resolve_wallet_verification_challenges"
  );
  if (resErr) {
    console.error("[verify-challenge PATCH] resolver:", resErr.message);
  }

  // Fetch this user's most recent challenge so the client can update status.
  let q = supabase
    .from("wallet_verification_challenges")
    .select("id, wallet_addr, challenge_amount, created_at, expires_at, resolved_at, resolved_via, matched_moment_id")
    .eq("user_id", user.id);
  if (wallet) q = q.eq("wallet_addr", wallet);
  const { data: rows, error: rowErr } = await q
    .order("created_at", { ascending: false })
    .limit(1);
  if (rowErr) {
    return NextResponse.json({ error: rowErr.message }, { status: 500 });
  }

  const row = rows?.[0] ?? null;
  return NextResponse.json({
    resolvedThisPass: Array.isArray(resolved)
      ? resolved.filter((r: any) => r?.user_id === user.id).length
      : 0,
    challenge: row
      ? {
          ...row,
          expired:
            !row.resolved_at &&
            new Date(row.expires_at).getTime() < Date.now(),
          msRemaining: row.resolved_at
            ? 0
            : Math.max(0, new Date(row.expires_at).getTime() - Date.now()),
        }
      : null,
  });
}
