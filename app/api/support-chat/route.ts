import { NextRequest, NextResponse } from "next/server";

/* ------------------------------------------------------------------ */
/*  POST /api/support-chat                                             */
/*  Body: { message, sessionId, userWallet?, pageContext?,             */
/*          walletConnected? }                                         */
/*  Returns: { response, escalated, escalationReason?, category,       */
/*             momentCards?, actions? }                                 */
/* ------------------------------------------------------------------ */

export const maxDuration = 30;

import { createClient } from "@supabase/supabase-js";
const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ── Base URL for internal API calls ───────────────────────────────
function apiUrl(path: string) {
  if (path.startsWith("http")) return path;
  const base =
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "https://rip-packs-city.vercel.app");
  return `${base}${path}`;
}

// ── System Prompt ─────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are the RPC Assistant — the official AI concierge for Rip Packs City, a collector intelligence platform for NBA Top Shot and NFL All Day NFT collectors on the Flow blockchain.

## Your Identity
- You are part personal shopper, part portfolio advisor, part collector expert
- You speak naturally in collector language — moments, serials, FMV, floor, badges, rips, mints
- You are friendly, opinionated about good deals, and genuinely excited about helping people build great collections
- Keep responses concise and scannable — most users are on mobile
- You can help in English, Spanish, Portuguese, French, and other languages — respond in whatever language the user writes in

## What You Can Do

### 1. PERSONAL SHOPPER — Finding & Recommending Moments
When a user wants to find, buy, or evaluate moments, USE YOUR TOOLS. Never make up prices.
- Search the live sniper feed for deals matching their criteria (player, team, tier, price range, badge type)
- Look up FMV for specific moments and give buy/wait/pass recommendations
- Suggest undervalued moments based on FMV discount, badge premiums, and confidence levels
- Help set a budget and find the best value within it
- When you find good deals, present them enthusiastically with the data backing your recommendation

### 2. PORTFOLIO ADVISOR — Wallet-Aware Intelligence
When a user's wallet is connected, you can analyze their collection:
- Identify their most undervalued moments (biggest gap between what they paid and current FMV)
- Find sets they're close to completing and recommend the cheapest remaining moments
- Suggest what to sell based on declining FMV trends or low confidence scores
- Give a portfolio health check: total value, tier distribution, badge count, concentration risk

### 3. COLLECTOR EXPERT — Platform & Ecosystem Knowledge
Answer any question about the platform or the Top Shot/All Day ecosystem:

**FMV v1.3.0 (Fair Market Value):**
- Calculated using Weighted Average Price (WAP) from recent sales, weighted by recency and volume
- Badge premiums are NOT added on top — already baked into market prices
- Serial premiums only for truly special serials: #1 (gold), jersey number match (teal), last serial (purple/Perfect Mint)
- Confidence levels: HIGH = 5+ sales in 30 days, MEDIUM = 2-4, LOW = 1, NONE = 0 (falls back to ask price)
- FMV refreshes every 20 minutes via the RPC pipeline (ingest → recalc → cache → backfill cycle)
- WAP trending arrows (↑/↓) show if the weighted average price is diverging from base FMV by >10%

**Sniper Feed:**
- Two live sources: NBA Top Shot marketplace + Flowty marketplace
- Ranked by discount % vs adjusted FMV (base FMV × serial multiplier)
- Deals/Offers tab toggle — Deals shows listings below FMV, Offers shows active buy offers
- Tier filter tabs: All, Common, Fandom, Rare, Legendary, Ultimate
- Additional filters: min discount %, max price, serial type, badge-only, verified FMV only
- Source badges (TS / FLOWTY) indicate which marketplace each listing is from
- Confidence dots: green = verified (real sales), yellow = estimated, red = speculative (ask fallback)
- daysSinceSale labels show FMV freshness per edition
- Auto-refreshes every 30 seconds with pause/resume controls
- Falls back to cached listings if both live feeds are offline
- Share button copies a deal link with OG image for Twitter/Discord sharing

**Badges:**
- Community badges: Rookie Year, Rookie Mint, Top Shot Debut, Three Stars, MVP Year, Championship Year, etc.
- Serial badges (computed client-side): #1 Serial (gold), Jersey Match (teal), Perfect Mint (purple)
- Badge-aware FMV: badge premiums are reflected in market prices, not added separately
- Badge explorer shows all badge-eligible editions with filtering by badge type

**Set Completion:**
- Full set tracker with completion percentage per set
- Identifies bottleneck moments (most expensive missing piece)
- Shows total cost to complete each set
- Filter by series (S1-S8), tier, and completion status
- Price enrichment available to load current asks for missing pieces

**Pack EV Calculator:**
- Shows all active pack listings with expected value calculations
- Gross EV, pack EV (after price), value ratio
- Supply tracking: remaining packs, depletion percentage
- Per-edition breakdowns showing probability and contribution to EV

**Wallet/Collection Analyzer:**
- Enter any Top Shot username or Flow address
- Shows full collection with per-moment FMV, badges, serial info
- Portfolio summary: total FMV, tier breakdown, sealed pack count
- Market data enrichment from both Top Shot and Flowty
- Recent sales history for the wallet

**Profile:**
- View any collector's profile and trophy case by username
- Trophy case shows pinned moments with holographic effects for premium tiers

**Shopping Cart (Beta):**
- Add moments directly from sniper feed to cart
- Supports both Top Shot and Flowty listings
- Batch purchase in development (pending Dapper co-signer confirmation)

**Known Issues:**
- Top Shot listing feed intermittent (Cloudflare rate limiting) — Flowty provides backup coverage
- Low-volume FMV (0-1 sales) = LOW/NONE confidence — treat valuations with caution
- NFL All Day collection support is available but with limited data coverage
- Cart purchase execution pending Dapper co-signer confirmation

**About RPC:**
- Built by Trevor, Portland Trail Blazers Team Captain on NBA Top Shot
- Collector intelligence platform competing with LiveToken as primary analytics tool
- Free to use — website: rip-packs-city.vercel.app
- Pipeline runs every 20 minutes with hourly health monitoring (Sentinel with Telegram + email alerts)
- 14 automated QA smoke tests run on every deploy + daily

### 4. EDUCATOR — Onboarding New Collectors
If someone seems new (no wallet, basic questions, says they're new), shift into friendly onboarding mode:
- Explain concepts simply without being condescending
- Use analogies to physical card collecting when helpful
- Suggest a cheap "starter" moment from the live sniper feed to get them hooked
- Walk them through connecting their wallet step by step
- Explain what makes a moment valuable (player, badge, serial, tier, set completion)

## Response Format

ALWAYS respond with valid JSON (no markdown fences, no backticks, just raw JSON):

{
  "response": "Your conversational response here",
  "escalated": false,
  "escalationReason": null,
  "category": "shopping",
  "momentCards": [
    {
      "playerName": "LeBron James",
      "setName": "Metallic Gold LE",
      "tier": "Legendary",
      "series": "S4",
      "price": 149.00,
      "fmv": 210.00,
      "discountPct": 29,
      "badgeNames": ["threeStars", "mvpYear"],
      "serialNumber": 42,
      "mintCount": 99,
      "thumbnailUrl": "https://assets.nbatopshot.com/...",
      "buyUrl": "https://nbatopshot.com/moment/...",
      "source": "topshot",
      "editionKey": "abc:def"
    }
  ],
  "actions": [
    {
      "type": "addToCart",
      "label": "Add to Cart",
      "editionKey": "abc:def",
      "price": 149.00,
      "playerName": "LeBron James"
    }
  ]
}

Rules for momentCards:
- ONLY include momentCards when presenting actual search results from tools — NEVER fabricate them
- If a tool returns no results, say so honestly — don't invent listings
- Include buyUrl so users can go directly to the listing
- Include editionKey for cart integration
- actions array is optional — include addToCart actions when recommending specific moments

## Category Tags
Use: "shopping", "portfolio", "fmv", "sniper", "wallet", "badges", "sets", "packs", "cart", "profile", "onboarding", "account", "bug", "feature_request", "general"

## Escalation Rules
Set escalated: true when you genuinely cannot help:
- Account-specific issues (moments disappeared, purchases failed, wallet won't connect after troubleshooting)
- Bug reports that need investigation
- Billing, refund, or payment issues
- Anything requiring Trevor's direct intervention

Do NOT escalate for: feature questions, shopping help, FMV explanations, data availability, platform education — handle these yourself.

## Personality Notes
- Be genuinely enthusiastic about good deals: "This is a steal — 37% below FMV with a Rookie Year badge"
- Be honest about risk: "FMV confidence is LOW here (only 1 sale in 30 days) — the price could be off"
- Never pressure: offer recommendations, not commands
- If someone's budget is small, don't be dismissive — find them the best $3-5 moment you can
- Use emojis sparingly and naturally, not excessively
- If asked about NFL All Day, note that data coverage is limited but growing`;

// ── Tool Definitions for Claude API ───────────────────────────────
const TOOLS = [
  {
    name: "search_sniper_feed",
    description:
      "Search the RPC sniper feed for current marketplace deals. Returns live listings from Top Shot and Flowty with prices, FMV, discount percentages, badges, and buy links. Use this when a user wants to find moments to buy, browse deals, or get recommendations.",
    input_schema: {
      type: "object" as const,
      properties: {
        rarity: {
          type: "string",
          description:
            "Filter by tier: 'all', 'common', 'rare', 'legendary', 'ultimate'. Default 'all'.",
        },
        minDiscount: {
          type: "number",
          description:
            "Minimum discount percentage below FMV (0-100). Use 15+ for good deals, 25+ for great deals.",
        },
        maxPrice: {
          type: "number",
          description: "Maximum price in USD.",
        },
        search: {
          type: "string",
          description:
            "Player name or set name to search for. Use full name like 'LeBron James'.",
        },
      },
      required: [],
    },
  },
  {
    name: "lookup_fmv",
    description:
      "Look up the Fair Market Value for a specific Top Shot edition. Returns FMV, serial multiplier, badge premium, adjusted FMV, and confidence level. Use when a user asks about a specific moment's value or wants a buy/sell recommendation.",
    input_schema: {
      type: "object" as const,
      properties: {
        edition: {
          type: "string",
          description:
            "Edition key in format setID:playID (UUID format). Get this from sniper feed results.",
        },
        serial: {
          type: "number",
          description:
            "Optional serial number for serial-specific valuation.",
        },
      },
      required: ["edition"],
    },
  },
  {
    name: "search_badges",
    description:
      "Search the RPC badge database for moments with specific badges. Returns player names, badge types, and series info. Use when a user asks about badges or wants to find badge-holding moments.",
    input_schema: {
      type: "object" as const,
      properties: {
        player: {
          type: "string",
          description: "Player name to search badges for.",
        },
        badgeType: {
          type: "string",
          description:
            "Badge type: 'rookieYear', 'rookieMint', 'topShotDebut', 'threeStars', 'mvpYear', 'championshipYear'. Omit for all badges.",
        },
        limit: {
          type: "number",
          description: "Max results. Default 20.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_wallet_portfolio",
    description:
      "Get a collector's wallet portfolio including all moments, total value, tier breakdown, and badge counts. Use when the user asks about their collection, portfolio value, or what they own. Requires the user's wallet address or Top Shot username.",
    input_schema: {
      type: "object" as const,
      properties: {
        username: {
          type: "string",
          description: "Top Shot username to look up.",
        },
      },
      required: ["username"],
    },
  },
  {
    name: "search_sets",
    description:
      "Search Top Shot sets and their composition. Use when a user asks about set completion, what's in a set, or wants to know about specific sets.",
    input_schema: {
      type: "object" as const,
      properties: {
        search: {
          type: "string",
          description:
            "Set name to search for, e.g. 'Run It Back', 'Metallic Gold'.",
        },
        series: {
          type: "string",
          description: "Filter by series number: '1'-'8'.",
        },
      },
      required: [],
    },
  },
];

// ── Tool Execution ────────────────────────────────────────────────
async function executeTool(
  name: string,
  input: Record<string, any>
): Promise<string> {
  try {
    switch (name) {
      case "search_sniper_feed": {
        const params = new URLSearchParams();
        if (input.rarity) params.set("rarity", input.rarity);
        if (input.minDiscount)
          params.set("minDiscount", String(input.minDiscount));
        if (input.maxPrice) params.set("maxPrice", String(input.maxPrice));
        if (input.search) params.set("search", input.search);
        const res = await fetch(apiUrl(`/api/sniper-feed?${params}`), {
          headers: { "User-Agent": "rpc-support-bot/1.0" },
        });
        if (!res.ok)
          return JSON.stringify({
            error: `Sniper feed returned ${res.status}`,
          });
        const data = await res.json();
        // The sniper-feed API returns { count, deals[], lastRefreshed, ... }
        const deals = (data.deals ?? []).slice(0, 8);
        return JSON.stringify({
          count: deals.length,
          totalAvailable: data.count ?? data.deals?.length ?? 0,
          lastRefreshed: data.lastRefreshed ?? null,
          cached: data.cached ?? false,
          deals: deals.map((d: any) => ({
            playerName: d.playerName,
            setName: d.setName,
            tier: d.tier,
            series: d.seriesName ?? null,
            price: d.askPrice,
            fmv: d.adjustedFmv,
            baseFmv: d.baseFmv,
            discountPct: d.discount,
            confidence: d.confidence,
            confidenceSource: d.confidenceSource ?? null,
            daysSinceSale: d.daysSinceSale ?? null,
            serialNumber: d.serial,
            mintCount: d.circulationCount,
            serialMult: d.serialMult ?? 1,
            isSpecialSerial: d.isSpecialSerial ?? false,
            thumbnailUrl: d.thumbnailUrl ?? null,
            buyUrl: d.buyUrl,
            source: d.source ?? "topshot",
            editionKey: d.editionKey,
            hasBadge: d.hasBadge ?? false,
            badgeNames: d.badgeLabels ?? d.badgeSlugs ?? [],
            teamName: d.teamName ?? null,
          })),
        });
      }

      case "lookup_fmv": {
        const params = new URLSearchParams({ edition: input.edition });
        if (input.serial) params.set("serial", String(input.serial));
        const res = await fetch(apiUrl(`/api/fmv?${params}`));
        if (!res.ok)
          return JSON.stringify({
            error: `FMV lookup returned ${res.status}`,
          });
        return JSON.stringify(await res.json());
      }

      case "search_badges": {
        const params = new URLSearchParams();
        params.set("mode", "all");
        if (input.player) params.set("players", input.player);
        if (input.badgeType) params.set("badge_type", input.badgeType);
        params.set("limit", String(input.limit || 20));
        const res = await fetch(apiUrl(`/api/badges?${params}`));
        if (!res.ok)
          return JSON.stringify({
            error: `Badges returned ${res.status}`,
          });
        return JSON.stringify(await res.json());
      }

      case "get_wallet_portfolio": {
        const res = await fetch(
          apiUrl(
            `/api/wallet-search?username=${encodeURIComponent(
              input.username
            )}`
          )
        );
        if (!res.ok)
          return JSON.stringify({
            error: `Wallet search returned ${res.status}`,
          });
        return JSON.stringify(await res.json());
      }

      case "search_sets": {
        const params = new URLSearchParams();
        if (input.search) params.set("search", input.search);
        if (input.series) params.set("series", input.series);
        const res = await fetch(apiUrl(`/api/sets?${params}`));
        if (!res.ok)
          return JSON.stringify({
            error: `Sets returned ${res.status}`,
          });
        return JSON.stringify(await res.json());
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err: any) {
    return JSON.stringify({ error: err?.message || "Tool execution failed" });
  }
}

// ── Escalation email ──────────────────────────────────────────────
async function sendEscalationEmail(
  userMessage: string,
  botResponse: string,
  reason: string,
  category: string,
  sessionId: string,
  userWallet: string | null
) {
  console.error(
    JSON.stringify({
      type: "ESCALATION",
      sessionId,
      userWallet,
      category,
      reason,
      userMessage,
      timestamp: new Date().toISOString(),
    })
  );
}

// ── Main Handler ──────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      message,
      sessionId,
      userWallet = null,
      pageContext = null,
      walletConnected = false,
    } = body;

    if (!message || !sessionId) {
      return NextResponse.json(
        { error: "message and sessionId required" },
        { status: 400 }
      );
    }

    if (message.length > 2000) {
      return NextResponse.json(
        { error: "Message too long (max 2000 chars)" },
        { status: 400 }
      );
    }

    // ── Conversation history ─────────────────────────────────────
    const { data: history } = await supabase
      .from("support_conversations")
      .select("user_message, bot_response")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(6);

    const messages: { role: string; content: any }[] = [];

    if (history && history.length > 0) {
      for (const h of history) {
        messages.push({ role: "user", content: h.user_message });
        try {
          const parsed = JSON.parse(h.bot_response);
          messages.push({
            role: "assistant",
            content: parsed.response || h.bot_response,
          });
        } catch {
          messages.push({ role: "assistant", content: h.bot_response });
        }
      }
    }

    // ── Build user message with context ──────────────────────────
    let contextPrefix = "";
    if (pageContext) contextPrefix += `[User is on the ${pageContext} page] `;
    if (walletConnected && userWallet)
      contextPrefix += `[Wallet connected: ${userWallet}] `;
    else if (!walletConnected)
      contextPrefix += `[Wallet NOT connected] `;

    messages.push({
      role: "user",
      content: contextPrefix ? `${contextPrefix}\n\n${message}` : message,
    });

    // ── Claude API with tool loop ────────────────────────────────
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("ANTHROPIC_API_KEY not set");
      return NextResponse.json({
        response:
          "I'm not fully set up yet — reach out to Trevor on Discord for help.",
        escalated: false,
        category: "general",
      });
    }

    let finalResponse: string | null = null;
    let currentMessages = [...messages];
    let iterations = 0;
    const MAX_ITERATIONS = 5;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const anthropicRes = await fetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2048,
            system: SYSTEM_PROMPT,
            tools: TOOLS,
            messages: currentMessages,
          }),
        }
      );

      if (!anthropicRes.ok) {
        const errText = await anthropicRes.text();
        console.error("Anthropic API error:", anthropicRes.status, errText);
        return NextResponse.json({
          response:
            "I'm having trouble right now. Try again in a moment, or reach out to Trevor on Discord.",
          escalated: false,
          category: "general",
        });
      }

      const data = await anthropicRes.json();

      const toolUseBlocks = data.content?.filter(
        (c: any) => c.type === "tool_use"
      );

      if (
        toolUseBlocks &&
        toolUseBlocks.length > 0 &&
        data.stop_reason === "tool_use"
      ) {
        // Claude wants to use tools — execute and loop
        currentMessages.push({
          role: "assistant",
          content: data.content,
        });

        const toolResults: any[] = [];
        for (const toolBlock of toolUseBlocks) {
          const result = await executeTool(toolBlock.name, toolBlock.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolBlock.id,
            content: result,
          });
        }

        currentMessages.push({ role: "user", content: toolResults });
      } else {
        // Final text response
        finalResponse =
          data.content
            ?.filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("") || "";
        break;
      }
    }

    if (!finalResponse) {
      finalResponse = JSON.stringify({
        response:
          "I got a bit lost searching. Could you rephrase what you're looking for?",
        escalated: false,
        escalationReason: null,
        category: "general",
      });
    }

    // ── Parse structured response ────────────────────────────────
    let parsed: {
      response: string;
      escalated: boolean;
      escalationReason: string | null;
      category: string;
      momentCards?: any[];
      actions?: any[];
    };

    try {
      const cleaned = finalResponse.replace(/```json\s*|```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = {
        response: finalResponse,
        escalated: false,
        escalationReason: null,
        category: "general",
      };
    }

    // ── Log to Supabase ──────────────────────────────────────────
    const { error: insertErr } = await supabase
      .from("support_conversations")
      .insert({
        session_id: sessionId,
        user_message: message,
        bot_response: parsed.response,
        escalated: parsed.escalated,
        escalation_reason: parsed.escalationReason,
        category: parsed.category || "general",
        resolved: !parsed.escalated,
        user_wallet: userWallet,
        page_context: pageContext,
      });

    if (insertErr) {
      console.error("Support log insert error:", insertErr.message);
    }

    // ── Escalation email ─────────────────────────────────────────
    if (parsed.escalated) {
      await sendEscalationEmail(
        message,
        parsed.response,
        parsed.escalationReason || "No reason provided",
        parsed.category,
        sessionId,
        userWallet
      );
    }

    return NextResponse.json({
      response: parsed.response,
      escalated: parsed.escalated || false,
      category: parsed.category || "general",
      momentCards: parsed.momentCards || [],
      actions: parsed.actions || [],
    });
  } catch (err: any) {
    console.error("Support chat error:", err?.message || err);
    return NextResponse.json({
      response:
        "Something went wrong. Try again, or reach out to Trevor on Discord.",
      escalated: false,
      category: "general",
    });
  }
}
