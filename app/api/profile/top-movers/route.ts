// app/api/profile/top-movers/route.ts
//
// GET /api/profile/top-movers?days=7[&ownerKey=username]
// Merges get_top_movers gainers/losers across the saved wallets of a target
// user, returning the top 5 of each by dollar change. With ?ownerKey=username
// (the public path used by the profile page) the user is resolved through
// profile_bio — holdings are PUBLIC on a collector showcase, so this path is
// unauthenticated. Without ownerKey it falls back to the current authenticated
// user (dashboard own-view). Owner-scoping is also what fixes the "Top Movers
// reads empty" bug on public profiles (anon previously had no wallets).
//
// Uses the SECDEF helper get_user_saved_wallets(p_user_id) to read the
// wallet list — service-role client bypasses the JWT-forwarding gap that
// was making the post-R3 endpoints return empty even when wallets exist.
//
// Failure modes: unauthenticated / owner_not_found /
// saved_wallets_unavailable / no_wallets / unexpected_error all return
// the empty shape { gainers: [], losers: [] } so the page renders an
// empty state instead of breaking.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";
import { apiErrorResponse } from "@/lib/api-error";
import { withBoardBudget } from "@/lib/insights/board-page-fetch";

// ── ONE TOTAL BUDGET, NOT ONE PER READ ───────────────────────────────────────
// `get_top_movers` runs once per saved wallet, SEQUENTIALLY, and nothing bounds
// the calls or their number — a collector with more wallets simply waits
// longer, without limit, until the platform kills the function. A kill has no
// body, so `TopMoversCard` (which correctly discriminates on `res.ok`) gets a
// bare 5xx and every honest branch below is unreachable. 2 × 5xx in the 24 h to
// 2026-09-03 08:00Z, both on the ~19k-Moment whale.
//
// ⚠ A per-read bound of N still lets ten wallets run 10·N. The quantity with no
// ceiling is the SUM, so there is ONE deadline for the request, each read is
// bounded by WHAT IS LEFT of it, and the deadline is checked BEFORE each call —
// otherwise "the last read may start with 1 ms left" and the total is not a
// ceiling. On exhaustion the answer is the honest 5xx, never a partial list
// published as the whole one (see the `continue` note in the loop).
//
// Sized so it cannot degrade a request that works today: the largest SUCCESSFUL
// `get_top_movers` in `pg_stat_statements` on 2026-09-03 was 8,801 ms (that
// whale); 25,000 ms sits well above anything this route has been seen to
// complete. The route declares no `maxDuration`, so its real wall is the
// platform default — do not tighten this to a tidy number without measuring.
//
// ⚠ The abandoned query keeps running server-side (supabase-js has no cancel);
// we stop WAITING on it, which is the trade every other bounded read makes.
export const TOP_MOVERS_TOTAL_BUDGET_MS = 25_000;

// Resolve a public ownerKey (username) → user_id the same way the other
// public ownerKey-driven profile endpoints (teams, portfolio-history) do.
// ⚠ HONESTY CANON, same shape as its tier-breakdown / collection-breakdown
// siblings: the resolver LOGGED its error and then collapsed it onto `null`,
// which the caller spells `owner_not_found: true` at HTTP 200 -- a claim that
// the collector does not exist, manufactured from a database timeout.
// `TopMoversCard` discriminates on `res.ok`, an HTTP test a route that always
// answers 200 can never fail, so its (correct) failure branch was unreachable.
type OwnerResolution =
  | { ok: true; userId: string | null }
  | { ok: false; error: unknown };

async function resolveUserId(ownerKey: string, bound: Bound): Promise<OwnerResolution> {
  try {
    const { data, error } = await bound<any>(
      (supabase as any)
        .from("profile_bio")
        .select("user_id")
        .ilike("username", ownerKey)
        .maybeSingle(),
      "resolveUserId"
    );
    if (error) {
      console.log("[top-movers] resolveUserId failed:", error.message);
      return { ok: false, error };
    }
    return { ok: true, userId: (data as any)?.user_id ?? null };
  } catch (error) {
    console.log("[top-movers] resolveUserId failed:", (error as Error)?.message);
    return { ok: false, error };
  }
}

type Bound = <T>(p: Promise<T>, label: string) => Promise<T>;

/** The request's single deadline; `remaining()` is what every read gets. */
function startBudget(totalMs: number) {
  const started = Date.now();
  const remaining = () => totalMs - (Date.now() - started);
  const bound: Bound = (p, label) =>
    withBoardBudget(p, label, Math.max(1, remaining()), "api/profile/top-movers/");
  return { remaining, bound };
}

interface Mover {
  edition_id: string;
  player_name: string | null;
  set_name: string | null;
  current_fmv: number | null;
  past_fmv: number | null;
  delta: number;
  pct_change: number | null;
}

interface SavedWallet {
  wallet_addr: string | null;
  username: string | null;
  collection_id: string | null;
  collection_slug: string | null;
  nickname: string | null;
  cached_fmv_usd: number | null;
}

function emptyResponse(meta?: Record<string, unknown>) {
  return NextResponse.json({ gainers: [], losers: [], ...(meta ? { meta } : {}) });
}

export async function GET(req: NextRequest) {
  const days = Math.max(
    1,
    Math.min(parseInt(req.nextUrl.searchParams.get("days") ?? "7", 10) || 7, 90)
  );

  // Public ownerKey path (profile page) vs authenticated own-view fallback.
  const ownerKey = (req.nextUrl.searchParams.get("ownerKey") ?? "").trim();
  const { remaining, bound } = startBudget(TOP_MOVERS_TOTAL_BUDGET_MS);
  let userId: string | null = null;
  if (ownerKey) {
    const owner = await resolveUserId(ownerKey, bound);
    if (!owner.ok) {
      return apiErrorResponse(owner.error, "api/profile/top-movers");
    }
    userId = owner.userId;
    if (!userId) {
      return emptyResponse({ owner_not_found: true });
    }
  } else {
    const user = await getCurrentUser();
    if (!user) {
      return emptyResponse({ unauthenticated: true });
    }
    userId = user.id;
  }

  try {
    const { data: walletsRaw, error: walletsError } = await bound<any>(
      (supabase as any).rpc("get_user_saved_wallets", { p_user_id: userId }),
      "get_user_saved_wallets"
    );

    if (walletsError) {
      console.log(
        "[top-movers] get_user_saved_wallets failed:",
        walletsError.message,
        "code:",
        (walletsError as { code?: string }).code ?? "unknown"
      );
      return apiErrorResponse(walletsError, "api/profile/top-movers");
    }

    const wallets = (walletsRaw ?? []) as SavedWallet[];
    if (wallets.length === 0) {
      return emptyResponse({ no_wallets: true });
    }

    const allGainers: Mover[] = [];
    const allLosers: Mover[] = [];

    // get_user_saved_wallets returns one row per (wallet x published
    // collection), so dedupe by address — get_top_movers is per-wallet and
    // returns all collections for it. (Results are also deduped by edition_id
    // below, so this is a perf/consistency guard, not the count fix.)
    const seenWallet = new Set<string>();

    for (const w of wallets) {
      const raw = w.wallet_addr ?? "";
      const addr = raw.startsWith("0x") ? raw : raw ? "0x" + raw : "";
      if (!addr || addr === "0x") continue;
      if (seenWallet.has(addr)) continue;
      seenWallet.add(addr);

      // The deadline is checked BEFORE the call, so the total is a real
      // ceiling (a read that starts with nothing left is not "bounded by the
      // remainder", it is a read the budget already forbade).
      if (remaining() <= 0) {
        const err = new Error(
          `[api/profile/top-movers] total budget of ${TOP_MOVERS_TOTAL_BUDGET_MS}ms exhausted after ` +
            `${seenWallet.size - 1} of ${wallets.length} wallets`
        );
        console.log("[top-movers]", err.message);
        return apiErrorResponse(err, "api/profile/top-movers");
      }

      const { data, error } = await bound<any>(
        (supabase as any).rpc("get_top_movers", { p_wallet: addr, p_days: days }),
        "get_top_movers:" + addr
      );
      if (error) {
        console.log(
          "[top-movers] get_top_movers failed for",
          addr,
          "message:",
          error.message,
          "code:",
          error.code ?? "unknown"
        );
        // Was `continue`. This card's empty copy does not say "nothing moved" --
        // it explains the blank as PIPELINE PROGRESS and tells the reader to
        // wait days (the component's own comment says so). Dropping one wallet
        // and publishing the rest as the whole movers list invents that product
        // state out of a timeout, for the reader's own holdings.
        return apiErrorResponse(error, "api/profile/top-movers");
      }
      const payload = (data ?? {}) as { gainers?: Mover[]; losers?: Mover[] };
      if (Array.isArray(payload.gainers)) allGainers.push(...payload.gainers);
      if (Array.isArray(payload.losers)) allLosers.push(...payload.losers);
    }

    function dedupe(rows: Mover[]): Mover[] {
      const seen = new Set<string>();
      const out: Mover[] = [];
      for (const r of rows) {
        if (!r.edition_id || seen.has(r.edition_id)) continue;
        seen.add(r.edition_id);
        out.push(r);
      }
      return out;
    }

    const gainers = dedupe(allGainers)
      .sort(function (a, b) { return Number(b.delta) - Number(a.delta); })
      .slice(0, 5);
    const losers = dedupe(allLosers)
      .sort(function (a, b) { return Number(a.delta) - Number(b.delta); })
      .slice(0, 5);

    return NextResponse.json({ gainers, losers });
  } catch (err: any) {
    console.log(
      "[top-movers] unexpected:",
      err?.message ?? String(err),
      "code:",
      err?.code ?? "unknown"
    );
    return apiErrorResponse(err, "api/profile/top-movers");
  }
}
