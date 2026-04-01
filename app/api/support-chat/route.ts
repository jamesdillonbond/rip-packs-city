// app/api/support-chat/route.ts
// POST /api/support-chat
// Body: { message, sessionId, userWallet?, pageContext?, walletConnected?, conversationHistory?, marketPulse?, dailyDeal? }
// Returns: { response, escalated, escalationReason?, category }

export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// ── Rate limiting (25 req/hr per session) ─────────────────────────────────────
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(sessionId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(sessionId);
  if (!entry || entry.resetAt < now) {
    rateLimitMap.set(sessionId, { count: 1, resetAt: now + 3600_000 });
    return true;
  }
  if (entry.count >= 25) return false;
  entry.count++;
  return true;
}

function siteUrl() {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://rip-packs-city.vercel.app")
  );
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_live_deals",
    description: "Search for live NBA Top Shot deals from the RPC sniper feed. Use this first for any shopping query. Returns real listings with prices, FMV discounts, and buy links.",
    input_schema: {
      type: "object" as const,
      properties: {
        player: { type: "string", description: "Player name to filter by (partial match ok)" },
        tier: { type: "string", enum: ["common", "rare", "legendary", "ultimate", "fandom"] },
        maxPrice: { type: "number", description: "Maximum price in USD" },
        minDiscount: { type: "number", description: "Minimum % below FMV (0-100). Use 15 for 'good deals'." },
        limit: { type: "number", description: "Number of results, default 5" },
      },
      required: [],
    },
  },
  {
    name: "search_catalog_deals",
    description: "Search the RPC moment catalog using Supabase data — player names, tiers, prices, badges, FMV. Use as fallback when live feed is unavailable, or to find moments with specific badges, from specific teams, or under a price ceiling.",
    input_schema: {
      type: "object" as const,
      properties: {
        player: { type: "string", description: "Player name (partial match)" },
        team: { type: "string", description: "Team name (partial match)" },
        tier: { type: "string", enum: ["common", "rare", "legendary", "ultimate", "fandom"] },
        maxPrice: { type: "number", description: "Max low_ask price in USD" },
        minDiscount: { type: "number", description: "Min % below FMV (0 = any)" },
        hasBadge: { type: "boolean", description: "Only return moments with badges" },
        limit: { type: "number", description: "Results to return (default 8)" },
      },
      required: [],
    },
  },
  {
    name: "get_fmv",
    description: "Get the Fair Market Value (FMV) for a specific moment edition. Provide either a player name + set name, or an edition key in setID:playID format.",
    input_schema: {
      type: "object" as const,
      properties: {
        editionKey: { type: "string", description: "Edition key in setID:playID format (e.g. '92:3459')" },
        playerName: { type: "string", description: "Player name to look up" },
        setName: { type: "string", description: "Set name (optional, narrows search)" },
      },
      required: [],
    },
  },
  {
    name: "check_wallet",
    description: "Look up a collector's wallet to see their moments, portfolio value, and collection stats. Use when user asks about their own collection or mentions a username.",
    input_schema: {
      type: "object" as const,
      properties: {
        walletAddress: { type: "string", description: "Flow wallet address (0x...) or Top Shot username" },
      },
      required: ["walletAddress"],
    },
  },
  {
    name: "escalate_to_human",
    description: "Escalate to Trevor (RPC creator) when the user has an account-specific problem, bug, or issue the bot cannot resolve. Only use after already trying to help.",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: { type: "string", description: "Clear description of what the user needs help with" },
        category: { type: "string", enum: ["bug", "account", "billing", "feature_request", "other"] },
        urgency: { type: "string", enum: ["low", "medium", "high"], description: "High = user can't use the platform at all" },
      },
      required: ["reason", "category"],
    },
  },
];

// ── System prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(ctx: {
  pageContext?: string;
  userWallet?: string;
  walletConnected?: boolean;
  marketPulse?: string;
  dailyDeal?: any;
}): string {
  const { pageContext, userWallet, walletConnected, marketPulse, dailyDeal } = ctx;

  const marketSection =
    marketPulse || dailyDeal
      ? `\n## Live Market Context (as of right now)
${marketPulse ? `- Market pulse: ${marketPulse}` : ""}
${dailyDeal ? `- Today's featured deal: ${dailyDeal.player_name} ${dailyDeal.set_name} (${dailyDeal.series}), $${dailyDeal.low_ask} ask, FMV $${dailyDeal.fmv}, ${dailyDeal.discount_pct}% below FMV${dailyDeal.badges?.length ? `, badges: ${dailyDeal.badges.join(", ")}` : ""}` : ""}
Use this context naturally in welcome messages and recommendations.`
      : "";

  const walletSection = userWallet
    ? `\n## User Context\n- Wallet connected: ${userWallet}\n- Use check_wallet to surface personalized insights when relevant.`
    : walletConnected
    ? `\n## User Context\n- User has a wallet connected but address not yet provided.`
    : "";

  const pageSection = pageContext
    ? `\n## Current Page\nUser is on: ${pageContext}\nTailor your responses to this context — e.g., on Sniper, focus on deals; on Badges, focus on badge strategy.`
    : "";

  return `You are the RPC Assistant — the official AI concierge for Rip Packs City, the sharpest collector intelligence platform for NBA Top Shot on the Flow blockchain.

## Your Persona
You are part personal shopper, part portfolio advisor, part collector expert. You speak fluent collector — moments, serials, FMV, floor, badges, rips, mints, Low Asks, parallel editions, set bottlenecks. You are direct, helpful, and genuinely excited about finding good deals. You never pad responses with corporate fluff.

Keep responses concise — most users are on mobile. Use short paragraphs over bullet-heavy walls of text.

## What RPC Is
Rip Packs City (rippackscity.com) is a collector intelligence platform built by Trevor Dillon-Bond, an official Portland Trail Blazers Team Captain on NBA Top Shot. Features:

- **Collection Analyzer** (/nba-top-shot/collection) — full wallet analytics: FMV per moment, best offers, series labels, badge quick-filter, FMV delta indicator, portfolio summary cards (Wallet/Unlocked/Locked/Best Offer FMV), share button
- **Sniper** (/nba-top-shot/sniper) — real-time deal feed from NBA Top Shot + Flowty marketplaces; shows Deals (below FMV) and Offers; filter by tier, min discount, max price; Flowty covers when Top Shot feed is blocked
- **Packs** (/nba-top-shot/packs) — secondary market pack browser with EV calculator, tier/type filters, wallet ownership lookup, best-value EV ratio sort, EV breakdown modal, FMV coverage notes
- **Badges** (/nba-top-shot/badges) — badge tracker for all play tags (Rookie Year, Top Shot Debut, Three Stars, Championship Year, etc.)
- **Sets** (/nba-top-shot/sets) — set browser with completion tracking and bottleneck detection
- **Profile** (/nba-top-shot/profile/[username]) — public collector profile with trophy case

## FMV Methodology (v1.3.0 — be accurate about this)
RPC's FMV is a weighted average price (WAP) model:
- Recalculated every 20 minutes via automated pipeline
- Weights recent sales more heavily than older ones using days_since_sale decay
- Adjusted for sales volume (sales_count_30d) — low-volume editions get wider confidence intervals
- Confidence levels: HIGH (many recent sales, stable price), MEDIUM, LOW (sparse data)
- When FMV confidence is LOW, caveat pricing suggestions

## Sniper Feed Data Sources
- Primary: NBA Top Shot marketplace GraphQL (public API)
- Backup: Flowty.io (covers when Top Shot's Cloudflare blocks our server IPs)
- When Top Shot feed is unavailable, Flowty listings still show — expected behavior, not a bug
- All current Top Shot listings use DUC (Dapper Utility Coin)

## What Makes Moments Valuable
- **Player tier** (Ultimate > Legendary > Rare > Fandom > Common)
- **Badges**: Rookie Year (first season), Top Shot Debut (first TS moment), Rookie Premiere, Rookie Mint, Three Stars (3x All-Star), Championship Year — badges add significant premium
- **Serial numbers**: #1 is rarest; jersey serials carry premium; low serials more valuable
- **Set completion** — moments completing a set worth more to set-chasers
- **Circulation count** — lower = higher scarcity
- **Burn rate** — high burn rate = shrinking effective supply

## Series Reference
Beta (S0), S1, S2, S3, S4, S5, S6, S7, S8

## Shopping & Recommendations
When a user wants to find or buy moments:
1. ALWAYS try search_live_deals first
2. If live feed returns nothing or errors, use search_catalog_deals as fallback
3. Surface 3-5 concrete options with: player name, tier, price, FMV, discount%, any badges
4. Give a clear buy/watch/pass recommendation on individual moments when asked
5. For budget queries ("I have $50"), optimize for value: badge presence, discount %, confidence
6. Never make up prices — always use tool results

## Common Questions (no tools needed)
- "How is FMV calculated?" \u2192 WAP model, 20-min refresh, confidence levels
- "What are badges?" \u2192 play tags, list main ones, explain premium
- "Why is the sniper feed empty?" \u2192 Cloudflare sometimes blocks Top Shot; Flowty backup covers it; refresh or check back
- "What does confidence mean?" \u2192 HIGH = reliable, MEDIUM = some data, LOW = sparse/directional
- "How do I buy a moment?" \u2192 Connect Dapper wallet on Top Shot or Flowty; RPC links directly
- "How do I connect my wallet?" \u2192 Flow/Dapper wallet; connect at top of any collection page${marketSection}${walletSection}${pageSection}

## Escalation Rules
Escalate ONLY when you've tried to help and cannot resolve it:
- User's moments missing after purchase
- Transaction completed but NFT not in wallet
- Account-specific bugs you cannot diagnose
- Billing or Dapper account issues
DO NOT escalate for: how-to questions, FMV questions, sniper feed timing, feature requests

## Tone
Good: "That LeBron Rare is a solid buy at $18 \u2014 FMV is $26, so you're getting it 31% below. The Rookie Premiere badge makes it stickier to hold."
Bad: "That's a great question! I'd be happy to help you analyze that moment's value. Let me break it down for you..."

Respond in whatever language the user writes in.`;
}

// ── Tool execution ────────────────────────────────────────────────────────────
async function executeTool(
  toolName: string,
  toolInput: any,
  ctx: { sessionId: string; userWallet?: string }
): Promise<string> {
  const base = siteUrl();

  if (toolName === "search_live_deals") {
    try {
      const params = new URLSearchParams();
      if (toolInput.tier) params.set("tier", toolInput.tier);
      if (toolInput.maxPrice) params.set("maxPrice", String(toolInput.maxPrice));
      if (toolInput.minDiscount) params.set("minDiscount", String(toolInput.minDiscount));

      const res = await fetch(`${base}/api/sniper-feed?${params.toString()}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`Sniper feed returned ${res.status}`);
      const data = await res.json();
      const deals = (data.deals || data || []).filter((d: any) =>
        toolInput.player ? d.playerName?.toLowerCase().includes(toolInput.player.toLowerCase()) : true
      );
      if (!deals || deals.length === 0) {
        return JSON.stringify({ status: "no_results", message: "Live feed returned no matches \u2014 falling back to catalog search recommended" });
      }
      const results = deals.slice(0, toolInput.limit || 5).map((d: any) => ({
        player: d.playerName,
        tier: d.tier,
        serial: d.serialNumber,
        price: d.askPrice,
        fmv: d.adjustedFmv,
        discount_pct: d.discount,
        source: d.source,
        buy_url: d.buyUrl || `https://www.nbatopshot.com`,
      }));
      return JSON.stringify({ status: "ok", results, total: deals.length });
    } catch (err: any) {
      return JSON.stringify({ status: "error", message: `Live feed unavailable: ${err.message}. Use search_catalog_deals instead.` });
    }
  }

  if (toolName === "search_catalog_deals") {
    try {
      const res = await fetch(`${base}/api/support-chat/search-deals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toolInput),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      if (!data.deals || data.deals.length === 0) {
        return JSON.stringify({ status: "no_results", message: "No moments found matching those criteria in the catalog." });
      }
      return JSON.stringify({ status: "ok", results: data.deals, total: data.deals.length });
    } catch (err: any) {
      return JSON.stringify({ status: "error", message: err.message });
    }
  }

  if (toolName === "get_fmv") {
    try {
      if (toolInput.editionKey) {
        const res = await fetch(`${base}/api/fmv?edition=${encodeURIComponent(toolInput.editionKey)}`, {
          signal: AbortSignal.timeout(8000),
        });
        return JSON.stringify(await res.json());
      }
      if (toolInput.playerName) {
        const { data, error } = await supabase
          .from("badge_editions")
          .select(`player_name, tier, set_name, series_number, low_ask, editions!inner(external_id, fmv_snapshots!inner(fmv_usd, confidence))`)
          .eq("parallel_id", 0)
          .ilike("player_name", `%${toolInput.playerName}%`)
          .not("low_ask", "is", null)
          .limit(5);
        if (error || !data?.length) {
          return JSON.stringify({ status: "not_found", message: "No FMV data found for that player." });
        }
        const results = data.map((be: any) => ({
          player: be.player_name,
          tier: be.tier?.replace("MOMENT_TIER_", ""),
          set: be.set_name,
          low_ask: be.low_ask,
          fmv: be.editions?.[0]?.fmv_snapshots?.[0]?.fmv_usd,
          confidence: be.editions?.[0]?.fmv_snapshots?.[0]?.confidence,
          edition_key: be.editions?.[0]?.external_id,
        }));
        return JSON.stringify({ status: "ok", results });
      }
      return JSON.stringify({ status: "error", message: "Provide editionKey or playerName." });
    } catch (err: any) {
      return JSON.stringify({ status: "error", message: err.message });
    }
  }

  if (toolName === "check_wallet") {
    try {
      const res = await fetch(`${base}/api/wallet-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: toolInput.walletAddress }),
        signal: AbortSignal.timeout(12000),
      });
      const data = await res.json();
      const moments = data.moments || data.rows || [];
      const totalFmv = moments.reduce((s: number, m: any) => s + (m.fmv ?? 0), 0);
      return JSON.stringify({
        status: "ok",
        wallet: toolInput.walletAddress,
        total_moments: moments.length,
        portfolio_fmv: totalFmv.toFixed(2),
        top_moments: moments.slice(0, 5).map((m: any) => ({
          player: m.playerName, set: m.setName, tier: m.tier, serial: m.serialNumber, fmv: m.fmv,
        })),
      });
    } catch (err: any) {
      return JSON.stringify({ status: "error", message: err.message });
    }
  }

  if (toolName === "escalate_to_human") {
    const { reason, category, urgency } = toolInput;
    try {
      if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: `\u{1F6A8} RPC Support Escalation\nCategory: ${category}\nUrgency: ${urgency ?? "medium"}\nSession: ${ctx.sessionId}\n\nIssue: ${reason}`,
            parse_mode: "HTML",
          }),
        });
      }
    } catch { /* non-fatal */ }
    try {
      if (process.env.RESEND_API_KEY && process.env.ALERT_EMAIL) {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "rpc-support@rippackscity.com",
            to: process.env.ALERT_EMAIL,
            subject: `[RPC Support] ${category} \u2014 ${urgency ?? "medium"} urgency`,
            text: `Session: ${ctx.sessionId}\nCategory: ${category}\nUrgency: ${urgency ?? "medium"}\n\nIssue:\n${reason}`,
          }),
        });
      }
    } catch { /* non-fatal */ }
    return JSON.stringify({ status: "escalated", message: "Trevor has been notified and will follow up via Discord or email." });
  }

  return JSON.stringify({ status: "error", message: `Unknown tool: ${toolName}` });
}

// ── Classify category ─────────────────────────────────────────────────────────
function classifyCategory(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("buy") || m.includes("deal") || m.includes("find") || m.includes("recommend")) return "shopping";
  if (m.includes("fmv") || m.includes("value") || m.includes("worth") || m.includes("price")) return "fmv";
  if (m.includes("badge") || m.includes("rookie") || m.includes("debut")) return "badges";
  if (m.includes("pack") || m.includes("rip") || m.includes("ev")) return "packs";
  if (m.includes("wallet") || m.includes("collection") || m.includes("missing") || m.includes("disappear")) return "account";
  if (m.includes("bug") || m.includes("broken") || m.includes("error") || m.includes("crash")) return "bug";
  if (m.includes("new") || m.includes("start") || m.includes("beginner") || m.includes("how do i")) return "onboarding";
  return "general";
}

// ── Update session ─────────────────────────────────────────────────────────────
async function updateSession(sessionId: string, category: string, userMessage: string, playerSearched?: string) {
  try {
    const { data: existing } = await supabase
      .from("chat_sessions")
      .select("last_topics, conversation_count")
      .eq("session_id", sessionId)
      .maybeSingle();

    const currentTopics: string[] = existing?.last_topics ?? [];
    const newTopics = [...new Set([category, ...currentTopics])].slice(0, 5);

    await supabase.from("chat_sessions").upsert(
      {
        session_id: sessionId,
        last_topics: newTopics,
        last_player_searched: playerSearched ?? existing?.last_topics?.[0] ?? null,
        last_seen_at: new Date().toISOString(),
        conversation_count: (existing?.conversation_count ?? 0) + 1,
      },
      { onConflict: "session_id" }
    );
  } catch { /* non-fatal */ }
}

// ── Main handler ──────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      message,
      sessionId = `anon-${Date.now()}`,
      userWallet,
      pageContext,
      walletConnected,
      conversationHistory = [],
      marketPulse,
      dailyDeal,
    } = body;

    if (!message?.trim()) {
      return NextResponse.json({ error: "Message required" }, { status: 400 });
    }

    if (!checkRateLimit(sessionId)) {
      return NextResponse.json(
        { response: "You've sent a lot of messages! Take a breather and try again in an hour.", escalated: false, category: "rate_limit" },
        { status: 429 }
      );
    }

    const systemPrompt = buildSystemPrompt({ pageContext, userWallet, walletConnected, marketPulse, dailyDeal });
    const recentHistory = conversationHistory.slice(-10);
    const messages: Anthropic.MessageParam[] = [
      ...recentHistory,
      { role: "user" as const, content: message },
    ];

    let finalResponse = "";
    let escalated = false;
    let escalationReason: string | undefined;
    let usedTools: string[] = [];
    let currentMessages = messages;
    let iterations = 0;
    const MAX_ITERATIONS = 5;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: systemPrompt,
        tools: TOOLS,
        messages: currentMessages,
      });

      if (response.stop_reason === "end_turn") {
        finalResponse = response.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n")
          .trim();
        break;
      }

      if (response.stop_reason === "tool_use") {
        const toolUseBlocks = response.content.filter((b: any) => b.type === "tool_use");
        const toolResults: Anthropic.MessageParam = { role: "user", content: [] };

        for (const block of toolUseBlocks) {
          const tb = block as Anthropic.ToolUseBlock;
          usedTools.push(tb.name);
          if (tb.name === "escalate_to_human") {
            escalated = true;
            escalationReason = (tb.input as any).reason;
          }
          const result = await executeTool(tb.name, tb.input, { sessionId, userWallet });
          (toolResults.content as Anthropic.ToolResultBlockParam[]).push({
            type: "tool_result",
            tool_use_id: tb.id,
            content: result,
          });
        }

        currentMessages = [
          ...currentMessages,
          { role: "assistant" as const, content: response.content },
          toolResults,
        ];
        continue;
      }

      finalResponse = response.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n")
        .trim();
      break;
    }

    if (!finalResponse) {
      finalResponse = "Sorry, I ran into an issue. Try again in a moment, or reach out to Trevor on Discord.";
    }

    const playerSearched =
      usedTools.includes("search_catalog_deals") || usedTools.includes("search_live_deals")
        ? body.message.match(/\b([A-Z][a-z]+ [A-Z][a-z]+)\b/)?.[0] ?? undefined
        : undefined;

    const category = classifyCategory(message);

    try {
      await supabase.from("support_conversations").insert({
        session_id: sessionId,
        user_message: message,
        bot_response: finalResponse,
        escalated,
        escalation_reason: escalationReason ?? null,
        category,
        resolved: !escalated,
        user_wallet: userWallet ?? null,
        page_context: pageContext ?? null,
      });
    } catch { /* non-fatal */ }

    await updateSession(sessionId, category, message, playerSearched);

    return NextResponse.json({ response: finalResponse, escalated, escalationReason, category });
  } catch (err: any) {
    console.error("[support-chat] Error:", err);
    return NextResponse.json(
      { response: "Something went wrong on my end. Try again, or reach out to Trevor on Discord.", escalated: false, category: "error" },
      { status: 200 }
    );
  }
}
