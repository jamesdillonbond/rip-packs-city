// app/api/profile/trophy-cases/sync-buys/route.ts
//
// POST → bring the signed-in collector's RECENT Top Shot purchases into their
// wallet cache, verified on-chain (lib/trophy/recent-buys.ts), so the trophy
// picker can show a piece bought since the wallet's last walk (2026-11-10:
// spitehouse stopped at 5 of 6 in Dame Time holding a sixth Lillard the picker
// could not see).
//
// The picker calls this once when it opens on a challenge case and reloads its
// list when `added > 0`. Only the caller's OWN saved wallets are synced; there
// is no wallet parameter.
//
// ⚠ `ok:false` means the sync could not run for at least one wallet — the
// picker keeps the list it already has (a failed sync is never "you have no new
// pieces"). `added` counts rows the writer RETURNED, not rows attempted.

import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-error";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";
import { boundedRead } from "@/lib/api/bounded-read";
import { syncRecentTopShotBuysForWallets } from "@/lib/trophy/recent-buys";

export const dynamic = "force-dynamic";

const ROUTE = "api/profile/trophy-cases/sync-buys";
const MAX_WALLETS = 5;

export async function POST() {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const walletsRes = await boundedRead(
    supabase.from("saved_wallets").select("wallet_addr").eq("user_id", user.id),
    `${ROUTE}/wallets`
  );
  if (walletsRes.error) return apiErrorResponse(walletsRes.error, ROUTE);
  const wallets = [
    ...new Set(
      ((walletsRes.data ?? []) as { wallet_addr: unknown }[])
        .map((r) => (typeof r.wallet_addr === "string" ? r.wallet_addr : null))
        .filter((w): w is string => !!w)
    ),
  ].slice(0, MAX_WALLETS);

  const results = await syncRecentTopShotBuysForWallets(supabase, wallets);
  const failed = results.filter((r) => r.error);
  for (const r of failed) console.warn(`[trophy-cases sync-buys] ${r.wallet}: ${r.error}`);
  const added = results.reduce((n, r) => n + r.added, 0);
  return NextResponse.json({ ok: failed.length === 0, wallets: wallets.length, added });
}
