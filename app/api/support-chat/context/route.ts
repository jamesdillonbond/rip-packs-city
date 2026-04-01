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
        .update({ last_seen_at: new Date().toISOString() })
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

  // ── 2. Daily deal ──────────────────────────────────────────────────────────
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
          const ask = parseFloat(row.low_ask);
          if (!fmv || ask <= 0) return null;
          const discount = ((fmv - ask) / fmv) * 100;
          if (discount < 10) return null;
          const badges: string[] = Array.isArray(row.play_tags)
            ? row.play_tags.map((t: any) => t.title).filter(Boolean)
            : [];
          const confidence = "MEDIUM"; // RPC does not return confidence
          const score =
            discount +
            (badges.length > 0 ? 10 : 0) +
            (confidence === "HIGH" ? 5 : confidence === "MEDIUM" ? 2 : 0);
          return {
            player_name: row.player_name,
            team: row.team,
            tier: tierLabel(row.tier),
            set_name: row.set_name,
            series: seriesLabel(row.series_number),
            low_ask: ask,
            fmv,
            discount_pct: Math.round(row.discount_pct ?? discount),
            badges,
            confidence,
            score,
          };
        })
        .filter(Boolean)
        .sort((a: any, b: any) => b.score - a.score);

      if (scored.length > 0) dailyDeal = scored[0];
    }
  } catch (err) {
    console.error("[context] dailyDeal error:", err);
  }

  // ── 3. Market pulse ────────────────────────────────────────────────────────
  let marketPulse: string | null = null;
  try {
    const { data: pulse } = await supabase.rpc("get_market_pulse");

    if (pulse && pulse.length > 0) {
      const { deals_below_20, deals_below_30, total_tracked } = pulse[0];

      if (deals_below_30 > 0) {
        marketPulse = `${deals_below_30} moment${deals_below_30 !== 1 ? "s" : ""} listed 30%+ below FMV right now`;
      } else if (deals_below_20 > 0) {
        marketPulse = `${deals_below_20} moment${deals_below_20 !== 1 ? "s" : ""} listed 20%+ below FMV right now`;
      } else {
        marketPulse = `${total_tracked} moments tracked — FMV data fresh`;
      }
    }
  } catch (err) {
    console.error("[context] marketPulse error:", err);
  }

  // ── 4. Welcome message ─────────────────────────────────────────────────────
  let pageWelcome = "I can help you find deals, check FMV on any moment, or answer questions about the platform.";
  if (returningUser && lastPlayerSearched) {
    pageWelcome = `Welcome back! Last time you were looking at ${lastPlayerSearched} moments — want me to check for new deals?`;
  } else if (returningUser) {
    pageWelcome = "Welcome back! Want me to surface today's best deals, or is there something specific you're hunting?";
  } else if (dailyDeal) {
    const d = dailyDeal as any;
    pageWelcome = `\u{1F44B} Today's top deal: ${d.player_name} ${d.set_name}, $${d.low_ask} — ${d.discount_pct}% below FMV. Want me to find more?`;
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
