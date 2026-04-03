// app/api/support-chat/context/route.ts
// Provides pre-load context for the chat widget on open.
// Returns: dailyDeal, marketPulse, returningUser, lastTopics for session continuity.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 10;
export const revalidate = 300; // cache 5 min

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function tierLabel(raw: string): string {
  return (
    raw.replace("MOMENT_TIER_", "").charAt(0).toUpperCase() +
    raw.replace("MOMENT_TIER_", "").slice(1).toLowerCase()
  );
}

function seriesLabel(n: number): string {
  const map: Record<number, string> = {
    0: "Beta", 1: "S1", 2: "S2", 3: "S3", 4: "S4",
    5: "S5", 6: "S6", 7: "S7", 8: "S8",
  };
  return map[n] ?? `S${n}`;
}

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");

  // ── 1. Returning user detection ────────────────────────────────────────────
  let returningUser = false;
  let lastTopics: string[] = [];
  let lastPlayerSearched: string | null = null;
  let conversationCount = 0;

  if (sessionId) {
    const { data: session } = await supabase
      .from("chat_sessions")
      .select("last_topics, last_player_searched, conversation_count, last_seen_at")
      .eq("session_id", sessionId)
      .maybeSingle();

    if (session) {
      returningUser = true;
      lastTopics = session.last_topics ?? [];
      lastPlayerSearched = session.last_player_searched ?? null;
      conversationCount = session.conversation_count ?? 1;

      await supabase
        .from("chat_sessions")
        .update({
          last_seen_at: new Date().toISOString(),
          conversation_count: (session.conversation_count ?? 1) + 1,
        })
        .eq("session_id", sessionId);
    } else {
      await supabase.from("chat_sessions").upsert(
        {
          session_id: sessionId,
          last_seen_at: new Date().toISOString(),
          first_seen_at: new Date().toISOString(),
          conversation_count: 1,
        },
        { onConflict: "session_id" }
      );
    }
  }

  // ── 2. Daily deal (via get_top_deals RPC, fallback to direct query) ─────────
  let dailyDeal: object | null = null;
  try {
    const { data: dealRows } = await supabase.rpc("get_top_deals", {
      p_player: null,
      p_team: null,
      p_tier: null,
      p_max_price: 50,
      p_min_discount: 10,
      p_has_badge: false,
      p_limit: 8,
    });

    if (dealRows && dealRows.length > 0) {
      const scored = dealRows
        .map((row: any) => {
          const fmv = parseFloat(row.fmv_usd ?? "0");
          const ask = parseFloat(row.low_ask ?? "0");
          if (!fmv || ask <= 0) return null;
          const discount = row.discount_pct ?? ((fmv - ask) / fmv) * 100;
          const badges: string[] = Array.isArray(row.play_tags)
            ? row.play_tags.map((t: any) => t.title ?? t).filter(Boolean)
            : [];
          const score =
            discount +
            (badges.length > 0 ? 10 : 0);
          return {
            player_name: row.player_name,
            team: row.team ?? null,
            tier: tierLabel(row.tier),
            set_name: row.set_name,
            series: seriesLabel(row.series_number),
            low_ask: ask,
            fmv,
            discount_pct: Math.round(discount),
            badges,
            external_id: row.external_id,
            score,
          };
        })
        .filter(Boolean)
        .sort((a: any, b: any) => b.score - a.score);

      if (scored.length > 0) dailyDeal = scored[0];
    }
  } catch (err) {
    console.error("[context] dailyDeal RPC error:", err);
  }

  // Fallback: direct cached_listings + fmv_snapshots join if RPC returned nothing
  if (!dailyDeal) {
    try {
      const { data: fallbackRows } = await supabase
        .from("cached_listings")
        .select("player_name, set_name, tier, ask_price, fmv, discount, badge_slugs, buy_url")
        .gt("discount", 10)
        .not("fmv", "is", null)
        .lt("ask_price", 500)
        .order("discount", { ascending: false })
        .limit(1);
      if (fallbackRows && fallbackRows.length > 0) {
        const r = fallbackRows[0];
        dailyDeal = {
          player_name: r.player_name,
          tier: tierLabel(r.tier ?? "COMMON"),
          set_name: r.set_name,
          low_ask: Number(r.ask_price),
          fmv: Number(r.fmv),
          discount_pct: Math.round(Number(r.discount)),
          badges: r.badge_slugs ?? [],
          buy_url: r.buy_url ?? null,
        };
      }
    } catch (err) {
      console.error("[context] dailyDeal fallback error:", err);
    }
  }

  // ── 3. Market pulse (via get_market_pulse RPC, fallback to direct count) ────
  let marketPulse: string | null = null;
  try {
    const { data: pulse } = await supabase.rpc("get_market_pulse");
    const { deals_below_20, deals_below_30, total_tracked } = pulse?.[0] ?? {};

    if (deals_below_30 && deals_below_30 > 0) {
      marketPulse = `${deals_below_30} moment${deals_below_30 !== 1 ? "s" : ""} listed 30%+ below FMV right now`;
    } else if (deals_below_20 && deals_below_20 > 0) {
      marketPulse = `${deals_below_20} moment${deals_below_20 !== 1 ? "s" : ""} listed 20%+ below FMV right now`;
    } else if (total_tracked) {
      marketPulse = `${total_tracked} moments tracked — FMV data fresh`;
    }
  } catch (err) {
    console.error("[context] marketPulse RPC error:", err);
  }

  // Fallback: direct count from cached_listings if RPC returned nothing
  if (!marketPulse) {
    try {
      const { count } = await supabase
        .from("cached_listings")
        .select("*", { count: "exact", head: true })
        .gte("discount", 30);
      if (count && count > 0) {
        marketPulse = `${count} moment${count !== 1 ? "s" : ""} listed 30%+ below FMV right now`;
      }
    } catch (err) {
      console.error("[context] marketPulse fallback error:", err);
    }
  }

  // ── 4. Welcome message (page-aware) ────────────────────────────────────────
  const pageContext = req.nextUrl.searchParams.get("page") ?? "";
  const dealSnippet = dailyDeal
    ? `Top deal: ${(dailyDeal as any).player_name} ${(dailyDeal as any).set_name}, $${(dailyDeal as any).low_ask} — ${(dailyDeal as any).discount_pct}% below FMV.`
    : null;

  let pageWelcome = "I can help you find deals, check FMV on any moment, or answer questions about the platform.";

  if (returningUser && lastPlayerSearched) {
    pageWelcome = `Welcome back! Last time you were looking at ${lastPlayerSearched} moments — want me to check for new deals?`;
  } else if (returningUser) {
    pageWelcome = "Welcome back! Want me to surface today's best deals, or is there something specific you're hunting?";
  } else if (pageContext.includes("sniper") && dealSnippet) {
    pageWelcome = `\u{1F525} ${dealSnippet} Want me to find more?`;
  } else if (pageContext.includes("sniper")) {
    pageWelcome = "The sniper feed shows live deals below FMV. I can help you filter or find specific players.";
  } else if (pageContext.includes("collection")) {
    pageWelcome = "Connect your wallet to see your portfolio FMV and near-complete sets. I can analyze any wallet — just paste a username.";
  } else if (pageContext.includes("market")) {
    pageWelcome = "Browse the full marketplace here. Try filtering by badge type or discount to find value." + (dealSnippet ? ` ${dealSnippet}` : "");
  } else if (pageContext.includes("sets")) {
    pageWelcome = "I can find the cheapest path to completing your nearest set. Paste your username and I'll check.";
  } else if (pageContext.includes("packs")) {
    pageWelcome = "Check the EV calculator to find the best-value packs. I can compare pack EVs if you need help deciding.";
  } else if (pageContext.includes("overview")) {
    pageWelcome = "Welcome to RPC — your collector intel hub. Sniper finds deals, Collection analyzes your wallet, and Market lets you browse everything." + (dealSnippet ? ` ${dealSnippet}` : "");
  } else if (dealSnippet) {
    pageWelcome = `\u{1F44B} ${dealSnippet} Want me to find more?`;
  }

  const suggestions =
    returningUser && lastPlayerSearched
      ? [`Find me ${lastPlayerSearched} deals`, "Show top discounts right now", "How is FMV calculated?", "What are badges?"]
      : ["Find me deals under $10", "Show top discounts right now", "How is FMV calculated?", "What are badges?"];

  return NextResponse.json({
    dailyDeal,
    marketPulse,
    returningUser,
    conversationCount,
    lastTopics,
    lastPlayerSearched,
    pageWelcome,
    pageSuggestions: suggestions,
  });
}
