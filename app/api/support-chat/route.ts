// app/api/support-chat/route.ts
// POST /api/support-chat
// Body: { message, sessionId, userWallet?, userEmail?, pageContext?, collectionId?,
//         walletConnected?, conversationHistory?, marketPulse?, dailyDeal?, stream? }
// Returns: { response, escalated, escalationReason?, category }
//
// Phase 4: concierge is multi-collection aware. The v2 system prompt consumes
// `collectionId` + `userEmail` so the model knows which collection the user is
// browsing and who they are. Tool calls thread collectionId into downstream
// API calls where it's meaningful.

export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { getCollection, publishedCollections, COLLECTION_UUID_BY_SLUG } from "@/lib/collections";

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
    description: "Search for live deals from the RPC sniper feed for the active collection. Use this first for any shopping query. Returns real listings with prices, FMV discounts, and buy links. Defaults to the page's active collection when collectionId is omitted.",
    input_schema: {
      type: "object" as const,
      properties: {
        collectionId: { type: "string", description: "Collection id (nba-top-shot, nfl-all-day, laliga-golazos, disney-pinnacle). Defaults to the active page's collection." },
        player: { type: "string", description: "Player/subject name to filter by (partial match ok)" },
        tier: { type: "string", description: "Tier filter (collection-dependent labels)" },
        maxPrice: { type: "number", description: "Maximum price in USD" },
        minDiscount: { type: "number", description: "Minimum % below FMV (0-100). Use 15 for 'good deals'." },
        limit: { type: "number", description: "Number of results, default 5" },
      },
      required: [],
    },
  },
  {
    name: "search_catalog_deals",
    description: "Search the RPC moment catalog via Supabase — player, tier, price, badges, FMV. Use as fallback when live feed is unavailable, or for badge-specific queries.",
    input_schema: {
      type: "object" as const,
      properties: {
        collectionId: { type: "string", description: "Collection id. Defaults to the active page's collection." },
        player: { type: "string" },
        team: { type: "string" },
        tier: { type: "string" },
        maxPrice: { type: "number" },
        minDiscount: { type: "number" },
        hasBadge: { type: "boolean" },
        limit: { type: "number", description: "Default 8" },
      },
      required: [],
    },
  },
  {
    name: "get_fmv",
    description: "Get Fair Market Value for a specific edition. Provide editionKey (setID:playID) or playerName + setName.",
    input_schema: {
      type: "object" as const,
      properties: {
        collectionId: { type: "string", description: "Collection id. Defaults to the active page's collection." },
        editionKey: { type: "string" },
        playerName: { type: "string" },
        setName: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "check_wallet",
    description: "Look up a collector's wallet to see their moments, portfolio value, and stats for the active collection. Use when the user asks about their own collection or mentions a username.",
    input_schema: {
      type: "object" as const,
      properties: {
        collectionId: { type: "string", description: "Collection id. Defaults to the active page's collection." },
        walletAddress: { type: "string", description: "Flow wallet address (0x...) or marketplace username" },
      },
      required: ["walletAddress"],
    },
  },
  {
    name: "search_across_collections",
    description: "Search for a player or subject across ALL published collections simultaneously. Use when the user asks 'does RPC have [player]' without specifying a collection, or when comparing a name across collections.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Player or subject name (partial match)" },
        limit: { type: "number", description: "Max results per collection, default 3" },
      },
      required: ["name"],
    },
  },
  {
    name: "manage_watchlist",
    description: "Add, remove, or list moments on the user's watchlist. Requires owner_key (userWallet) from session.",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["add", "remove", "list"] },
        edition_key: { type: "string" },
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
    description: "Set, remove, or list FMV price alerts. Requires owner_key.",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["set", "remove", "list"] },
        edition_key: { type: "string" },
        player_name: { type: "string" },
        alert_type: { type: "string", enum: ["below_fmv_pct", "below_price"] },
        threshold: { type: "number" },
        channel: { type: "string", enum: ["email", "telegram", "both"] },
      },
      required: ["action"],
    },
  },
  {
    name: "escalate_to_human",
    description: "Escalate to Trevor (RPC creator) for account-specific problems the bot cannot resolve. Only use after trying to help.",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: { type: "string" },
        category: { type: "string", enum: ["bug", "account", "billing", "feature_request", "other"] },
        urgency: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["reason", "category"],
    },
  },
  {
    name: "get_collection_snapshot",
    description: "Get a shareable portfolio summary for a wallet. Use when user asks about their portfolio value or wants to share their collection.",
    input_schema: {
      type: "object" as const,
      properties: {
        walletAddress: { type: "string" },
      },
      required: ["walletAddress"],
    },
  },
  {
    name: "explain_fmv",
    description: "Detailed FMV breakdown with confidence and methodology for a specific edition.",
    input_schema: {
      type: "object" as const,
      properties: {
        editionKey: { type: "string" },
      },
      required: ["editionKey"],
    },
  },
];

// ── System prompt (v2: multi-collection aware) ────────────────────────────────
function buildSystemPrompt(ctx: {
  pageContext?: string;
  collectionId?: string;
  userWallet?: string;
  userEmail?: string;
  walletConnected?: boolean;
  marketPulse?: string;
  dailyDeal?: any;
}): string {
  const { pageContext, collectionId, userWallet, userEmail, walletConnected, marketPulse, dailyDeal } = ctx;

  const activeCollection = collectionId ? getCollection(collectionId) : null;
  const published = publishedCollections();
  const publishedLabels = published.map((c) => `${c.icon} ${c.label}`).join(", ");

  const collectionBlurb = activeCollection
    ? `\n## Active Collection
The user is currently browsing **${activeCollection.label}** (${activeCollection.sport}, ${activeCollection.partner}, ${activeCollection.chain.toUpperCase()} chain).
Treat THIS collection as the default scope for any query the user asks without naming a collection. If they ask about a different published collection, switch scope naturally.
When linking to pages, use ${activeCollection.id} paths, e.g. /${activeCollection.id}/sniper, /${activeCollection.id}/packs.`
    : `\n## Active Collection
The user is not on a collection-scoped page. Treat all published collections equally.`;

  const marketSection =
    marketPulse || dailyDeal
      ? `\n## Live Market Context (active collection, right now)
${marketPulse ? `- Market pulse: ${marketPulse}` : ""}
${dailyDeal ? `- Today's featured deal: ${dailyDeal.player_name ?? dailyDeal.playerName} ${dailyDeal.set_name ?? dailyDeal.setName ?? ""}, $${dailyDeal.low_ask ?? dailyDeal.askPrice} ask, FMV $${dailyDeal.fmv ?? dailyDeal.adjustedFmv}, ${dailyDeal.discount_pct ?? dailyDeal.discount}% below FMV${dailyDeal.badges?.length ? `, badges: ${dailyDeal.badges.join(", ")}` : ""}` : ""}
Use this context naturally in welcome messages and recommendations.`
      : "";

  const walletSection = userWallet
    ? `\n## User Context
- Signed in via email: ${userEmail ?? "(email on file)"}
- Wallet linked: ${userWallet}
- Call check_wallet with collectionId="${activeCollection?.id ?? ""}" when the user asks about their own collection.`
    : userEmail
    ? `\n## User Context
- Signed in via email: ${userEmail}
- No wallet linked yet. If they want portfolio analysis, prompt them to add a Top Shot / AllDay / Golazos / Pinnacle wallet on their Profile page.`
    : walletConnected
    ? `\n## User Context
- User has a wallet connected but address not yet provided.`
    : "";

  const pageSection = pageContext
    ? `\n## Current Page
User is on: ${pageContext}.
Tailor responses to this page's purpose:
- **overview**: ecosystem state — news, floor prices, pipeline health
- **collection**: the user's own moments — FMV, badges, acquisition history, holdings value
- **market**: sortable/filterable marketplace — help refine filters, recommend sort orders
- **packs**: pack EV — identify packs where EV > retail, highlight special serial alerts
- **sniper**: real-time deals — surface the best discounts, explain why each is a deal
- **badges**: badge editions — premiums, rarity, strategy
- **sets**: completion tracking — bottlenecks, cheapest path to finish a set
- **analytics**: ecosystem intelligence — top sales, tier trends, player analytics, series volume`
    : "";

  return `You are the RPC Concierge — the official AI assistant for Rip Packs City, a multi-collection intelligence platform for Flow blockchain digital collectibles.

## Your Persona
Part personal shopper, part portfolio advisor, part collector expert. You speak fluent collector across every collection RPC covers — moments, serials, FMV, floor, badges, rips, mints, Low Asks, parallel editions, set bottlenecks, pack EV. You are direct, helpful, and genuinely excited about finding good deals. You never pad responses with corporate fluff.

Keep responses concise — most users are on mobile. Short paragraphs, not bullet-heavy walls.

## What RPC Is
Rip Packs City (rippackscity.com) is a collector intelligence platform built by Trevor Dillon-Bond, an official Portland Trail Blazers Team Captain on NBA Top Shot. It covers these currently published collections: ${publishedLabels}. UFC Strike is tracked for catalog purposes only (near-zero on-chain volume; UFC migrated to Aptos — full coverage planned as a future layer).

Every published collection offers the same toolset where data supports it: Overview, Collection Analyzer, Market browser, Sniper feed, Sets tracker, Pack EV calculator, Badge tracker (NBA Top Shot only — badges are a Top Shot native concept), and Analytics. Users sign in with an email address to save wallets, pin trophy moments, and build their profile. Profile pages are public and shareable.

## FMV Methodology (v1.4.0 — be accurate)
- Recalculated every 20 minutes per collection via an automated pipeline
- Weighted average of recent sales with 7-day half-life decay
- Adjusted for sales volume (low-volume editions get wider confidence intervals)
- Confidence levels: HIGH (5+ sales, stable), MEDIUM (2+), LOW (1 sale, directional only)
- Caveat pricing when confidence is LOW, especially for Golazos / Pinnacle (thin volume)
- Top Shot has the deepest data. AllDay is shallower. Golazos and Pinnacle are thin — use relative-deals logic (100x floor outlier filter)

## Sniper Data Sources by Collection
- **NBA Top Shot**: Top Shot native marketplace GQL (primary) + Flowty.io (backup when Cloudflare blocks). Listings priced in DUC.
- **NFL All Day**: AllDay native GQL + Flowty. ~158 sales/day indexed.
- **LaLiga Golazos**: Flowty primary (native marketplace is Cloudflare-blocked from server IPs; requires proxy).
- **Disney Pinnacle**: Pinnacle native GQL (via Cloudflare Worker proxy) + Flowty.
- **UFC Strike**: Catalog only — near-zero volume.
If a feed is temporarily blocked, explain it and suggest Flowty's cross-marketplace coverage.

## What Makes Moments Valuable (varies by collection)
- **NBA Top Shot**: tier (Ultimate > Legendary > Rare > Fandom > Common), badges (Rookie Year, Top Shot Debut, Rookie Premiere, Rookie Mint, Three Stars, Championship Year), serial premium (#1, jersey serial, last mint), set completion demand, circulation, burn rate
- **NFL All Day**: tier, player position scarcity, team scarcity, set design, parallel (chase/rainbow), serial
- **LaLiga Golazos**: tier, club demand, player stardom, goal significance, parallel
- **Disney Pinnacle**: shape/variant, IP demand, serial, set completion
- **UFC Strike**: tier, fighter demand — but note on-chain volume is near zero post-Aptos migration

## Shopping & Recommendations (all collections)
1. Scope the query to the active collection by default. If the user names a different collection, switch.
2. Call search_live_deals first with collectionId set.
3. If live feed empty or erroring, fall back to search_catalog_deals.
4. Surface 3–5 concrete options with: player/subject name, tier, price, FMV, discount%, badges/parallel.
5. Give a clear buy/watch/pass recommendation when asked about a single item.
6. For budget queries ("I have $50"), optimize for value: badge presence, discount %, confidence. In thin-volume collections, weight toward floor proximity over FMV discount %.
7. Never invent prices — always use tool results.

## Cross-Collection Queries
- Use search_across_collections when the user asks about a player/subject without naming a collection, or when comparing availability across collections.
- Always mention which collection a result comes from in your response.

## Profile + Email Sign-In (2026-04)
RPC requires email sign-in to access any collection tool. Users sign in on /login with a magic link. Once signed in:
- They can save multiple wallets across collections from their /profile page
- Trophy case (up to 6 pinned moments) is shared across collections
- Their public profile at /profile/[username] remains shareable without auth
If a user says they can't access a page, first check if they're signed in. Escalation to Trevor is reserved for verified bugs, not sign-in friction.

## Common Questions (no tools needed)
- "How is FMV calculated?" → v1.4.0 WAP model, 20-min refresh, confidence levels
- "What are badges?" → Top Shot play tags; list the major ones; explain premium. Badges are a NBA Top Shot concept — AllDay/Golazos/Pinnacle have parallel editions instead.
- "Why is the sniper feed empty?" → explain per-collection proxy model (Cloudflare blocking is transient)
- "How do I buy a moment?" → Connect Dapper wallet on the native marketplace or Flowty; RPC deep-links directly
- "Does RPC support X collection?" → list published collections; confirm or mention a future layer${collectionBlurb}${marketSection}${walletSection}${pageSection}

## Escalation Rules
Escalate ONLY when you've tried to help and cannot resolve it:
- Moments missing after purchase
- Transaction completed but NFT not in wallet
- Email magic-link not arriving (after user has checked spam)
- Account-specific bugs you cannot diagnose
DO NOT escalate for: how-to, FMV questions, sniper timing, feature requests, or sign-in walkthroughs.

## Tone
Good: "That LeBron Rare is a solid buy at $18 — FMV is $26, so you're 31% below. Rookie Premiere badge makes it stickier to hold."
Bad: "That's a great question! I'd be happy to help you analyze that moment's value. Let me break it down for you..."

Respond in whatever language the user writes in.`;
}

// ── Tool execution ────────────────────────────────────────────────────────────
async function executeTool(
  toolName: string,
  toolInput: any,
  ctx: { sessionId: string; userWallet?: string; collectionId?: string }
): Promise<string> {
  const base = siteUrl();
  // Fall back to the active page's collection when the model didn't set one.
  const effectiveCollectionId: string | undefined = toolInput.collectionId ?? ctx.collectionId ?? undefined;
  const effectiveCollectionUuid: string | null = effectiveCollectionId
    ? (COLLECTION_UUID_BY_SLUG[effectiveCollectionId] ?? null)
    : null;

  if (toolName === "search_live_deals") {
    try {
      const params = new URLSearchParams();
      if (effectiveCollectionId) params.set("collectionId", effectiveCollectionId);
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
          buy_url: d.buyUrl || "",
        }));
        return JSON.stringify({ status: "ok", results, total: deals.length, collectionId: effectiveCollectionId ?? null });
      }
    } catch {
      // fall through to catalog
    }

    try {
      let query = supabase
        .from("cached_listings")
        .select("player_name, set_name, tier, serial_number, circulation_count, ask_price, fmv, discount, badge_slugs, buy_url, collection_id")
        .gt("discount", 0)
        .order("discount", { ascending: false })
        .limit(toolInput.limit || 10);
      if (effectiveCollectionUuid) query = query.eq("collection_id", effectiveCollectionUuid);
      if (toolInput.player) query = query.ilike("player_name", `%${toolInput.player}%`);
      if (toolInput.tier) query = query.ilike("tier", `%${toolInput.tier}%`);
      if (toolInput.maxPrice) query = query.lte("ask_price", toolInput.maxPrice);
      if (toolInput.minDiscount) query = query.gte("discount", toolInput.minDiscount);
      const { data: rows } = await query;
      if (rows && rows.length > 0) {
        const results = rows.map((d: any) => ({
          player: d.player_name,
          tier: d.tier,
          serial: d.serial_number,
          price: Number(d.ask_price),
          fmv: Number(d.fmv),
          discount_pct: Number(d.discount),
          source: "catalog",
          buy_url: d.buy_url || "",
        }));
        return JSON.stringify({ status: "ok", results, total: results.length, source: "catalog_fallback" });
      }
    } catch { /* silent */ }

    return JSON.stringify({ status: "no_results", message: "No deals found matching those criteria." });
  }

  if (toolName === "search_catalog_deals") {
    try {
      let query = supabase
        .from("cached_listings")
        .select("player_name, set_name, tier, serial_number, circulation_count, ask_price, fmv, discount, badge_slugs, buy_url, collection_id")
        .order("discount", { ascending: false })
        .limit(toolInput.limit || 8);
      if (effectiveCollectionUuid) query = query.eq("collection_id", effectiveCollectionUuid);
      if (toolInput.player) query = query.ilike("player_name", `%${toolInput.player}%`);
      if (toolInput.team) query = query.ilike("team_name", `%${toolInput.team}%`);
      if (toolInput.tier) query = query.ilike("tier", `%${toolInput.tier}%`);
      if (toolInput.maxPrice) query = query.lte("ask_price", toolInput.maxPrice);
      if (toolInput.minDiscount) query = query.gte("discount", toolInput.minDiscount);
      if (toolInput.hasBadge) query = query.not("badge_slugs", "is", null);

      const { data, error } = await query;
      if (error) return JSON.stringify({ status: "error", message: error.message });
      if (!data || data.length === 0) {
        return JSON.stringify({ status: "no_results", message: "No moments found matching those criteria." });
      }
      return JSON.stringify({
        status: "ok",
        results: data.map((d: any) => ({
          player: d.player_name,
          set: d.set_name,
          tier: d.tier,
          serial: d.serial_number,
          price: Number(d.ask_price),
          fmv: Number(d.fmv),
          discount_pct: Number(d.discount),
          badges: d.badge_slugs,
          buy_url: d.buy_url,
        })),
        total: data.length,
      });
    } catch (err: any) {
      return JSON.stringify({ status: "error", message: err.message });
    }
  }

  if (toolName === "get_fmv") {
    try {
      if (toolInput.editionKey) {
        const url = new URL(`${base}/api/fmv`);
        url.searchParams.set("edition", toolInput.editionKey);
        if (effectiveCollectionId) url.searchParams.set("collectionId", effectiveCollectionId);
        const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
        return JSON.stringify(await res.json());
      }
      if (toolInput.playerName) {
        let query = supabase
          .from("cached_listings")
          .select("player_name, set_name, tier, serial_number, ask_price, fmv, discount, collection_id")
          .ilike("player_name", `%${toolInput.playerName}%`)
          .not("fmv", "is", null)
          .limit(5);
        if (effectiveCollectionUuid) query = query.eq("collection_id", effectiveCollectionUuid);
        const { data, error } = await query;
        if (error || !data?.length) {
          return JSON.stringify({ status: "not_found", message: "No FMV data found for that player." });
        }
        return JSON.stringify({
          status: "ok",
          results: data.map((r: any) => ({
            player: r.player_name,
            set: r.set_name,
            tier: r.tier,
            low_ask: Number(r.ask_price),
            fmv: Number(r.fmv),
          })),
        });
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
        body: JSON.stringify({
          input: toolInput.walletAddress,
          collectionId: effectiveCollectionId ?? undefined,
        }),
        signal: AbortSignal.timeout(12000),
      });
      const data = await res.json();
      const moments = data.moments || data.rows || [];
      const totalFmv = moments.reduce((s: number, m: any) => s + (m.fmv ?? 0), 0);
      return JSON.stringify({
        status: "ok",
        wallet: toolInput.walletAddress,
        collection: effectiveCollectionId ?? null,
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

  if (toolName === "search_across_collections") {
    try {
      const name = String(toolInput.name || "").trim();
      if (!name) return JSON.stringify({ status: "error", message: "name required" });
      const perCollection = Math.min(Math.max(toolInput.limit || 3, 1), 10);

      const published = publishedCollections();
      const queries = published.map(async (col) => {
        const uuid = col.supabaseCollectionId;
        if (!uuid) return { collection: col.label, collectionId: col.id, results: [] };
        const { data } = await supabase
          .from("cached_listings")
          .select("player_name, set_name, tier, serial_number, ask_price, fmv, discount, buy_url")
          .eq("collection_id", uuid)
          .ilike("player_name", `%${name}%`)
          .order("discount", { ascending: false })
          .limit(perCollection);
        return {
          collection: col.label,
          collectionId: col.id,
          results: (data ?? []).map((r: any) => ({
            player: r.player_name,
            set: r.set_name,
            tier: r.tier,
            serial: r.serial_number,
            price: Number(r.ask_price),
            fmv: r.fmv != null ? Number(r.fmv) : null,
            discount_pct: r.discount != null ? Number(r.discount) : null,
            buy_url: r.buy_url,
          })),
        };
      });
      const grouped = await Promise.all(queries);
      const total = grouped.reduce((sum, g) => sum + g.results.length, 0);
      return JSON.stringify({ status: "ok", total, groups: grouped });
    } catch (err: any) {
      return JSON.stringify({ status: "error", message: err?.message ?? "search_across_collections failed" });
    }
  }

  if (toolName === "manage_watchlist") {
    if (!ctx.userWallet) return JSON.stringify({ status: "error", message: "owner_key_missing" });
    try {
      if (toolInput.action === "list") {
        const res = await fetch(`${base}/api/watchlist?owner_key=${encodeURIComponent(ctx.userWallet)}`, { signal: AbortSignal.timeout(8000) });
        const data = await res.json();
        const items = data.watchlist || data.items || data || [];
        if (!Array.isArray(items) || items.length === 0) {
          return JSON.stringify({ status: "ok", message: "Your watchlist is empty.", results: [] });
        }
        return JSON.stringify({ status: "ok", results: items });
      }
      if (toolInput.action === "add") {
        const res = await fetch(`${base}/api/watchlist`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner_key: ctx.userWallet, edition_key: toolInput.edition_key,
            player_name: toolInput.player_name, set_name: toolInput.set_name,
            tier: toolInput.tier, thumbnail_url: toolInput.thumbnail_url,
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
          body: JSON.stringify({ owner_key: ctx.userWallet, edition_key: toolInput.edition_key }),
          signal: AbortSignal.timeout(8000),
        });
        await res.json();
        return JSON.stringify({ status: "ok", message: "Removed from your watchlist." });
      }
      return JSON.stringify({ status: "error", message: "Invalid action." });
    } catch (err: any) {
      return JSON.stringify({ status: "error", message: err.message });
    }
  }

  if (toolName === "manage_alerts") {
    if (!ctx.userWallet) return JSON.stringify({ status: "error", message: "owner_key_missing" });
    try {
      if (toolInput.action === "list") {
        const res = await fetch(`${base}/api/alerts?owner_key=${encodeURIComponent(ctx.userWallet)}`, { signal: AbortSignal.timeout(8000) });
        const data = await res.json();
        const alerts = data.alerts || data.items || data || [];
        if (!Array.isArray(alerts) || alerts.length === 0) {
          return JSON.stringify({ status: "ok", message: "You have no active alerts.", results: [] });
        }
        return JSON.stringify({ status: "ok", results: alerts });
      }
      if (toolInput.action === "set") {
        const res = await fetch(`${base}/api/alerts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner_key: ctx.userWallet, edition_key: toolInput.edition_key,
            player_name: toolInput.player_name, alert_type: toolInput.alert_type,
            threshold: toolInput.threshold, channel: toolInput.channel,
          }),
          signal: AbortSignal.timeout(8000),
        });
        const data = await res.json();
        return JSON.stringify({ status: "ok", message: `Alert set for ${toolInput.player_name || "moment"}.`, data });
      }
      if (toolInput.action === "remove") {
        await fetch(`${base}/api/alerts`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ owner_key: ctx.userWallet, edition_key: toolInput.edition_key }),
          signal: AbortSignal.timeout(8000),
        });
        return JSON.stringify({ status: "ok", message: "Alert removed." });
      }
      return JSON.stringify({ status: "error", message: "Invalid action." });
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

  if (toolName === "explain_fmv") {
    try {
      const editionKey = toolInput.editionKey;
      if (!editionKey) return JSON.stringify({ status: "error", message: "editionKey is required" });

      const { data: edition } = await supabase
        .from("editions")
        .select("id, player_name, set_name, tier")
        .eq("external_id", editionKey)
        .single();

      if (!edition?.id) {
        return JSON.stringify({ status: "not_found", message: "Edition not found for that key." });
      }

      const { data: snapshot } = await supabase
        .from("fmv_snapshots")
        .select("fmv_usd, confidence, wap_usd, floor_price_usd, computed_at, sales_count_30d, days_since_sale, ask_proxy_fmv, algo_version")
        .eq("edition_id", edition.id)
        .order("computed_at", { ascending: false })
        .limit(1)
        .single();

      if (!snapshot) return JSON.stringify({ status: "no_data", message: "No FMV snapshot yet." });

      const computedAgo = snapshot.computed_at
        ? `${Math.round((Date.now() - new Date(snapshot.computed_at).getTime()) / 60000)} minutes ago`
        : "unknown";
      const salesNote = snapshot.sales_count_30d ? `across ${snapshot.sales_count_30d} recent sales` : "with limited sales data";
      const explanation = `FMV is $${Number(snapshot.fmv_usd).toFixed(2)} (${snapshot.confidence} confidence) based on a 30-day WAP of $${Number(snapshot.wap_usd || 0).toFixed(2)} ${salesNote}. Floor price is $${Number(snapshot.floor_price_usd || 0).toFixed(2)}. Last computed ${computedAgo}.${snapshot.ask_proxy_fmv ? ` Ask proxy FMV: $${Number(snapshot.ask_proxy_fmv).toFixed(2)}.` : ""}`;

      return JSON.stringify({
        status: "ok",
        player_name: edition.player_name ?? null,
        set_name: edition.set_name ?? null,
        tier: edition.tier ?? null,
        fmv_usd: snapshot.fmv_usd,
        confidence: snapshot.confidence,
        wap_usd: snapshot.wap_usd,
        floor_price_usd: snapshot.floor_price_usd,
        computed_at: snapshot.computed_at,
        explanation,
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
            subject: `[RPC Support] ${category} — ${urgency ?? "medium"} urgency`,
            text: `Session: ${ctx.sessionId}\nCategory: ${category}\nUrgency: ${urgency ?? "medium"}\n\nIssue:\n${reason}`,
          }),
        });
      }
    } catch { /* non-fatal */ }
    return JSON.stringify({ status: "escalated", message: "Trevor has been notified and will follow up via Discord or email." });
  }

  return JSON.stringify({ status: "error", message: `Unknown tool: ${toolName}` });
}

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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      message,
      sessionId = `anon-${Date.now()}`,
      userWallet,
      userEmail,
      pageContext,
      collectionId,
      walletConnected,
      conversationHistory = [],
      marketPulse,
      dailyDeal,
      stream: useStream = false,
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

    const systemPrompt = buildSystemPrompt({ pageContext, collectionId, userWallet, userEmail, walletConnected, marketPulse, dailyDeal });
    const recentHistory = conversationHistory.slice(-10);
    const messages: Anthropic.MessageParam[] = [
      ...recentHistory,
      { role: "user" as const, content: message },
    ];

    let finalResponse = "";
    let escalated = false;
    let escalationReason: string | undefined;
    const usedTools: string[] = [];
    let currentMessages = messages;
    let iterations = 0;
    const MAX_ITERATIONS = 5;

    let streamWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
    let streamResponse: Response | null = null;
    const encoder = new TextEncoder();
    if (useStream) {
      const ts = new TransformStream<Uint8Array, Uint8Array>();
      streamWriter = ts.writable.getWriter();
      streamResponse = new Response(ts.readable, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-RPC-Stream": "1",
          "X-Accel-Buffering": "no",
        },
      });
    }

    const runIterationStreaming = async () => {
      const stream = anthropic.messages.stream({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: systemPrompt,
        tools: TOOLS,
        messages: currentMessages,
      });
      stream.on("text", (text: string) => {
        if (streamWriter) {
          streamWriter.write(encoder.encode(text)).catch(() => {});
        }
      });
      return await stream.finalMessage();
    };

    const runLoop = async () => {
      while (iterations < MAX_ITERATIONS) {
        iterations++;
        const response = useStream
          ? await runIterationStreaming()
          : await anthropic.messages.create({
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
            const result = await Promise.race([
              executeTool(tb.name, tb.input, { sessionId, userWallet, collectionId }),
              new Promise<string>((resolve) =>
                setTimeout(() => resolve(JSON.stringify({ status: "timeout", message: "Tool timed out — try a simpler query" })), 6000)
              ),
            ]);
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
    };

    const finalize = async () => {
      if (!finalResponse) {
        finalResponse = "That query was too complex for me to handle in time. Try breaking it down. You can also check the Sniper page directly for the full live feed.";
      }
      if (escalated) {
        finalResponse += "\n\nYou can also DM us directly at https://twitter.com/RipPacksCity for a faster response.";
      }

      const playerSearched =
        usedTools.includes("search_catalog_deals") || usedTools.includes("search_live_deals") || usedTools.includes("search_across_collections")
          ? body.message.match(/\b([A-Z][a-z]+ [A-Z][a-z]+)\b/)?.[0] ?? undefined
          : undefined;

      const category = classifyCategory(message);

      let messageId: number | null = null;
      try {
        const { data: ins } = await supabase.from("support_conversations").insert({
          session_id: sessionId,
          user_message: message,
          bot_response: finalResponse,
          escalated,
          escalation_reason: escalationReason ?? null,
          category,
          resolved: !escalated,
          user_wallet: userWallet ?? null,
          page_context: pageContext ?? null,
        }).select("id").single();
        messageId = ins?.id ?? null;
      } catch { /* non-fatal */ }

      updateSession(sessionId, category, message, playerSearched).catch(() => {});

      return { response: finalResponse, escalated, escalationReason, category, messageId };
    };

    if (useStream && streamResponse && streamWriter) {
      (async () => {
        try {
          await runLoop();
        } catch {
          try { await streamWriter!.write(encoder.encode("\n\n[stream error]")); } catch {}
        }
        const meta = await finalize();
        try {
          await streamWriter!.write(encoder.encode("\x1e" + JSON.stringify(meta)));
        } catch {}
        try { await streamWriter!.close(); } catch {}
      })();
      return streamResponse;
    }

    await runLoop();
    const meta = await finalize();
    return NextResponse.json(meta);
  } catch (err: any) {
    console.error("[support-chat] Error:", err);
    return NextResponse.json(
      { response: "Something went wrong on my end. Try again, or reach out to Trevor on Discord.", escalated: false, category: "error" },
      { status: 200 }
    );
  }
}
