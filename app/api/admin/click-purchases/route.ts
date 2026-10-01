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
    const [funnelRes, purchRes] = await Promise.all([
      sb.from("click_purchase_funnel_daily").select("*").gte("day_pt", sinceDay).order("day_pt", { ascending: false }).limit(1000),
      sb
        .from("click_attributed_purchases")
        .select(
          "click_id, clicked_at, collection_slug, sale_source, sale_ref, nft_id, sold_at, price_usd, match, confidence, buyer_is_clicker, minutes_after_click, outbound_clicks(surface, source, channel, player_name, set_name, ask_price_usd)"
        )
        .gte("clicked_at", sinceIso)
        .order("clicked_at", { ascending: false })
        .limit(PURCHASE_CAP),
    ]);
    if (funnelRes.error) throw new Error(`click_purchase_funnel_daily: ${funnelRes.error.message}`);
    if (purchRes.error) throw new Error(`click_attributed_purchases: ${purchRes.error.message}`);

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
      };
    });

    const sum = (k: keyof FunnelRow) => funnel.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    // Dollars: each SALE once, however many clicks preceded it (and however many
    // surface/day groups it would otherwise be summed in).
    const seen = new Set<string>();
    let usd = 0;
    for (const p of purchases) {
      if (p.confidence === "possible") continue;
      const key = `${p.sale_source}:${p.sale_ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      usd += p.price_usd ?? 0;
    }

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      days,
      since_day_pt: sinceDay,
      totals: {
        clicks: sum("clicks"),
        clicks_human: sum("clicks_human"),
        clicks_internal: sum("clicks_internal"),
        purchases_confirmed: sum("purchases_confirmed"),
        purchases_likely: sum("purchases_likely"),
        purchases_possible: sum("purchases_possible"),
        sales_confirmed_or_likely: seen.size,
        usd_confirmed_or_likely: Math.round(usd * 100) / 100,
      },
      purchases_truncated: purchases.length >= PURCHASE_CAP,
      funnel,
      purchases,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
