// app/api/admin/click-purchases/route.ts
//
// GET /api/admin/click-purchases?days=30
// Authorization: Bearer <RPC_ADMIN_TOKEN | INGEST_SECRET_TOKEN>
//
// Backs /admin/click-purchases (audit_20260930): RPC → marketplace clicks and the
// PRESUMED purchases that followed them (public.attribute_outbound_clicks →
// click_attributed_purchases, rolled up by click_purchase_funnel_daily). Both
// objects are service_role-only.
//
// ⚠ Every read FAILS the request rather than degrading — a failed funnel read
// rendered as "0 purchases" is the failed-read-as-answer class. A purchases list
// that hit its row cap says so (`purchases_truncated`) instead of under-summing.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const PURCHASE_CAP = 500;

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const ingest = process.env.INGEST_SECRET_TOKEN;
  const admin = process.env.RPC_ADMIN_TOKEN;
  if (ingest && auth === `Bearer ${ingest}`) return true;
  if (admin && auth === `Bearer ${admin}`) return true;
  return false;
}

export interface FunnelRow {
  day_pt: string;
  source: string;
  surface: string;
  collection_slug: string;
  clicks: number;
  clicks_human: number;
  clicks_internal: number;
  purchases_confirmed: number;
  purchases_likely: number;
  purchases_possible: number;
  sales_confirmed_or_likely: number;
  usd_confirmed_or_likely: number;
}

export interface PurchaseRow {
  click_id: number;
  clicked_at: string;
  collection_slug: string;
  sale_source: string;
  sale_ref: string;
  nft_id: string | null;
  sold_at: string;
  price_usd: number | null;
  match: "same_moment" | "same_edition";
  confidence: "confirmed" | "likely" | "possible";
  buyer_is_clicker: boolean;
  minutes_after_click: number;
  surface: string | null;
  source: string | null;
  channel: string | null;
  player_name: string | null;
  set_name: string | null;
  ask_price_usd: number | null;
  /** The click came from an internal_accounts user (founder / brand / QA): not traction. */
  internal: boolean;
}

const CONF_RANK: Record<string, number> = { confirmed: 3, likely: 2, possible: 1 };

/**
 * Headline purchase counts, per SALE and EXTERNAL only (2026-10-03).
 *
 * The totals used to be the view's per-CLICK counts summed: two taps on one alert
 * (Trevor, Jarrett Jack #8982, 10-01) read as two confirmed purchases. And every
 * confirmed purchase so far was the founder's own — internal_accounts are excluded
 * from traction everywhere else (CLAUDE.md), so they are counted apart here too.
 * A sale clicked by both an internal and an external user counts as external.
 */
export function purchaseTotals(purchases: PurchaseRow[]) {
  const ext = new Map<string, PurchaseRow>();
  const int = new Map<string, PurchaseRow>();
  for (const p of purchases) {
    const key = `${p.sale_source}:${p.sale_ref}`;
    const m = p.internal ? int : ext;
    const cur = m.get(key);
    if (!cur || (CONF_RANK[p.confidence] ?? 0) > (CONF_RANK[cur.confidence] ?? 0)) m.set(key, p);
  }
  for (const k of ext.keys()) int.delete(k);
  const count = (m: Map<string, PurchaseRow>, c: string) => [...m.values()].filter((p) => p.confidence === c).length;
  const usd = (m: Map<string, PurchaseRow>) =>
    Math.round([...m.values()].filter((p) => p.confidence !== "possible").reduce((a, p) => a + (p.price_usd ?? 0), 0) * 100) / 100;
  return {
    purchases_confirmed: count(ext, "confirmed"),
    purchases_likely: count(ext, "likely"),
    purchases_possible: count(ext, "possible"),
    sales_confirmed_or_likely: count(ext, "confirmed") + count(ext, "likely"),
    usd_confirmed_or_likely: usd(ext),
    purchases_internal: int.size,
    usd_internal: usd(int),
  };
}

/** PT calendar date `days` ago, as YYYY-MM-DD (the view's day_pt is a PT date). */
export function ptDateDaysAgo(days: number, now: Date = new Date()): string {
  const d = new Date(now.getTime() - days * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const raw = Number(req.nextUrl?.searchParams?.get("days") ?? 30);
  const days = Number.isFinite(raw) ? Math.min(Math.max(Math.round(raw), 1), 90) : 30;
  const sinceDay = ptDateDaysAgo(days);
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const sb = supabaseAdmin as any;

  try {
    const [funnelRes, purchRes, internalRes] = await Promise.all([
      sb.from("click_purchase_funnel_daily").select("*").gte("day_pt", sinceDay).order("day_pt", { ascending: false }).limit(1000),
      sb
        .from("click_attributed_purchases")
        .select(
          "click_id, clicked_at, collection_slug, sale_source, sale_ref, nft_id, sold_at, price_usd, match, confidence, buyer_is_clicker, minutes_after_click, outbound_clicks(surface, source, channel, player_name, set_name, ask_price_usd, user_id)"
        )
        .gte("clicked_at", sinceIso)
        .order("clicked_at", { ascending: false })
        .limit(PURCHASE_CAP),
      sb.from("internal_accounts").select("user_id").limit(1000),
    ]);
    if (funnelRes.error) throw new Error(`click_purchase_funnel_daily: ${funnelRes.error.message}`);
    if (purchRes.error) throw new Error(`click_attributed_purchases: ${purchRes.error.message}`);
    // A failed internal read would move the founder's buys into traction — fail, never guess.
    if (internalRes.error) throw new Error(`internal_accounts: ${internalRes.error.message}`);
    const internalIds = new Set<string>(((internalRes.data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));

    const funnel = (funnelRes.data ?? []).map((r: any) => ({
      ...r,
      clicks: Number(r.clicks), clicks_human: Number(r.clicks_human), clicks_internal: Number(r.clicks_internal),
      purchases_confirmed: Number(r.purchases_confirmed), purchases_likely: Number(r.purchases_likely),
      purchases_possible: Number(r.purchases_possible), sales_confirmed_or_likely: Number(r.sales_confirmed_or_likely),
      usd_confirmed_or_likely: Number(r.usd_confirmed_or_likely),
    })) as FunnelRow[];

    const purchases: PurchaseRow[] = (purchRes.data ?? []).map((r: any) => {
      const c = r.outbound_clicks ?? {};
      return {
        click_id: r.click_id, clicked_at: r.clicked_at, collection_slug: r.collection_slug, sale_source: r.sale_source,
        sale_ref: r.sale_ref, nft_id: r.nft_id, sold_at: r.sold_at,
        price_usd: r.price_usd == null ? null : Number(r.price_usd), match: r.match, confidence: r.confidence,
        buyer_is_clicker: !!r.buyer_is_clicker, minutes_after_click: r.minutes_after_click,
        surface: c.surface ?? null, source: c.source ?? null, channel: c.channel ?? null,
        player_name: c.player_name ?? null, set_name: c.set_name ?? null,
        ask_price_usd: c.ask_price_usd == null ? null : Number(c.ask_price_usd),
        internal: typeof c.user_id === "string" && internalIds.has(c.user_id),
      };
    });

    const sum = (k: keyof FunnelRow) => funnel.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const pt = purchaseTotals(purchases);

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      days,
      since_day_pt: sinceDay,
      totals: {
        clicks: sum("clicks"),
        clicks_human: sum("clicks_human"),
        clicks_internal: sum("clicks_internal"),
        ...pt,
      },
      purchases_truncated: purchases.length >= PURCHASE_CAP,
      funnel,
      purchases,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
