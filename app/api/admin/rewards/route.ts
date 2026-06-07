// app/api/admin/rewards/route.ts
//
// Owner-only rewards operations console. Bearer-gated via RPC_ADMIN_TOKEN (or
// INGEST_SECRET_TOKEN), exactly like the other app/api/admin/* routes. Every
// mutation goes through the service-role client / the SECURITY DEFINER reward
// functions; nothing here is reachable by anon/authenticated users.
//
// GET  → economy summary + user balances + pending redemptions (for the page).
// POST { action, ... } →
//   fulfill       { redemptionId, tx?, note? }   mark a redemption shipped
//   cancel_refund { redemptionId }               refund credits + cancel
//   adjust        { userId, delta, statusDelta, reason }   comp / correct / seed
//   toggle_item   { itemId, active }
//   toggle_rule   { actionKey, active }
//   upsert_item   { item: {...} }                edit / add a shop item
//   upsert_rule   { rule: {...} }                edit / add an earn rule

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { adminAdjust } from "@/lib/rewards";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const ingest = process.env.INGEST_SECRET_TOKEN;
  const admin = process.env.RPC_ADMIN_TOKEN;
  if (ingest && auth === `Bearer ${ingest}`) return true;
  if (admin && auth === `Bearer ${admin}`) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [economy, balances, pending, raffles, draws] = await Promise.all([
    supabase.from("v_rewards_economy").select("*").maybeSingle(),
    supabase
      .from("v_rewards_user_balances")
      .select("*")
      .order("last_activity", { ascending: false })
      .limit(200),
    supabase
      .from("redemptions")
      .select("id,user_id,shop_item_id,cost_credits,status,requested_at,fulfillment")
      .eq("status", "pending")
      .order("requested_at", { ascending: true })
      .limit(200),
    // Raffle shop items (active or not — the raffle item is deactivated pending
    // official rules) + their entry counts, so the console can draw a winner.
    supabase
      .from("shop_items")
      .select("id,sku,name,active,metadata")
      .eq("type", "raffle")
      .order("id", { ascending: true }),
    supabase
      .from("raffle_draws")
      .select("id,shop_item_id,winner_user_id,total_entrants,total_credits,drawn_at")
      .order("drawn_at", { ascending: false })
      .limit(50),
  ]);

  // Decorate pending redemptions with the item name + requester username, plus
  // the resolved fulfillment target so Trevor doesn't have to ask: for moment
  // redemptions the Top Shot username to gift to (override → profile → linked
  // wallet's TS username), and for merch the shipping address on file.
  const pendingRows = pending.data ?? [];
  let decorated = pendingRows as Array<Record<string, unknown>>;
  if (pendingRows.length > 0) {
    const itemIds = [...new Set(pendingRows.map((r) => r.shop_item_id))];
    const userIds = [...new Set(pendingRows.map((r) => r.user_id))];
    const [items, users, profiles, wallets] = await Promise.all([
      supabase.from("shop_items").select("id,name,type").in("id", itemIds),
      supabase.from("v_rewards_user_balances").select("user_id,username").in("user_id", userIds),
      supabase.from("user_profiles").select("id,topshot_username").in("id", userIds),
      supabase.from("saved_wallets").select("user_id,wallet_addr,verified_at,id").in("user_id", userIds),
    ]);

    // Resolve each user's best linked wallet → its Top Shot username. None of
    // our wallets are verified yet, so we ORDER BY verified-preference but never
    // require it (newest saved wallet wins on ties). wallet_usernames stores
    // lowercased addrs/usernames, matching saved_wallets' 0x-lowercase addrs.
    const walletRows = (wallets.data ?? []) as Array<{
      user_id: string; wallet_addr: string; verified_at: string | null; id: number;
    }>;
    const addrs = [...new Set(walletRows.map((w) => String(w.wallet_addr).toLowerCase()))];
    const { data: wuData } = addrs.length
      ? await supabase.from("wallet_usernames").select("wallet_addr,username").in("wallet_addr", addrs)
      : { data: [] as Array<{ wallet_addr: string; username: string }> };
    const wuMap = new Map(
      ((wuData ?? []) as Array<{ wallet_addr: string; username: string }>).map((w) => [
        String(w.wallet_addr).toLowerCase(),
        w.username,
      ])
    );
    const walletUsernameByUser = new Map<string, string>();
    const byUser = new Map<string, typeof walletRows>();
    for (const w of walletRows) {
      const arr = byUser.get(w.user_id) ?? [];
      arr.push(w);
      byUser.set(w.user_id, arr);
    }
    for (const [uid, arr] of byUser) {
      arr.sort((a, b) => {
        const av = a.verified_at ? 1 : 0;
        const bv = b.verified_at ? 1 : 0;
        if (av !== bv) return bv - av;
        if (a.verified_at && b.verified_at && a.verified_at !== b.verified_at) {
          return a.verified_at < b.verified_at ? 1 : -1;
        }
        return b.id - a.id;
      });
      const best = arr[0];
      const uname = best ? wuMap.get(String(best.wallet_addr).toLowerCase()) : undefined;
      if (uname) walletUsernameByUser.set(uid, uname);
    }

    const itemMap = new Map((items.data ?? []).map((i: any) => [i.id, i]));
    const userMap = new Map((users.data ?? []).map((u: any) => [u.user_id, u.username]));
    const tsProfileMap = new Map(
      ((profiles.data ?? []) as Array<{ id: string; topshot_username: string | null }>)
        .filter((p) => p.topshot_username)
        .map((p) => [p.id, p.topshot_username as string])
    );

    decorated = pendingRows.map((r: any) => {
      const fulfillment = (r.fulfillment && typeof r.fulfillment === "object" ? r.fulfillment : {}) as Record<string, unknown>;
      const giftOverride = typeof fulfillment.gift_to === "string" ? (fulfillment.gift_to as string) : null;
      const ts_username =
        giftOverride ?? tsProfileMap.get(r.user_id) ?? walletUsernameByUser.get(r.user_id) ?? null;
      return {
        ...r,
        item_name: itemMap.get(r.shop_item_id)?.name ?? `Item #${r.shop_item_id}`,
        item_type: itemMap.get(r.shop_item_id)?.type ?? null,
        username: userMap.get(r.user_id) ?? null,
        ts_username,
        ship_to: fulfillment.ship_to ?? null,
      };
    });
  }

  // Count entries per raffle so the console can show "N entries" before a draw.
  const raffleRows = (raffles.data ?? []) as Array<Record<string, unknown>>;
  let raffleDecorated = raffleRows;
  if (raffleRows.length > 0) {
    const raffleIds = raffleRows.map((r) => r.id);
    const { data: entries } = await supabase
      .from("raffle_entries")
      .select("shop_item_id")
      .in("shop_item_id", raffleIds);
    const counts = new Map<number, number>();
    for (const e of (entries ?? []) as Array<{ shop_item_id: number }>) {
      counts.set(e.shop_item_id, (counts.get(e.shop_item_id) ?? 0) + 1);
    }
    raffleDecorated = raffleRows.map((r: any) => ({ ...r, entry_count: counts.get(r.id) ?? 0 }));
  }

  return NextResponse.json({
    economy: economy.data ?? null,
    balances: balances.data ?? [],
    pending: decorated,
    raffles: raffleDecorated,
    draws: draws.data ?? [],
  });
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = String(body?.action ?? "");

  try {
    switch (action) {
      case "fulfill": {
        const redemptionId = Number(body?.redemptionId);
        if (!Number.isInteger(redemptionId)) {
          return NextResponse.json({ error: "bad redemptionId" }, { status: 400 });
        }
        // Use the SECDEF fulfill_redemption RPC instead of a raw status flip:
        // for a pro/cosmetic that somehow stayed pending it actually DELIVERS
        // (grants Pro / equips the cosmetic); for moment/merch it just marks
        // shipped with the tx/note, same as before.
        const { data, error } = await (supabase as any).rpc("fulfill_redemption", {
          p_redemption_id: redemptionId,
          p_tx: body?.tx ?? null,
          p_note: body?.note ?? null,
          p_admin: "owner",
        });
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        if (data?.ok === false) {
          return NextResponse.json({ error: data.error ?? "fulfill failed" }, { status: 400 });
        }
        return NextResponse.json({ ok: true, result: data });
      }

      case "draw_raffle": {
        const shopItemId = Number(body?.shopItemId);
        if (!Number.isInteger(shopItemId)) {
          return NextResponse.json({ error: "bad shopItemId" }, { status: 400 });
        }
        const { data, error } = await (supabase as any).rpc("draw_raffle", {
          p_shop_item_id: shopItemId,
          p_admin: "owner",
        });
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        if (data?.ok === false) {
          return NextResponse.json({ error: data.error ?? "draw failed" }, { status: 400 });
        }
        return NextResponse.json({ ok: true, result: data });
      }

      case "cancel_refund": {
        const redemptionId = Number(body?.redemptionId);
        if (!Number.isInteger(redemptionId)) {
          return NextResponse.json({ error: "bad redemptionId" }, { status: 400 });
        }
        // Load the row first so we know who to refund and how much.
        const { data: row, error: readErr } = await supabase
          .from("redemptions")
          .select("id,user_id,cost_credits,status")
          .eq("id", redemptionId)
          .maybeSingle();
        if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
        if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
        if (row.status !== "pending") {
          return NextResponse.json({ error: `cannot refund a ${row.status} redemption` }, { status: 400 });
        }
        // Refund the credits (status unchanged), then mark the redemption refunded.
        const adj = await adminAdjust(
          row.user_id,
          row.cost_credits,
          0,
          `refund:redemption:${redemptionId}`
        );
        if (adj?.ok === false) {
          return NextResponse.json({ error: adj.error ?? "refund failed" }, { status: 500 });
        }
        const { error: updErr } = await supabase
          .from("redemptions")
          .update({ status: "refunded", updated_at: new Date().toISOString() })
          .eq("id", redemptionId);
        if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      case "adjust": {
        const userId = String(body?.userId ?? "");
        const delta = Number(body?.delta ?? 0);
        const statusDelta = Number(body?.statusDelta ?? 0);
        const reason = String(body?.reason ?? "").trim();
        if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });
        if (!Number.isInteger(delta) || !Number.isInteger(statusDelta)) {
          return NextResponse.json({ error: "delta/statusDelta must be integers" }, { status: 400 });
        }
        if (!reason) return NextResponse.json({ error: "reason required" }, { status: 400 });
        const result = await adminAdjust(userId, delta, statusDelta, reason);
        if (result?.ok === false) {
          return NextResponse.json({ error: result.error }, { status: 500 });
        }
        return NextResponse.json({ ok: true, result });
      }

      case "toggle_item": {
        const itemId = Number(body?.itemId);
        const active = !!body?.active;
        if (!Number.isInteger(itemId)) {
          return NextResponse.json({ error: "bad itemId" }, { status: 400 });
        }
        const { error } = await supabase
          .from("shop_items")
          .update({ active, updated_at: new Date().toISOString() })
          .eq("id", itemId);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      case "toggle_rule": {
        const actionKey = String(body?.actionKey ?? "");
        const active = !!body?.active;
        if (!actionKey) return NextResponse.json({ error: "actionKey required" }, { status: 400 });
        const { error } = await supabase
          .from("points_rules")
          .update({ active, updated_at: new Date().toISOString() })
          .eq("action_key", actionKey);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      case "upsert_item": {
        const item = body?.item;
        if (!item || typeof item !== "object") {
          return NextResponse.json({ error: "item object required" }, { status: 400 });
        }
        const { error } = await supabase
          .from("shop_items")
          .upsert({ ...item, updated_at: new Date().toISOString() }, { onConflict: "sku" });
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      case "upsert_rule": {
        const rule = body?.rule;
        if (!rule || typeof rule !== "object" || !rule.action_key) {
          return NextResponse.json({ error: "rule object with action_key required" }, { status: 400 });
        }
        const { error } = await supabase
          .from("points_rules")
          .upsert({ ...rule, updated_at: new Date().toISOString() }, { onConflict: "action_key" });
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[admin/rewards] fatal: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
