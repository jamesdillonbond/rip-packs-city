import { NextRequest, NextResponse } from "next/server";

/* ------------------------------------------------------------------ */
/*  GET /api/support-chat/context                                      */
/*  Query: sessionId, pageContext                                      */
/*  Returns: { dailyDeal?, marketPulse?, returningUser?, lastTopics?,  */
/*             pageWelcome?, pageSuggestions? }                         */
/* ------------------------------------------------------------------ */

import { createClient } from "@supabase/supabase-js";
const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function apiUrl(path: string) {
  if (path.startsWith("http")) return path;
  const base =
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "https://rip-packs-city.vercel.app");
  return `${base}${path}`;
}

// ── Page-specific welcome messages and quick action suggestions ───
const PAGE_WELCOMES: Record<string, { welcome: string; suggestions: string[] }> = {
  sniper: {
    welcome: "Looking for a deal? Tell me a player, budget, or tier and I'll search the live feed for you.",
    suggestions: ["Best deals right now", "Rare moments under $20", "Find me a LeBron deal", "What badges are hot?"],
  },
  badges: {
    welcome: "Want to know which badges are most valuable, or check what badges a specific player has? I can look it up.",
    suggestions: ["Most valuable badges?", "Rookie Year moments under $15", "Check badges for Wembanyama", "What is Top Shot Debut?"],
  },
  wallet: {
    welcome: "I can help analyze your collection — find undervalued moments, suggest what to sell, or check set completion.",
    suggestions: ["Analyze my portfolio", "What should I sell?", "My most undervalued moment?", "What sets am I close to completing?"],
  },
  sets: {
    welcome: "Looking to complete a set or find the cheapest missing pieces? I can help with that.",
    suggestions: ["Cheapest set to complete?", "What's in Run It Back?", "Best investment sets?", "Show me S8 sets"],
  },
  packs: {
    welcome: "Curious about pack value? I can explain expected value calculations and help you decide if a pack is worth it.",
    suggestions: ["Are packs worth buying?", "How does Pack EV work?", "Best value pack right now?", "What's inside the latest drop?"],
  },
  collection: {
    welcome: "I can help you explore your collection, find deals, or answer any questions about the platform.",
    suggestions: ["Find me deals under $10", "How is FMV calculated?", "What are badges?", "Show me top discounts"],
  },
  overview: {
    welcome: "I can help you find deals, check FMV on any moment, or answer questions about the platform.",
    suggestions: ["Find me deals under $10", "How does the sniper work?", "What are badges?", "Best Rare moments right now"],
  },
};

const DEFAULT_PAGE = {
  welcome: "I can help you find deals, check FMV on any moment, or answer questions about the platform.",
  suggestions: ["Find me deals under $10", "How is FMV calculated?", "What are badges?", "Show me top discounts"],
};

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId") || "";
  const pageContext = req.nextUrl.searchParams.get("pageContext") || "";

  // Extract page name from pageContext like "sniper (nba-top-shot)"
  const pageName = pageContext.split("(")[0].trim().toLowerCase();

  const result: {
    dailyDeal: any | null;
    marketPulse: string | null;
    returningUser: boolean;
    lastTopics: string[];
    pageWelcome: string;
    pageSuggestions: string[];
  } = {
    dailyDeal: null,
    marketPulse: null,
    returningUser: false,
    lastTopics: [],
    pageWelcome: (PAGE_WELCOMES[pageName] || DEFAULT_PAGE).welcome,
    pageSuggestions: (PAGE_WELCOMES[pageName] || DEFAULT_PAGE).suggestions,
  };

  try {
    // ── 1. Daily Deal ─────────────────────────────────────────
    const sniperRes = await fetch(
      apiUrl("/api/sniper-feed?rarity=all"),
      { headers: { "User-Agent": "rpc-context/1.0" } }
    );

    if (sniperRes.ok) {
      const sniperData = await sniperRes.json();
      const deals = Array.isArray(sniperData)
        ? sniperData
        : sniperData.deals || [];

      const bestDeal = deals
        .filter((d: any) => (d.discountPct ?? d.discount_pct ?? 0) > 10)
        .sort(
          (a: any, b: any) =>
            (b.discountPct ?? b.discount_pct ?? 0) -
            (a.discountPct ?? a.discount_pct ?? 0)
        )[0];

      if (bestDeal) {
        result.dailyDeal = {
          playerName: bestDeal.playerName || bestDeal.player_name,
          setName: bestDeal.setName || bestDeal.set_name,
          tier: bestDeal.tier || bestDeal.rarity,
          price: bestDeal.price,
          fmv: bestDeal.fmv,
          discountPct: bestDeal.discountPct ?? bestDeal.discount_pct,
          source: bestDeal.source,
          buyUrl: bestDeal.buyUrl ?? bestDeal.buy_url ?? bestDeal.purchaseURL,
        };
      }

      const hotDeals = deals.filter(
        (d: any) => (d.discountPct ?? d.discount_pct ?? 0) >= 20
      ).length;

      if (hotDeals > 0) {
        result.marketPulse = `${hotDeals} moment${hotDeals > 1 ? "s" : ""} listed 20%+ below FMV right now`;
      }
    }

    // ── 2. Returning User ─────────────────────────────────────
    if (sessionId) {
      const { data: prevSessions } = await supabase
        .from("support_conversations")
        .select("session_id, category, user_message")
        .neq("session_id", sessionId)
        .order("created_at", { ascending: false })
        .limit(20);

      if (prevSessions && prevSessions.length > 0) {
        result.returningUser = true;
        const categories: string[] = [
          ...new Set<string>(
            prevSessions
              .map((r: any) => r.category as string)
              .filter((c: string) => c && c !== "general")
          ),
        ];
        result.lastTopics = categories.slice(0, 3);
      }
    }
  } catch (err: any) {
    console.error("Support context error:", err?.message || err);
  }

  return NextResponse.json(result);
}
