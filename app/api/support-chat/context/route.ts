import { NextRequest, NextResponse } from "next/server";

/* ------------------------------------------------------------------ */
/*  GET /api/support-chat/context                                      */
/*  Returns: { dailyDeal?, marketPulse?, returningUser?, lastTopics? } */
/*  Called by chat widget on open to personalize welcome               */
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

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId") || "";
  const result: {
    dailyDeal: any | null;
    marketPulse: string | null;
    returningUser: boolean;
    lastTopics: string[];
    lastSessionMessages: { role: string; text: string }[];
  } = {
    dailyDeal: null,
    marketPulse: null,
    returningUser: false,
    lastTopics: [],
    lastSessionMessages: [],
  };

  try {
    // ── 1. Daily Deal: best sniper deal right now ──────────────
    const sniperRes = await fetch(
      apiUrl("/api/sniper-feed?rarity=all"),
      { headers: { "User-Agent": "rpc-context/1.0" } }
    );

    if (sniperRes.ok) {
      const sniperData = await sniperRes.json();
      const deals = Array.isArray(sniperData)
        ? sniperData
        : sniperData.deals || [];

      // Find the best deal by discount percentage
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

      // Market pulse: count of deals above 20% discount
      const hotDeals = deals.filter(
        (d: any) => (d.discountPct ?? d.discount_pct ?? 0) >= 20
      ).length;

      if (hotDeals > 0) {
        result.marketPulse = `${hotDeals} moment${hotDeals > 1 ? "s" : ""} listed 20%+ below FMV right now`;
      }
    }

    // ── 2. Returning User: check for previous sessions ────────
    if (sessionId) {
      // Look for any conversations NOT from this session (meaning previous visits)
      // Use a cookie-based persistent ID prefix — sessions starting with same browser fingerprint
      const { data: prevSessions } = await supabase
        .from("support_conversations")
        .select("session_id, category, user_message")
        .neq("session_id", sessionId)
        .order("created_at", { ascending: false })
        .limit(20);

      if (prevSessions && prevSessions.length > 0) {
        result.returningUser = true;

        // Extract topics from previous conversations
        const categories = [
          ...new Set(
            prevSessions
              .map((r: any) => r.category)
              .filter((c: string) => c && c !== "general")
          ),
        ];
        result.lastTopics = categories.slice(0, 3);
      }
    }

    // ── 3. Last Session Messages (for conversation memory) ────
    // Find the most recent previous session and return its last few messages
    if (sessionId) {
      const { data: recentMsgs } = await supabase
        .from("support_conversations")
        .select("user_message, bot_response, session_id")
        .neq("session_id", sessionId)
        .order("created_at", { ascending: false })
        .limit(4);

      if (recentMsgs && recentMsgs.length > 0) {
        // Group by session, take the most recent session's messages
        const lastSession = recentMsgs[0].session_id;
        const lastMsgs = recentMsgs
          .filter((m: any) => m.session_id === lastSession)
          .reverse();

        result.lastSessionMessages = lastMsgs.flatMap((m: any) => [
          { role: "user", text: m.user_message },
          { role: "assistant", text: m.bot_response },
        ]);
      }
    }
  } catch (err: any) {
    console.error("Support context error:", err?.message || err);
  }

  return NextResponse.json(result);
}
