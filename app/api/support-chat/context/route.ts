// app/api/support-chat/context/route.ts
// Provides pre-load context for the chat widget on open.
// Returns: dailyDeal, marketPulse, returningUser, returningBetaTester,
// conversationCount, lastTopics, lastPlayerSearched, lastOpenFeedback,
// pageWelcome, pageSuggestions.

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

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  const ownerKey = req.nextUrl.searchParams.get("ownerKey");
  // Beta posture: market-status / movers / dailyDeal are NOT included by default.
  // The chat widget no longer auto-fires a market-pulse follow-up message after
  // the greeting, and the bot can fetch live market data via its existing tools
  // when the user asks for deals. To opt back in (e.g. for an explicit "market
  // pulse" widget), pass includeMarketStatus=true.
  const includeMarketStatus =
    req.nextUrl.searchParams.get("includeMarketStatus") === "true";

  // ── 1. Per-session continuity (chat_sessions) ──────────────────────────────
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
          ...(ownerKey ? { owner_key: ownerKey } : {}),
        })
        .eq("session_id", sessionId);
    } else {
      await supabase.from("chat_sessions").upsert(
        {
          session_id: sessionId,
          last_seen_at: new Date().toISOString(),
          first_seen_at: new Date().toISOString(),
          conversation_count: 1,
          ...(ownerKey ? { owner_key: ownerKey } : {}),
        },
        { onConflict: "session_id" }
      );
    }
  }

  // ── 1b. Cross-session continuity for signed-in beta testers ────────────────
  // When ownerKey is present, override conversationCount with the owner_key
  // total (cross-session) so a returning beta tester sees a warm welcome
  // even on a fresh sessionStorage. Also surface their most recent open
  // feedback row from beta_feedback_inbox.
  let returningBetaTester = false;
  let lastOpenFeedback: {
    id: number;
    feedback_type: string | null;
    feedback_summary: string | null;
    feedback_status: string | null;
    created_at: string | null;
  } | null = null;
  if (ownerKey) {
    try {
      const { count } = await supabase
        .from("support_conversations")
        .select("*", { count: "exact", head: true })
        .eq("owner_key", ownerKey);
      if (typeof count === "number") {
        conversationCount = count;
        returningBetaTester = count > 0;
      }
    } catch (err) {
      console.error("[context] cross-session count error:", err);
    }
    try {
      const { data: feedbackRow } = await supabase
        .from("beta_feedback_inbox")
        .select("id, feedback_type, feedback_summary, feedback_status, created_at")
        .eq("owner_key", ownerKey)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (feedbackRow) lastOpenFeedback = feedbackRow;
    } catch (err) {
      console.error("[context] last open feedback lookup error:", err);
    }
  }

  // ── 2 + 3. Market context (gated behind includeMarketStatus) ───────────────
  // During beta the chat opens with a personalized greeting only — no
  // auto-firing market-pulse / dailyDeal follow-up. The bot still has live
  // market tools (search_live_deals, get_fmv) and uses them when the user asks.
  let dailyDeal: object | null = null;
  let marketPulse: string | null = null;

  if (includeMarketStatus) {
    try {
      const base =
        process.env.NEXT_PUBLIC_SITE_URL ||
        (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://www.rippackscity.com");
      const sniperRes = await fetch(
        `${base}/api/sniper-feed?limit=1&minDiscount=15&sortBy=discount`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (sniperRes.ok) {
        const sniperData = await sniperRes.json();
        const deals = sniperData.deals ?? [];
        if (deals.length > 0) {
          const d = deals[0];
          dailyDeal = {
            player_name: d.playerName,
            low_ask: d.askPrice,
            discount_pct: Math.round(d.discount),
            tier: tierLabel(d.tier ?? "COMMON"),
            source: d.source ?? "topshot",
            set_name: d.setName,
            series: d.seriesName ?? null,
            fmv: d.adjustedFmv ?? d.baseFmv,
            buy_url: d.buyUrl ?? null,
          };
        }
      }
    } catch (err) {
      console.error("[context] dailyDeal sniper-feed error:", err);
    }

    if (!dailyDeal) {
      try {
        const { data: fallbackRows } = await supabase
          .from("cached_listings")
          .select("player_name, set_name, series_name, tier, ask_price, fmv, discount, badge_slugs, buy_url")
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
            series: r.series_name ?? null,
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

    try {
      const { data: movers } = await supabase.rpc("get_fmv_movers", {
        lookback_interval: "24 hours",
        min_fmv: 2,
        limit_count: 3,
      });
      if (movers && movers.length > 0) {
        const hot = movers.filter((m: any) => m.pct_change > 20);
        if (hot.length > 0) {
          const moverStr = hot
            .map((m: any) => `${m.player_name} up ${Math.round(m.pct_change)}% today`)
            .join(", ");
          marketPulse = (marketPulse ?? "Market active") + ` · \u{1F525} ${moverStr}`;
        }
      }
    } catch (err) {
      console.error("[context] fmv_movers error:", err);
    }

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
  }

  // ── 4. Welcome message + page suggestions (beta posture) ───────────────────
  // The bot's static welcome is rendered client-side in SupportChat for instant
  // paint; this pageWelcome is a server-side fallback for clients that consume
  // the field. We keep it terse and beta-flavored so it can't override the
  // client-side voice.
  const pageContext = req.nextUrl.searchParams.get("pageContext") ?? req.nextUrl.searchParams.get("page") ?? "";

  let pageWelcome = "Closed beta — I'm here for support, Q&A, and feedback for Trevor. Deals and FMV too if you want.";
  if (returningBetaTester && lastOpenFeedback?.feedback_summary) {
    const status = String(lastOpenFeedback.feedback_status ?? "new");
    if (status === "shipped") {
      pageWelcome = `Welcome back. Your feedback "${lastOpenFeedback.feedback_summary}" shipped — thanks for the catch.`;
    } else if (status === "in_progress") {
      pageWelcome = `Welcome back. Your feedback "${lastOpenFeedback.feedback_summary}" is in progress.`;
    } else {
      pageWelcome = `Welcome back. Your last feedback "${lastOpenFeedback.feedback_summary}" is still in the queue.`;
    }
  } else if (returningUser && lastPlayerSearched) {
    pageWelcome = `Welcome back. Last time you were looking at ${lastPlayerSearched} — anything to follow up on, or something new?`;
  }

  // Beta-flavored suggestions. Return the same shape SupportChat already
  // expects; the client-side PAGE_DEFAULTS map provides per-page fallbacks
  // before this fetch lands, so these can stay generic.
  const suggestions = returningBetaTester
    ? ["Report a bug", "Suggest a feature", "Share feedback", "Find me a deal"]
    : ["Report a bug", "Suggest a feature", "Something looks off", "How does X work?"];

  return NextResponse.json({
    dailyDeal,
    marketPulse,
    returningUser,
    returningBetaTester,
    conversationCount,
    lastTopics,
    lastPlayerSearched,
    lastOpenFeedback,
    pageWelcome,
    pageSuggestions: suggestions,
  });
}
