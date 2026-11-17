// app/api/profile/collector-identities/route.ts
//
// Link a Panini USERNAME to the signed-in user's profile (2026-09-25).
//
// A Panini owner is a username, not an address (lib/address.ts
// `isPaniniUsername`), so it lives in `saved_collector_identities`, never in
// `saved_wallets`. This route is the ONLY path in: the dashboard's one-field add
// sends non-address input to the Top Shot resolver, and a Panini handle that
// matched a Top Shot handle there would attach someone else's Flow wallet.
//
// What RPC can say about a username comes from TWO sources:
//   · `panini_owner_summary` — cards seen under it in `panini_card_serials`
//     (the Prizm World Cup editions RPC indexes);
//   · the COLLECTOR WALK — `panini_collector_walks` + `panini_user_holdings`,
//     the whole public Panini profile, read on a schedule for every LINKED
//     username (/api/cron/panini-collector-walk `plan`).
//
// ⚠ CHANGED 2026-09-28: a username with 0 cards in the serial index used to be
// REFUSED ("RPC hasn't seen any Panini cards listed under that username"). That
// gate was backwards: linking is what schedules the profile walk, so refusing it
// blocked the one read that would find the cards. It refused the founder's own
// username, whose walked profile holds 146 cards — none in the indexed editions.
// A well-formed username is now always linked; the panel says "not read yet"
// until the walk has run, never "0 cards".
//
// Three states, never two (honesty canon):
//   read failed          → apiErrorResponse (5xx) on POST; `summary_failed` on GET
//   username not walked  → linked; `profile.walked = false` → "not read yet"
//   username walked      → linked; `profile` carries what the walk read
//
//   GET    → { identities: [{ collection, username, created_at, summary|null, summary_failed }] }
//   POST   { username } → links it (cap: 5 wallets + usernames per account)
//   DELETE { username } → unlinks it

import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-error";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";
import { getCollection } from "@/lib/collections";
import { withBoardBudget } from "@/lib/insights/board-page-fetch";
import { countDistinctWallets, SAVED_WALLET_LIMIT, savedWalletLimitMessage } from "@/lib/profile/saved-wallet-quota";
import {
  countLinkedIdentities,
  normalizePaniniUsername,
  parsePaniniOwnerSummary,
  type PaniniOwnerSummary,
} from "@/lib/profile/collector-identities";

const PANINI_SLUG = "panini-blockchain";

function paniniCollectionId(): string | null {
  return getCollection(PANINI_SLUG)?.supabaseCollectionId ?? null;
}

/** What the collector walk has read off the username's public Panini profile. */
interface PaniniProfileRead {
  walked: boolean;
  profile_state: string | null;
  last_complete_at: string | null;
  cards_held: number | null;
}

type SummaryRead =
  | { ok: true; summary: PaniniOwnerSummary & { profile: PaniniProfileRead } }
  | { ok: false; error: unknown };

// Bounded: an unbounded read on a saturated DB lets the platform kill the
// function before the honest error below can be sent (the caller gets a 504).
const SUMMARY_BUDGET_MS = 8_000;

async function readPaniniSummary(username: string): Promise<SummaryRead> {
  let data: unknown;
  let error: unknown;
  let walk: { data: any; error: unknown };
  let held: { count: number | null; error: unknown };
  try {
    [{ data, error }, walk, held] = await Promise.all([
      withBoardBudget(
        (supabase as any).rpc("panini_owner_summary", { p_username: username }) as Promise<{ data: unknown; error: unknown }>,
        "panini_owner_summary",
        SUMMARY_BUDGET_MS,
        "api/profile/collector-identities/",
      ),
      withBoardBudget(
        (supabase as any)
          .from("panini_collector_walks")
          .select("profile_state, last_complete_at")
          .eq("username", username)
          .maybeSingle() as Promise<{ data: any; error: unknown }>,
        "panini_collector_walks",
        SUMMARY_BUDGET_MS,
        "api/profile/collector-identities/",
      ),
      withBoardBudget(
        (supabase as any)
          .from("panini_user_holdings")
          .select("url_key", { count: "exact", head: true })
          .eq("username", username) as Promise<{ count: number | null; error: unknown }>,
        "panini_user_holdings",
        SUMMARY_BUDGET_MS,
        "api/profile/collector-identities/",
      ),
    ]);
  } catch (err) {
    return { ok: false, error: err };
  }
  if (error) return { ok: false, error };
  if (walk.error) return { ok: false, error: walk.error };
  if (held.error) return { ok: false, error: held.error };
  const summary = parsePaniniOwnerSummary(data);
  if (!summary) return { ok: false, error: new Error("panini_owner_summary returned an unexpected shape") };
  const walked = walk.data != null;
  if (walked && typeof held.count !== "number") {
    // A walked username whose card count did not come back is a FAILED read —
    // never "0 cards on your profile".
    return { ok: false, error: new Error("panini_user_holdings count missing") };
  }
  return {
    ok: true,
    summary: {
      ...summary,
      profile: {
        walked,
        profile_state: walked ? (walk.data.profile_state ?? null) : null,
        last_complete_at: walked ? (walk.data.last_complete_at ?? null) : null,
        cards_held: walked ? held.count : null,
      },
    },
  };
}

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const { data, error } = await (supabase as any)
    .from("saved_collector_identities")
    .select("collection_id, identity_kind, identity_value, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });
  if (error) return apiErrorResponse(error, "api/profile/collector-identities");

  const paniniId = paniniCollectionId();
  const rows: any[] = data ?? [];
  const identities = await Promise.all(
    rows.map(async (r) => {
      const isPanini = r.collection_id === paniniId;
      // Per-row failure flag: one failed summary must not blank the list, and
      // must not render as "0 cards seen" either.
      const read = isPanini ? await readPaniniSummary(r.identity_value) : null;
      if (read && !read.ok) {
        console.error("[collector-identities GET] summary read failed:", (read.error as any)?.message ?? read.error);
      }
      return {
        collection: isPanini ? PANINI_SLUG : r.collection_id,
        username: r.identity_value as string,
        created_at: r.created_at as string,
        summary: read && read.ok ? read.summary : null,
        summary_failed: !!read && !read.ok,
      };
    })
  );

  return NextResponse.json({ identities });
}

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  let body: { username?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const username = normalizePaniniUsername(body.username);
  if (!username) {
    return NextResponse.json(
      {
        error: "invalid_username",
        message: "That doesn't look like a Panini username (2–16 letters, numbers, _ . or -).",
      },
      { status: 400 }
    );
  }

  const collectionId = paniniCollectionId();
  if (!collectionId) {
    return NextResponse.json({ error: "Panini is not configured" }, { status: 500 });
  }

  // No existence gate (see the header): linking is what schedules the profile
  // walk. The summary is read so the response can say what RPC has so far.
  const read = await readPaniniSummary(username);
  if (!read.ok) return apiErrorResponse(read.error, "api/profile/collector-identities");

  // Already linked? A re-link is idempotent and skips the cap.
  const { data: existing, error: existErr } = await (supabase as any)
    .from("saved_collector_identities")
    .select("id")
    .eq("user_id", user.id)
    .eq("collection_id", collectionId)
    .eq("identity_kind", "username")
    .eq("identity_value", username)
    .maybeSingle();
  if (existErr) return apiErrorResponse(existErr, "api/profile/collector-identities");

  if (!existing) {
    // Cap: 5 saved wallets + linked usernames per account, no plan consulted
    // (Trevor, 2026-09-25). Unlike the wallet routes this fails CLOSED — a new, optional
    // link can wait out an outage; a wallet save is the primary path.
    const { data: addrRows, error: addrErr } = await supabase
      .from("saved_wallets")
      .select("wallet_addr")
      .eq("user_id", user.id)
      .limit(1000);
    const linked = await countLinkedIdentities(supabase, user.id);
    if (addrErr || linked === null) {
      return apiErrorResponse(addrErr ?? new Error("linked-identity count failed"), "api/profile/collector-identities");
    }
    const used = countDistinctWallets(addrRows) + linked;
    if (used >= SAVED_WALLET_LIMIT) {
      return NextResponse.json(
        {
          error: "wallet_limit_reached",
          message: savedWalletLimitMessage(),
          saved_wallet_count: used,
          saved_wallet_limit: SAVED_WALLET_LIMIT,
        },
        { status: 409 }
      );
    }

    const { error: insErr } = await (supabase as any).from("saved_collector_identities").insert({
      user_id: user.id,
      collection_id: collectionId,
      identity_kind: "username",
      identity_value: username,
    });
    // 23505 = a concurrent request linked the same username first: same outcome.
    if (insErr && insErr.code !== "23505") {
      return apiErrorResponse(insErr, "api/profile/collector-identities");
    }
  }

  return NextResponse.json({
    identity: { collection: PANINI_SLUG, username, summary: read.summary },
    created: !existing,
  });
}

export async function DELETE(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  let body: { username?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const username = normalizePaniniUsername(body.username);
  const collectionId = paniniCollectionId();
  if (!username || !collectionId) {
    return NextResponse.json({ error: "username required" }, { status: 400 });
  }

  const { error } = await (supabase as any)
    .from("saved_collector_identities")
    .delete()
    .eq("user_id", user.id)
    .eq("collection_id", collectionId)
    .eq("identity_value", username);
  if (error) return apiErrorResponse(error, "api/profile/collector-identities");
  return NextResponse.json({ ok: true });
}
