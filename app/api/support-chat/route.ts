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
    name: "manage_watchlist",
    description: "Add, remove, or list moments on the user's watchlist. Use when the user says 'watch this', 'add to my watchlist', 'what am I watching', or 'remove from watchlist'. Requires owner_key from the session.",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["add", "remove", "list"] },
        edition_key: { type: "string", description: "setID:playID format — use from a prior search result" },
        player_name: { type: "string" },
        set_name: { type: "string" },
        tier: { type: "string" },
        thumbnail_url: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "manage_alerts",
    description: "Set, remove, or list FMV price alerts for moments. Use when user says 'alert me when', 'notify me if', 'set an alert', 'what alerts do I have', or 'turn off alert'. Requires owner_key.",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["set", "remove", "list"] },
        edition_key: { type: "string" },
        player_name: { type: "string" },
        alert_type: { type: "string", enum: ["below_fmv_pct", "below_price"] },
        threshold: { type: "number", description: "Percent (0-100) for below_fmv_pct, dollar amount for below_price" },
        channel: { type: "string", enum: ["email", "telegram", "both"] },
      },
      required: ["action"],
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
  {
    name: "get_collection_snapshot",
    description: "Get a shareable summary of a collector's portfolio including total moments, total FMV, top moments by value, badge count, and series breakdown. Use when a user asks about their portfolio value, total collection worth, or wants to share their collection.",
    input_schema: {
      type: "object" as const,
      properties: {
        walletAddress: { type: "string", description: "Flow wallet address (0x...) or Top Shot username" },
      },
      required: ["walletAddress"],
    },
  },
  {
    name: "add_to_watchlist",
    description: "Add a moment to the user's watchlist with optional price alert criteria. Use when a user says things like 'let me know when X drops below $Y' or 'alert me for deals on [player]'. Confirm the alert was set and describe what will trigger it.",
    input_schema: {
      type: "object" as const,
      properties: {
        player_name: { type: "string", description: "Player name to watch for" },
        tier: { type: "string", description: "Optional tier filter (e.g. rare, legendary)" },
        max_price: { type: "number", description: "Maximum price to alert on" },
        min_discount: { type: "number", description: "Minimum discount % below FMV to alert on, default 15" },
      },
      required: ["player_name"],
    },
  },
  {
    name: "explain_fmv",
    description: "Get a detailed FMV breakdown for a specific edition, including confidence, methodology, and a plain-English explanation. Use when a user asks why a moment is priced a certain way, or asks about FMV confidence or methodology.",
    input_schema: {
      type: "object" as const,
      properties: {
        editionKey: { type: "string", description: "Edition identifier in setID:playID format (e.g. '92:3459')" },
      },
      required: ["editionKey"],
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
    ? `\n## Current Page\nUser is on: ${pageContext}\nTailor your responses to this context — e.g., on Sniper, focus on deals; on Market, focus on browsing and filtering; on Collection, focus on portfolio insights.`
    : "";

  return `You are the RPC Assistant — the official AI concierge for Rip Packs City, the sharpest collector intelligence platform for Flow blockchain digital collectibles.

## Your Persona
You are part personal shopper, part portfolio advisor, part collector expert. You speak fluent collector — moments, serials, FMV, floor, badges, rips, mints, Low Asks, parallel editions, set bottlenecks. You are direct, helpful, and genuinely excited about finding good deals. You never pad responses with corporate fluff.

Keep responses concise — most users are on mobile. Use short paragraphs over bullet-heavy walls of text.

## What RPC Is
Rip Packs City (rippackscity.com) is a collector intelligence platform built by Trevor Dillon-Bond, an official Portland Trail Blazers Team Captain on NBA Top Shot. Features:

### NBA Top Shot
- **Collection Analyzer** (/nba-top-shot/collection) — full wallet analytics: FMV per moment, best offers with edition/serial labels, series column, default sort FMV descending, quick-filter pills (Badges Only, Has Offer, Listed), Flowty ask fallback in Low Ask column, portfolio summary cards (Wallet/Unlocked/Locked/Best Offer FMV), near-complete sets callout, background parallel page loading, share button
- **Sniper** (/nba-top-shot/sniper) — real-time deal feed from NBA Top Shot + Flowty marketplaces; shows Deals (below FMV) and Offers; filter by tier, min discount, max price; TS CACHED badge when Top Shot data is from cache; share button on each deal; Flow Wallet filter for FLOW/USDC.e deals; Flowty covers when Top Shot feed is blocked
- **Packs** (/nba-top-shot/packs) — secondary market pack browser with EV calculator, tier/type filters, wallet ownership lookup, best-value EV ratio sort, EV breakdown modal
- **Market** (/nba-top-shot/market) — full marketplace browser with badge and discount filtering, player search, tier tabs
- **Sets** (/nba-top-shot/sets) — set browser with completion tracking and bottleneck detection
- **Profile** (/nba-top-shot/profile/[username]) — public collector profile with trophy case

### NFL All Day
- **Overview** (/nfl-all-day/overview) — collection overview and stats
- **Wallet Analytics** (/nfl-all-day/collection) — wallet search and moment analytics for NFL All Day moments on Flow blockchain (contract: 0xe4cf4bdc1751c65d)
- **Sniper Feed** (/nfl-all-day/sniper) — real-time deal feed for NFL All Day moments from Flowty listings
- **Sets Tracker** (/nfl-all-day/sets) — set completion tracking for NFL All Day

### Disney Pinnacle
- **Overview** (/disney-pinnacle/overview) — Disney/Pixar/Star Wars pin NFTs via the OpenSea bridge
- **Sniper Feed** (/disney-pinnacle/sniper) — Flowty listings for Disney Pinnacle pins

### Cart (built, activation pending)
- Flow Wallet cart supports FLOW and USDC.e purchases
- Offer mode for submitting USDC.e bids via FlowtyOffers
- Dapper Wallet cart ready pending WalletConnect ID registration
- **Watchlist & Alerts** — save moments to your watchlist and set FMV or price-drop alerts delivered by email or Telegram

## FMV Methodology (v1.3.0 — be accurate about this)
RPC's FMV is a weighted average price (WAP) model:
- Recalculated every 20 minutes via automated pipeline
- Weights recent sales more heavily than older ones using days_since_sale decay
- Adjusted for sales volume (sales_count_30d) — low-volume editions get wider confidence intervals
- Three confidence levels: HIGH (many recent sales, stable price — reliable), MEDIUM (some data — directional), LOW (sparse or stale data — use with caution)
- When FMV confidence is LOW, caveat pricing suggestions
- For illiquid editions with no sales data, an ask_proxy fallback (floor ask × 0.90) provides a usable signal

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
S1 (on-chain 0), S2 (on-chain 2), Summer 2021 (on-chain 3), S3 (on-chain 4), S4 (on-chain 5), Series 2023-24 (on-chain 6), Series 2024-25 (on-chain 7), Series 2025-26 (on-chain 8)

## Shopping & Recommendations
When a user wants to find or buy moments:
1. ALWAYS try search_live_deals first — it now auto-falls back to Supabase catalog if the live feed is empty or times out
2. If both fail, use search_catalog_deals explicitly
3. Surface 3-5 concrete options with: player name, series, set name, price, FMV, discount%, any badges
4. Give a clear buy/watch/pass recommendation on individual moments when asked
5. For budget queries ("I have $50"), optimize for value: badge presence, discount %, confidence
6. Never make up prices — always use tool results
7. ALWAYS include the buy URL for every deal you mention in your response text. Users will ask for links in follow-up messages, and tool results are NOT carried across messages — only your text responses persist in conversation history. If you don't put the URL in your text, you won't be able to reference it later.
8. You can check a user's wallet for near-complete sets and surface the cheapest missing moments

## Collection Snapshot
Use get_collection_snapshot when a user asks about their portfolio value, total collection worth, or wants to share their collection. It returns a full summary with top moments and a shareable link.

## FMV Deep Dive
Use explain_fmv when a user asks why a moment is priced a certain way, or asks about FMV confidence or methodology. It returns a full breakdown with plain-English explanation.

## Common Questions (no tools needed)
- "How is FMV calculated?" \u2192 WAP model, 20-min refresh, confidence levels
- "What are badges?" \u2192 play tags, list main ones, explain premium
- "Why is the sniper feed empty?" \u2192 Cloudflare sometimes blocks Top Shot; Flowty backup covers it; refresh or check back
- "What does confidence mean?" \u2192 HIGH = reliable, MEDIUM = some data, LOW = sparse/directional
- "How do I buy a moment?" \u2192 Connect Dapper wallet on Top Shot or Flowty; RPC links directly
- "How do I connect my wallet?" \u2192 Flow/Dapper wallet; connect at top of any collection page

## Quick Watchlist (add_to_watchlist)
- Use add_to_watchlist when a user says things like "let me know when X drops below $Y" or "alert me for deals on [player]". Confirm the alert was set and describe what will trigger it.
- This creates a search-type watchlist entry that fires when matching deals appear.

## Watchlist & Alerts
- User says "watch this" or "add to watchlist" → call manage_watchlist with action="add" using the most recent moment from the conversation
- User says "what's on my watchlist" or "show my watchlist" → call manage_watchlist with action="list"
- User says "alert me when [X] drops below [Y]%" → call manage_alerts with action="set", alert_type="below_fmv_pct", threshold=Y
- User says "alert me if [X] goes under $[Y]" → call manage_alerts with action="set", alert_type="below_price", threshold=Y
- User says "what alerts do I have" → call manage_alerts with action="list"
- If owner_key (userWallet) is not in session and user tries to use watchlist/alerts, respond: "To save watchlists and alerts, enter your Top Shot username in the RPC profile tab first — it only takes a second."
- After adding to watchlist, always offer: "Want me to set a price alert for this one too?"
- After setting an alert, confirm: the moment name, threshold, and delivery channel${marketSection}${walletSection}${pageSection}

## Escalation Rules
Escalate ONLY when you've tried to help and cannot resolve it:
- User's moments missing after purchase
- Transaction completed but NFT not in wallet
- Account-specific bugs you cannot diagnose
- Billing or Dapper account issues
DO NOT escalate for: how-to questions, FMV questions, sniper feed timing, feature requests

## Tone
Good: "That LeBron S4 Hustle and Show is a solid buy at $18 \u2014 FMV is $26, so you're getting it 31% below. The Rookie Premiere badge makes it stickier to hold."
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
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Sniper feed returned ${res.status}`);
      const data = await res.json();
      const deals = (data.deals || data || []).filter((d: any) =>
        toolInput.player ? d.playerName?.toLowerCase().includes(toolInput.player.toLowerCase()) : true
      );
      if (deals && deals.length > 0) {
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
      }
    } catch {
      // Fall through to Supabase fallback
    }

    // Supabase cached_listings fallback when sniper-feed returns 0 or errors
    try {
      let query = supabase
        .from("cached_listings")
        .select("player_name, set_name, tier, serial_number, circulation_count, ask_price, fmv, discount, badge_slugs, buy_url")
        .gt("discount", 0)
        .order("discount", { ascending: false })
        .limit(toolInput.limit || 10);
      if (toolInput.player) query = query.ilike("player_name", `%${toolInput.player}%`);
      if (toolInput.tier) query = query.ilike("tier", `%${toolInput.tier}%`);
      if (toolInput.maxPrice) query = query.lte("ask_price", toolInput.maxPrice);
      if (toolInput.minDiscount) query = query.gte("discount", toolInput.minDiscount);
      const { data: fallbackRows } = await query;
      if (fallbackRows && fallbackRows.length > 0) {
        const results = fallbackRows.map((d: any) => ({
          player: d.player_name,
          tier: d.tier,
          serial: d.serial_number,
          price: Number(d.ask_price),
          fmv: Number(d.fmv),
          discount_pct: Number(d.discount),
          source: "catalog",
          buy_url: d.buy_url || "https://www.nbatopshot.com",
        }));
        return JSON.stringify({ status: "ok", results, total: results.length, source: "catalog_fallback" });
      }
    } catch { /* silent */ }

    return JSON.stringify({ status: "no_results", message: "No deals found matching those criteria." });
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

      // Fetch near-complete sets for actionable intel
      let nearCompleteSets: string[] = [];
      try {
        const setsRes = await fetch(
          `${base}/api/sets?wallet=${encodeURIComponent(toolInput.walletAddress)}&skipAsks=1`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (setsRes.ok) {
          const setsData = await setsRes.json();
          const sets = (setsData.sets ?? [])
            .filter((s: any) => s.missingCount >= 1 && s.missingCount <= 3)
            .slice(0, 5);
          nearCompleteSets = sets.map((s: any) =>
            `${s.setName} (${s.missingCount} missing${s.totalMissingCost != null ? `, est. $${Number(s.totalMissingCost).toFixed(2)} to finish` : ""})`
          );
        }
      } catch { /* non-fatal */ }

      const result: any = {
        status: "ok",
        wallet: toolInput.walletAddress,
        total_moments: moments.length,
        portfolio_fmv: totalFmv.toFixed(2),
        top_moments: moments.slice(0, 5).map((m: any) => ({
          player: m.playerName, set: m.setName, tier: m.tier, serial: m.serialNumber, fmv: m.fmv,
        })),
      };
      if (nearCompleteSets.length > 0) {
        result.near_complete_sets = nearCompleteSets;
      }
      return JSON.stringify(result);
    } catch (err: any) {
      return JSON.stringify({ status: "error", message: err.message });
    }
  }

  if (toolName === "manage_watchlist") {
    if (!ctx.userWallet) {
      return JSON.stringify({ status: "error", message: "owner_key_missing" });
    }
    try {
      if (toolInput.action === "list") {
        const res = await fetch(`${base}/api/watchlist?owner_key=${encodeURIComponent(ctx.userWallet)}`, {
          signal: AbortSignal.timeout(8000),
        });
        const data = await res.json();
        const items = data.watchlist || data.items || data || [];
        if (!Array.isArray(items) || items.length === 0) {
          return JSON.stringify({ status: "ok", message: "Your watchlist is empty.", results: [] });
        }
        const results = items.map((item: any) => ({
          player: item.player_name,
          set: item.set_name,
          tier: item.tier,
          edition_key: item.edition_key,
          low_ask: item.low_ask,
          fmv: item.fmv,
          discount_pct: item.fmv && item.low_ask ? Math.round((1 - item.low_ask / item.fmv) * 100) : null,
        }));
        return JSON.stringify({ status: "ok", results });
      }
      if (toolInput.action === "add") {
        const res = await fetch(`${base}/api/watchlist`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner_key: ctx.userWallet,
            edition_key: toolInput.edition_key,
            player_name: toolInput.player_name,
            set_name: toolInput.set_name,
            tier: toolInput.tier,
            thumbnail_url: toolInput.thumbnail_url,
          }),
          signal: AbortSignal.timeout(8000),
        });
        const data = await res.json();
        return JSON.stringify({ status: "ok", message: `Added ${toolInput.player_name || "moment"} to your watchlist.`, data });
      }
      if (toolInput.action === "remove") {
        const res = await fetch(`${base}/api/watchlist`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner_key: ctx.userWallet,
            edition_key: toolInput.edition_key,
          }),
          signal: AbortSignal.timeout(8000),
        });
        const data = await res.json();
        return JSON.stringify({ status: "ok", message: `Removed from your watchlist.`, data });
      }
      return JSON.stringify({ status: "error", message: "Invalid action. Use add, remove, or list." });
    } catch (err: any) {
      return JSON.stringify({ status: "error", message: err.message });
    }
  }

  if (toolName === "manage_alerts") {
    if (!ctx.userWallet) {
      return JSON.stringify({ status: "error", message: "owner_key_missing" });
    }
    try {
      if (toolInput.action === "list") {
        const res = await fetch(`${base}/api/alerts?owner_key=${encodeURIComponent(ctx.userWallet)}`, {
          signal: AbortSignal.timeout(8000),
        });
        const data = await res.json();
        const alerts = data.alerts || data.items || data || [];
        if (!Array.isArray(alerts) || alerts.length === 0) {
          return JSON.stringify({ status: "ok", message: "You have no active alerts.", results: [] });
        }
        const results = alerts.map((a: any) => ({
          player: a.player_name,
          edition_key: a.edition_key,
          alert_type: a.alert_type,
          threshold: a.threshold,
          channel: a.channel,
          triggered: a.triggered ?? false,
        }));
        return JSON.stringify({ status: "ok", results });
      }
      if (toolInput.action === "set") {
        const res = await fetch(`${base}/api/alerts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner_key: ctx.userWallet,
            edition_key: toolInput.edition_key,
            player_name: toolInput.player_name,
            alert_type: toolInput.alert_type,
            threshold: toolInput.threshold,
            channel: toolInput.channel,
          }),
          signal: AbortSignal.timeout(8000),
        });
        const data = await res.json();
        return JSON.stringify({ status: "ok", message: `Alert set for ${toolInput.player_name || "moment"}.`, data });
      }
      if (toolInput.action === "remove") {
        const res = await fetch(`${base}/api/alerts`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner_key: ctx.userWallet,
            edition_key: toolInput.edition_key,
          }),
          signal: AbortSignal.timeout(8000),
        });
        const data = await res.json();
        return JSON.stringify({ status: "ok", message: `Alert removed.`, data });
      }
      return JSON.stringify({ status: "error", message: "Invalid action. Use set, remove, or list." });
    } catch (err: any) {
      return JSON.stringify({ status: "error", message: err.message });
    }
  }

  if (toolName === "get_collection_snapshot") {
    try {
      const res = await fetch(
        `${base}/api/collection-snapshot?wallet=${encodeURIComponent(toolInput.walletAddress)}`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) throw new Error(`Snapshot returned ${res.status}`);
      const data = await res.json();
      const topList = (data.topMoments ?? [])
        .map((m: any) => `${m.playerName} (${m.tier}) — $${Number(m.fmv).toFixed(2)}`)
        .join(", ");
      return JSON.stringify({
        status: "ok",
        summary: `Your collection: ${data.totalMoments} moments, total FMV $${Number(data.totalFmv).toFixed(2)}. Top moments: ${topList}. Share your collection at https://rip-packs-city.vercel.app/share/${encodeURIComponent(toolInput.walletAddress)}`,
        raw: data,
      });
    } catch (err: any) {
      return JSON.stringify({ status: "error", message: err.message });
    }
  }

  if (toolName === "add_to_watchlist") {
    if (!ctx.userWallet) {
      return JSON.stringify({ status: "error", message: "owner_key_missing" });
    }
    try {
      const res = await fetch(`${base}/api/watchlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner_key: ctx.userWallet,
          type: "search",
          player_name: toolInput.player_name,
          tier: toolInput.tier ?? null,
          max_price: toolInput.max_price ?? null,
          min_discount: toolInput.min_discount ?? 15,
        }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (!res.ok) {
        return JSON.stringify({ status: "error", message: data.error ?? "Failed to add to watchlist" });
      }
      const criteria: string[] = [];
      if (toolInput.max_price) criteria.push(`price drops below $${toolInput.max_price}`);
      if (toolInput.min_discount) criteria.push(`${toolInput.min_discount}%+ below FMV`);
      if (toolInput.tier) criteria.push(`tier: ${toolInput.tier}`);
      const triggerDesc = criteria.length > 0 ? criteria.join(", ") : "any deal appears";
      return JSON.stringify({
        status: "ok",
        message: `Watchlist alert set for ${toolInput.player_name}. You'll be notified when ${triggerDesc}.`,
        data,
      });
    } catch (err: any) {
      return JSON.stringify({ status: "error", message: err.message });
    }
  }

  if (toolName === "explain_fmv") {
    try {
      const editionKey = toolInput.editionKey
      if (!editionKey) {
        return JSON.stringify({ status: "error", message: "editionKey is required" })
      }

      // Resolve edition_id
      const { data: edition } = await supabase
        .from("editions")
        .select("id")
        .eq("external_id", editionKey)
        .single()

      if (!edition?.id) {
        return JSON.stringify({ status: "not_found", message: "Edition not found for that key." })
      }

      // Get most recent fmv_snapshot
      const { data: snapshot } = await supabase
        .from("fmv_snapshots")
        .select("fmv_usd, confidence, wap_usd, floor_price_usd, computed_at, sales_count_30d, days_since_sale, ask_proxy_fmv, algo_version")
        .eq("edition_id", edition.id)
        .order("computed_at", { ascending: false })
        .limit(1)
        .single()

      // Get badge_editions info for player/set context
      const { data: badgeInfo } = await supabase
        .from("badge_editions")
        .select("player_name, set_name, tier")
        .eq("edition_id", editionKey)
        .limit(1)
        .single()

      if (!snapshot) {
        return JSON.stringify({ status: "no_data", message: "No FMV snapshot exists for this edition yet." })
      }

      // Build plain-English explanation
      const computedAgo = snapshot.computed_at
        ? `${Math.round((Date.now() - new Date(snapshot.computed_at).getTime()) / (1000 * 60))} minutes ago`
        : "unknown"
      const salesNote = snapshot.sales_count_30d
        ? `across ${snapshot.sales_count_30d} recent sales`
        : "with limited sales data"

      const explanation = `FMV is $${Number(snapshot.fmv_usd).toFixed(2)} (${snapshot.confidence} confidence) based on a 30-day WAP of $${Number(snapshot.wap_usd || 0).toFixed(2)} ${salesNote}. Floor price is $${Number(snapshot.floor_price_usd || 0).toFixed(2)}. Last computed ${computedAgo}.${snapshot.ask_proxy_fmv ? ` Ask proxy FMV: $${Number(snapshot.ask_proxy_fmv).toFixed(2)}.` : ""}`

      return JSON.stringify({
        status: "ok",
        player_name: badgeInfo?.player_name ?? null,
        set_name: badgeInfo?.set_name ?? null,
        tier: badgeInfo?.tier ?? null,
        fmv_usd: snapshot.fmv_usd,
        confidence: snapshot.confidence,
        wap_usd: snapshot.wap_usd,
        floor_price_usd: snapshot.floor_price_usd,
        computed_at: snapshot.computed_at,
        explanation,
      })
    } catch (err: any) {
      return JSON.stringify({ status: "error", message: err.message })
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

    if (escalated) {
      finalResponse += "\n\nYou can also DM us directly at https://twitter.com/RipPacksCity for a faster response.";
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

    // Fire-and-forget session memory write-back — must not block the response
    updateSession(sessionId, category, message, playerSearched).catch(() => {})

    return NextResponse.json({ response: finalResponse, escalated, escalationReason, category });
  } catch (err: any) {
    console.error("[support-chat] Error:", err);
    return NextResponse.json(
      { response: "Something went wrong on my end. Try again, or reach out to Trevor on Discord.", escalated: false, category: "error" },
      { status: 200 }
    );
  }
}
