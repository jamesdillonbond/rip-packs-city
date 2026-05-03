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

export const maxDuration = 60;

import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { getCollection, publishedCollections, COLLECTION_UUID_BY_SLUG } from "@/lib/collections";
import {
  isPinnacle,
  searchPinnacleDeals,
  getPinnacleFmv,
  explainPinnacleFmv,
  searchPinnacleByName,
} from "@/lib/concierge/pinnacle-router";
import {
  fetchUnifiedFmvDistribution,
  fetchPinnacleFmvDistribution,
  type FmvDistributionResult,
} from "@/lib/concierge/fmv-distribution";

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// Greeting fast-path — trivial inputs skip the heavy tool-loop entirely.
// Why: the system prompt + 10 tool descriptions inflate first-token latency
// enough that "Ping" was reliably hitting MAX_ITERATIONS and returning the
// timeout fallback instead of a quick reply.
const GREETING_RE = /^\s*(hi+|hello|ping|hey+|sup|test|yo|hola|howdy|gm|gn)\s*[!.?]*\s*$/i;

// ── Anthropic error classification ────────────────────────────────────────────
// Distinguish credit-balance / billing / auth (long-tail outage we can't fix
// from the user side), rate-limit / 429 (transient), and overloaded / 5xx /
// network (transient Anthropic-side). Each maps to a distinct user-meaningful
// message so we don't tell users "your query was too complex" when the real
// problem is our wallet balance.
type ConciergeErrorMode = "credit_balance" | "rate_limit" | "overloaded" | "unknown";

function classifyAnthropicError(err: any): ConciergeErrorMode {
  const status: number = Number(err?.status ?? 0);
  // SDK normalises this onto err.type, but defensive lookups cover wrapped
  // errors and fetch-layer failures where the body never parsed.
  const errType: string = String(err?.type ?? err?.error?.error?.type ?? err?.error?.type ?? "");
  const msg: string = String(err?.message ?? err ?? "").toLowerCase();
  const name: string = String(err?.name ?? "");

  if (
    status === 401 || status === 402 || status === 403 ||
    errType === "authentication_error" ||
    errType === "permission_error" ||
    /credit\s*balance|insufficient[_\s]+(?:funds|credit|balance)|invalid[_\s]+api[_\s]+key|billing/.test(msg)
  ) {
    return "credit_balance";
  }
  if (status === 429 || errType === "rate_limit_error" || /rate[_\s]*limit/.test(msg)) {
    return "rate_limit";
  }
  if (
    status >= 500 ||
    errType === "overloaded_error" ||
    errType === "api_error" ||
    name === "APIConnectionError" ||
    name === "APIConnectionTimeoutError" ||
    /overloaded|connection|fetch failed|network|timeout|socket/.test(msg)
  ) {
    return "overloaded";
  }
  return "unknown";
}

const CONCIERGE_ERROR_MESSAGES: Record<ConciergeErrorMode, { response: string; category: string }> = {
  credit_balance: {
    response:
      "AI concierge is temporarily unavailable. The collector tools below still work — try the Sniper page or browse Sets.",
    category: "concierge_unavailable",
  },
  rate_limit: {
    response:
      "AI concierge is busy. Please try again in a minute, or use the Sniper page directly.",
    category: "concierge_rate_limited",
  },
  overloaded: {
    response:
      "AI concierge is having a moment. Please try again shortly.",
    category: "concierge_overloaded",
  },
  unknown: {
    response:
      "Something went wrong on my end. Try again, or reach out to Trevor on Discord.",
    category: "error",
  },
};

// Test-only synthetic error injector. Smoke test uses this to verify the
// graceful-degradation path without an actual Anthropic outage. Gated by
// INGEST_SECRET_TOKEN so it can't be triggered by random clients. Mode values
// match ConciergeErrorMode keys (sans "unknown" — that one is the catch-all
// default if a header is unrecognised).
function buildSyntheticError(mode: string): Error & { status?: number; type?: string } {
  if (mode === "credit_balance") {
    const e: any = new Error("Your credit balance is too low to access the Anthropic API.");
    e.status = 403;
    e.type = "permission_error";
    return e;
  }
  if (mode === "rate_limit") {
    const e: any = new Error("Number of request tokens has exceeded your rate limit.");
    e.status = 429;
    e.type = "rate_limit_error";
    return e;
  }
  if (mode === "overloaded") {
    const e: any = new Error("Anthropic is temporarily overloaded.");
    e.status = 529;
    e.type = "overloaded_error";
    return e;
  }
  const e: any = new Error("synthetic unknown error");
  e.status = 500;
  return e;
}

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
    description: "Search for live deals from the RPC sniper feed for the active collection. Use this first for any shopping query. Returns real listings with prices, FMV discounts, and buy links. Defaults to the page's active collection when collectionId is omitted. CRITICAL: when the user names a specific person — a player (NBA/NFL/Golazos/UFC) or a character (Disney Pinnacle: Mickey, Goofy, Greef Karga, etc.) — you MUST pass that name in the `player` parameter (or `character` for Pinnacle). Never return unfiltered top-discount results when the user asked about someone specific.",
    input_schema: {
      type: "object" as const,
      properties: {
        collectionId: { type: "string", description: "Collection id (nba-top-shot, nfl-all-day, laliga-golazos, disney-pinnacle). Defaults to the active page's collection." },
        player: { type: "string", description: "Player or subject name to filter by (partial match, case-insensitive). REQUIRED whenever the user names a specific person — pass 'LeBron James', 'Patrick Mahomes', 'Messi', etc. For sports collections." },
        character: { type: "string", description: "Character name for Disney Pinnacle (e.g. 'Goofy', 'Mickey Mouse', 'Greef Karga'). REQUIRED whenever the user names a specific character on Pinnacle. Aliased to `player` server-side; pass either field." },
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
    description: "Search the RPC moment catalog via Supabase — player, tier, price, badges, FMV. Use as fallback when live feed is unavailable, or for badge-specific queries. CRITICAL: when the user names a specific person/character, you MUST pass `player` (sports) or `character` (Pinnacle) — never return unfiltered top-discount results.",
    input_schema: {
      type: "object" as const,
      properties: {
        collectionId: { type: "string", description: "Collection id. Defaults to the active page's collection." },
        player: { type: "string", description: "Player or subject name (partial match, case-insensitive). REQUIRED whenever the user names a specific person." },
        character: { type: "string", description: "Character name for Disney Pinnacle. REQUIRED whenever the user names a specific Pinnacle character. Aliased to `player`." },
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
    description: "Get catalog Fair Market Value from editions + fmv_snapshots (NOT current listings). Returns one of two shapes: 'single' (one edition matched) or 'distribution' ({count, median_fmv, p10, p90, min_fmv, max_fmv, sample_editions[]}). Use this for any price-comparison question — 'is $X fair for [player] [tier]?', 'what's a [player] [tier] worth?'. The catalog is independent of current listings, so a non-empty FMV exists even when nothing is for sale right now. Provide editionKey for a specific edition, or any combination of playerName/characterName + tier + setName for a filtered distribution. CRITICAL: when the user names a specific person, ALWAYS pass that exact name as playerName (sports) or characterName (Pinnacle).",
    input_schema: {
      type: "object" as const,
      properties: {
        collectionId: { type: "string", description: "Collection id. Defaults to the active page's collection." },
        editionKey: { type: "string", description: "Specific edition (setID:playID for Top Shot, opaque key for Pinnacle). Returns single-edition shape." },
        playerName: { type: "string", description: "Player name (sports). Returns distribution across the matching editions." },
        characterName: { type: "string", description: "Character name (Disney Pinnacle). Aliased to playerName server-side." },
        setName: { type: "string", description: "Set name (partial match). Use to narrow the distribution to one set." },
        tier: { type: "string", description: "Tier (COMMON, RARE, LEGENDARY, etc., or Pinnacle variant_type). Use to narrow the distribution to one tier." },
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

## CRITICAL — Not Financial Advice (zero-tolerance rule)
Nothing you say is financial advice. FMV values, deal scores, set valuations, pack expected values, and similar metrics are model outputs with inherent uncertainty. When users ask whether to buy, sell, or hold something, surface the data they need to make their own decision rather than telling them what to do.

Never use directive language that implies a buy/sell recommendation. The following phrases (and any close paraphrase) are banned from your output, even when hedged or qualified:
- "worth buying" / "worth picking up" / "worth grabbing"
- "great deal" / "good deal" / "solid deal" / "exceptional deal" / "killer deal"
- "you should buy" / "you should sell" / "you should hold" / "you should grab"
- "exceptional" / "incredible" / "amazing" / "fantastic" applied to a price, listing, or moment
- "snag this" / "snag it" / "snap it up" / "pick this up" / "grab this"
- "pull the trigger" / "jump on this" / "lock it in"
- "buy now" / "act fast" / "don't miss" / "won't last"
- "I recommend" / "my recommendation" / "I'd buy" / "I'd grab"

Instead always state the data factually:
- "This listing is at the median FMV for [player] [tier]."
- "This is in the bottom quartile of recent sales."
- "Ask is $X, FMV is $Y (HIGH confidence), implied discount is Z%."
- "No comparable sales in the last 30 days — pricing is directional only."

If asked "should I buy this?" or "is this a deal?", respond with the data context plus an explicit statement that you don't make buy/sell calls. Example: "FMV is $X with HIGH confidence over the last 30 days, ask is $Y, that's the bottom 20% of recent listings. I don't make buy/sell recommendations — that's your decision."

Even one directive phrase fails our quality bar. Always inform, never advise.

## CRITICAL — FMV numbers must come from a tool call this turn
Never quote FMV numbers, ranges, floors, percentiles, or distributions from memory, training data, or prior conversation context. If you reference any price, FMV, floor, range, or "typical" figure in your response, you must have called get_fmv, search_catalog_deals, or search_live_deals in this turn and be quoting from a tool result row in that turn's output.

Saying things like "typical floor is $X-Y", "LeBron Commons usually trade in the $A-B range", or "Commons of this tier go for around $Z" without a tool call in this turn is a critical failure. Paraphrasing a remembered number from training data is also a critical failure. The only valid sources are tool result rows from this turn.

Soft directional claims about prices count as price assertions. Phrases like "typically command premium prices", "tend to hold value", "usually trade higher", "star players generally appreciate", "Rookie Premiere badges hold premium", "scarce serials carry a premium" — all of these are price claims even though they don't quote a number. If you make one, you must have a tool result this turn that supports it (e.g. a distribution showing a measurable premium tied to the badge or scarcity factor). Otherwise omit the claim and let the data speak. The default for unquantifiable directional language is silence.

If the relevant tool call returns no results or the matching row's fmv is null, say so honestly — do NOT fall back to a remembered range, a generalised heuristic, or a "ballpark" estimate. Acceptable: "search_catalog_deals returned no LeBron Commons matching your filters, so I can't price-check this from current data." Unacceptable: "LeBron Commons typically floor in the $8-15 range."

## CRITICAL — Tier filtering on FMV tools
When a user mentions a tier — Common, Rare, Fandom, Legendary, Ultimate (NBA Top Shot / NFL All Day / LaLiga Golazos), Standard / Sketch / Mosaic / etc. (Pinnacle variant_type) — you MUST pass that tier into get_fmv or search_catalog_deals. Tier-stripped FMV distributions mix lower-tier moments with much higher-tier ones, and the median of the mixed distribution is misleading for any specific tier.

Concrete shape of the gap, verified live: a tier-stripped LeBron James get_fmv call returns p50 = $20 across n=124 editions. The same query with tier="COMMON" returns p50 = $2.50 across n=59. A user asking "Should I buy this LeBron Common at $3?" who gets the tier-stripped answer would conclude $3 is "below the median" — but it is actually approximately at the median for LeBron Commons specifically. That is a fail of this rule.

If the user names a tier and you do not pass it, you fail this rule. The tier parameter accepts any case (common, COMMON, Common all work) — the server normalizes before the SQL filter.

## What RPC Is
Rip Packs City (rippackscity.com) is a collector intelligence platform built by Trevor Dillon-Bond, an official Portland Trail Blazers Team Captain on NBA Top Shot. It covers these currently published collections: ${publishedLabels}. UFC Strike is published with a BETA badge — coverage is limited (only ~20% of editions have FMV) and on-chain volume is thin post-Aptos migration. Tell users explicitly that UFC coverage is limited when they ask — don't pretend the data is complete.

Every published collection offers the same toolset where data supports it: Overview, Collection Analyzer, Market browser, Sniper feed, Sets tracker, Pack EV calculator, Badge tracker (NBA Top Shot only — badges are a Top Shot native concept), and Analytics. Users sign in with an email address to save wallets, pin trophy moments, and build their profile. Profile pages are public and shareable.

## FMV Methodology (v1.5.0 — be accurate)
- Recalculated every 20 minutes per collection via an automated pipeline (Pinnacle FMV runs on a parallel pipeline keyed off pinnacle_fmv_snapshots)
- Weighted average of recent sales with 7-day half-life decay (WAP)
- Adjusts for days_since_sale and sales_count_30d (v1.5.0)
- Confidence levels: HIGH (5+ sales, stable), MEDIUM (2+), LOW (1 sale, directional only)
- Caveat pricing when confidence is LOW, especially for Golazos / UFC (thin volume)

## FMV Coverage Reality (per published collection)
- **NBA Top Shot**: 100%+ catalog (model-fitted, ample sales) — FMV is statistically meaningful
- **NFL All Day**: 100% catalog (29% HIGH/MEDIUM confidence, rest LOW from ask-only) — FMV is directional in tail
- **Disney Pinnacle**: 86% catalog (367 of 425 editions) — FMV is directional
- **LaLiga Golazos**: 12.9% (75 of 581 editions) — for the other 87%, answer with floor + recent-sales context, NOT "FMV says X". Surface the gap when asked.
- **UFC Strike**: 19.7% (29 of 147 editions, BETA) — answer with floor + last-sale heuristics over FMV-discount math
When confidence is LOW or coverage is below 50% for a collection, proactively note the limitation when surfacing FMV. Use the relative-deals 100x-floor outlier filter for thin-volume collections (Golazos, UFC) instead of FMV-discount %.

## Pinnacle Routing (invariant)
If the active collection is Disney Pinnacle, FMV and listings live in the pinnacle_* parallel tables — the tool layer handles routing automatically. Do not warn the user about a different schema.

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

## CRITICAL — Tool routing for price-comparison queries
When a user asks whether a price is good, fair, low, or high — phrases like "should I buy at $X", "is $X a deal", "is $X fair", "how does $X compare", "is $X a good price", "is this overpriced/underpriced at $X" — your first tool call MUST be get_fmv or search_catalog_deals, NOT search_live_deals. Live listings answer "what is available". Catalog and FMV answer "what is it worth". Use the right one for the question.

If search_live_deals returns no results AND the user's question implies a price comparison (or the user has named a specific player/character), you MUST chain a search_catalog_deals or get_fmv call before responding. Telling the user "I don't have data" without trying the catalog/FMV fallback is a critical failure — the catalog has FMV snapshots even when the live marketplace has no listings.

Concrete example: "Should I buy this LeBron Common at $3?" — first call get_fmv with playerName="LeBron James" (and tier="COMMON" if available) or search_catalog_deals with player="LeBron James", tier="COMMON". The catalog will surface the median FMV across all LeBron Common editions, which is what the user actually needs to compare $3 against. Only then mention live availability.

## CRITICAL — Reading get_fmv and search_catalog_deals responses
get_fmv and search_catalog_deals (when they fall through to the catalog) return one of two shapes: **distribution** or **single**. Both are catalog-derived from editions + fmv_snapshots — they exist independently of whether anything is currently listed.

When mode = "distribution" (count >= 2):
- Surface the median (median_fmv field) and the middle-80% range (p10 to p90) so the user can compare the asked price.
- Cite count to convey breadth: "Across 307 LeBron Commons, the median FMV is $2 (middle 80% spans $1 to $25)."
- Optionally name 1-3 sample_editions to make the answer concrete.
- Frame the user's price relative to the distribution: at the median, above the 90th percentile, below the 10th percentile.
- Do NOT invent quantiles or counts that aren't in the response.

When mode = "single" (count = 1):
- Surface the single edition's fmv with its confidence label and the exact set/player/tier the row carries.
- "FMV is $X (HIGH confidence) for the LeBron James Common in Set Y."
- Same Not-Financial-Advice and FMV-from-tool-call rules apply.

When status = "no_results":
- Say so honestly. Do NOT fall back to a remembered range or invent a "ballpark."
- "The catalog has no editions matching that filter — try a broader query."

## Shopping queries (all collections)
1. Scope the query to the active collection by default. If the user names a different collection, switch.
2. Choose the right tool for the question:
   - "What's available?" / "Show me deals" / "Anything under $X?" → search_live_deals first.
   - "Is $X fair?" / "Should I buy at $X?" / "How does $X compare?" → get_fmv or search_catalog_deals first (see Tool routing rule above).
3. If live feed empty or erroring, fall back to search_catalog_deals. If a price-comparison question yielded no live rows, you MUST chain search_catalog_deals or get_fmv before responding.
4. Surface 3–5 concrete options with: player/subject name, tier, price, FMV, discount%, badges/parallel.
5. When asked about a single item, surface the data context (FMV with confidence, recent ask range, badges, serial, where the listing sits in the recent-sales distribution) WITHOUT a buy/watch/pass directive. The "Not Financial Advice" rule above governs phrasing.
6. For budget queries ("I have $50"), optimize for value: badge presence, discount %, confidence. In thin-volume collections, weight toward floor proximity over FMV discount %.
7. Never invent prices — every price you quote must come from a tool result in this turn (see the FMV-from-tool-call rule above).

## CRITICAL — Name Filtering Rule
If the user names a specific player or character anywhere in their query — "LeBron James", "Patrick Mahomes", "Messi", "Goofy", "Mickey Mouse", "Greef Karga", "Iron Man", etc. — you MUST pass that exact name as a filter to every search and FMV tool call:
- search_live_deals / search_catalog_deals: pass it as \`player\` (sports collections) or \`character\` (Disney Pinnacle).
- get_fmv: pass it as \`playerName\` (sports) or \`characterName\` (Pinnacle).
- search_across_collections: pass it as \`name\`.
NEVER call these tools without the name filter when the user has named someone specific. NEVER label a returned row with a name the row doesn't actually have. If the filtered search returns zero rows, say so honestly ("No Goofy pins under $50 right now") — do NOT silently substitute a different character or player and present it as the requested one. The data layer filters by ILIKE on the canonical name column, so partial matches and case-insensitive matching just work.

## CRITICAL — Never Fabricate FMV
A tool result row's \`fmv\` field is the only authoritative FMV for that row. If \`fmv\` is null or missing on a row you surface, you MUST report the listing's ask price as-is and explicitly note that FMV data is unavailable for that exact edition. Never:
- Borrow an FMV value from a different row in the same result set.
- Compute or quote a discount percentage when fmv is null.
- Invent an "approximate" or "around $X" FMV figure from prior context, related editions, or training data.
- Say things like "FMV ~$29" unless that exact number appeared in the tool result for the exact row you're describing.
If every row in a tool result has fmv=null, surface them as raw listings: "Found N Goofy listings starting at $X — FMV data isn't available for these editions yet."

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
- "How is FMV calculated?" → v1.5.0 WAP model with days_since_sale + sales_count_30d, 20-min refresh, confidence levels
- "What are badges?" → Top Shot play tags; list the major ones; explain premium. Badges are a NBA Top Shot concept — AllDay/Golazos/Pinnacle have parallel editions instead.
- "Why is the sniper feed empty?" → explain per-collection proxy model (Cloudflare blocking is transient)
- "How do I buy a moment?" → Connect Dapper wallet on the native marketplace or Flowty; RPC deep-links directly
- "Does RPC support X collection?" → list published collections; confirm or mention a future layer
- "My All Day moments disappeared / are missing" → Probably locked for set-completion rewards. AllDay lets users lock moments to earn set-completion bonuses, and locked moments temporarily disappear from the standard wallet view (they're still on-chain, just hidden from the AllDay UI). Ask the user to check their AllDay set-completion / vault page before treating this as a bug or escalating.${collectionBlurb}${marketSection}${walletSection}${pageSection}

## Escalation Rules
Escalate ONLY when you've tried to help and cannot resolve it:
- Moments missing after purchase (for AllDay specifically: first ask if the user has locked any moments for set completion — that's the #1 root cause and not a bug)
- Transaction completed but NFT not in wallet
- Email magic-link not arriving (after user has checked spam)
- Account-specific bugs you cannot diagnose
DO NOT escalate for: how-to, FMV questions, sniper timing, feature requests, or sign-in walkthroughs.

## Tone
Good: "That LeBron Rare lists at $18. FMV is $26 (HIGH confidence, 12 sales in 30d), so the ask is 31% under FMV. The moment carries a Rookie Premiere badge."
Good — tier-aware tool routing: When the user says "Should I buy this LeBron Common at $3?", call get_fmv with playerName="LeBron James" AND tier="COMMON" — never tier-stripped. The Common-only distribution gives a meaningful median; the all-tier distribution mixes Commons with Legendaries and is misleading.
Bad — directive: "That LeBron Rare is a solid buy at $18 — you should grab it." (banned phrasing per the Not Financial Advice rule)
Bad — soft directional claim without data: "Rookie Premiere badges tend to hold premium relative to non-badged Rares." (no tool call this turn measured the badge premium — if you didn't measure it, don't claim it)
Bad — fluff: "That's a great question! I'd be happy to help you analyze that moment's value. Let me break it down for you..."

Respond in whatever language the user writes in.`;
}

// ── FMV distribution result formatter ─────────────────────────────────────────
// Centralised JSON shape for tool output. Distribution mode surfaces the
// {count, p10, p50, p90, min, max, samples[]} the model uses to give
// percentile-aware FMV answers; single mode preserves the per-edition
// shape the model already knows how to read. The collectionId echo helps
// the model frame "across N NBA Top Shot editions" vs cross-collection.
function formatDistributionForModel(
  result: FmvDistributionResult,
  collectionId: string | null
): string {
  if (result.status === "no_results") {
    return JSON.stringify({ status: "no_results", message: result.message, collectionId });
  }
  if (result.mode === "single") {
    return JSON.stringify({
      status: "ok",
      mode: "single",
      collectionId,
      edition: {
        edition_id: result.edition.edition_id,
        external_id: result.edition.external_id,
        player: result.edition.player_name,
        set: result.edition.set_name,
        tier: result.edition.tier,
        fmv: result.edition.fmv_usd,
        confidence: result.edition.confidence,
        updated_at: result.edition.computed_at,
      },
    });
  }
  return JSON.stringify({
    status: "ok",
    mode: "distribution",
    collectionId,
    count: result.count,
    median_fmv: result.p50,
    p10: result.p10,
    p90: result.p90,
    min_fmv: result.min_fmv,
    max_fmv: result.max_fmv,
    sample_editions: result.sample_editions.map((s) => ({
      external_id: s.external_id,
      player: s.player_name,
      set: s.set_name,
      tier: s.tier,
      fmv: s.fmv_usd,
      confidence: s.confidence,
    })),
  });
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

  // Normalize Pinnacle-friendly aliases onto the canonical filter fields. The
  // model sees `character` / `characterName` as Disney-natural parameter names
  // and the server collapses them onto `player` / `playerName` so downstream
  // handlers and Pinnacle router stay single-path.
  if (toolInput && typeof toolInput === "object") {
    if (toolInput.character && !toolInput.player) toolInput.player = toolInput.character;
    if (toolInput.characterName && !toolInput.playerName) toolInput.playerName = toolInput.characterName;
  }

  // Soft validation of edition-key shape against the active collection.
  // Returns a warning result string when the shape is wrong; null when fine.
  const editionKeyMismatchWarning = (key: unknown): string | null => {
    if (!key || typeof key !== "string" || !effectiveCollectionId) return null;
    const looksLikeTopShot = /^\d+:\d+$/.test(key);
    if (effectiveCollectionId === "nba-top-shot" && !looksLikeTopShot) {
      return JSON.stringify({
        status: "wrong_collection",
        message: `Edition key '${key}' doesn't match the Top Shot setID:playID format. Provide playerName instead, or check the active collection.`,
      });
    }
    if (isPinnacle(effectiveCollectionId) && looksLikeTopShot) {
      return JSON.stringify({
        status: "wrong_collection",
        message: "That edition key shape (setID:playID) belongs to Top Shot. Disney Pinnacle uses opaque edition_key strings.",
      });
    }
    return null;
  };

  if (toolName === "search_live_deals") {
    if (isPinnacle(effectiveCollectionId)) {
      return searchPinnacleDeals(supabase, toolInput, { source: "live" });
    }
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
    if (isPinnacle(effectiveCollectionId)) {
      // Pinnacle: try the listing-aware searchPinnacleDeals first (preserves
      // the smoke-test character_name probe behavior). When it returns
      // no_results AND a character/setName/variant filter is present, fall
      // through to the catalog distribution helper so a "what's Goofy worth?"
      // style question always reaches pinnacle_editions.
      const pinnacleListings = await searchPinnacleDeals(supabase, toolInput, { source: "catalog" });
      const pinnacleParsed = JSON.parse(pinnacleListings);
      if (pinnacleParsed.status !== "no_results") return pinnacleListings;
      const character = toolInput.player ?? toolInput.character ?? null;
      if (!character && !toolInput.setName && !toolInput.tier) return pinnacleListings;
      const dist = await fetchPinnacleFmvDistribution(supabase, {
        character,
        setName: toolInput.setName ?? null,
        variant: toolInput.tier ?? null,
        sampleLimit: toolInput.limit ?? 5,
      });
      return formatDistributionForModel(dist, "disney-pinnacle");
    }
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
      if (data && data.length > 0) {
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
      }
      // Listings-side returned empty. Fall through to the catalog distribution
      // helper so a query like "is $3 fair for LeBron Common?" still surfaces
      // the catalog median ($2.00 across 60 LeBron Common editions in NBA TS)
      // even when nothing is currently listed. Only fire the fallback when
      // the user supplied a player / tier / set filter — otherwise an
      // unfiltered "show me deals" query would return 500-row distributions
      // that aren't useful.
      if (toolInput.player || toolInput.tier || toolInput.setName) {
        const dist = await fetchUnifiedFmvDistribution(supabase, {
          collectionUuid: effectiveCollectionUuid,
          player: toolInput.player ?? null,
          setName: toolInput.setName ?? null,
          tier: toolInput.tier ?? null,
          sampleLimit: toolInput.limit ?? 5,
        });
        return formatDistributionForModel(dist, effectiveCollectionId ?? null);
      }
      return JSON.stringify({ status: "no_results", message: "No moments found matching those criteria." });
    } catch (err: any) {
      return JSON.stringify({ status: "error", message: err.message });
    }
  }

  if (toolName === "get_fmv") {
    const warn = editionKeyMismatchWarning(toolInput.editionKey);
    if (warn) return warn;

    // Pinnacle path: triple-key join (character_name, set_name, variant_type)
    // against pinnacle_editions + pinnacle_fmv_snapshots. The legacy
    // getPinnacleFmv handler is preserved for the editionKey path so the
    // /api/fmv pipeline-style response shape is unchanged for that branch;
    // the playerName/characterName branch routes to the new distributional
    // helper to surface catalog-wide stats when nothing is currently listed.
    if (isPinnacle(effectiveCollectionId)) {
      if (toolInput.editionKey) {
        return getPinnacleFmv(supabase, toolInput);
      }
      const character = toolInput.playerName ?? toolInput.characterName ?? null;
      if (!character && !toolInput.setName) {
        return JSON.stringify({
          status: "error",
          message: "Provide editionKey, characterName, or setName.",
        });
      }
      const result = await fetchPinnacleFmvDistribution(supabase, {
        character,
        setName: toolInput.setName ?? null,
        variant: toolInput.tier ?? null,
        sampleLimit: 5,
      });
      return formatDistributionForModel(result, "disney-pinnacle");
    }

    // Unified path: editions + fmv_snapshots is the canonical FMV catalog.
    // cached_listings is intentionally NOT used here — it only contains
    // currently-listed inventory, so 0 LeBron rows in cached_listings does
    // not mean LeBron has no FMV. Editions table is the source of truth.
    try {
      if (toolInput.editionKey) {
        const result = await fetchUnifiedFmvDistribution(supabase, {
          collectionUuid: effectiveCollectionUuid,
          editionKey: toolInput.editionKey,
          sampleLimit: 5,
        });
        return formatDistributionForModel(result, effectiveCollectionId ?? null);
      }
      if (toolInput.playerName || toolInput.setName || toolInput.tier) {
        const result = await fetchUnifiedFmvDistribution(supabase, {
          collectionUuid: effectiveCollectionUuid,
          player: toolInput.playerName ?? null,
          setName: toolInput.setName ?? null,
          tier: toolInput.tier ?? null,
          sampleLimit: 5,
        });
        return formatDistributionForModel(result, effectiveCollectionId ?? null);
      }
      return JSON.stringify({
        status: "error",
        message: "Provide editionKey, playerName, setName, or tier.",
      });
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
        if (isPinnacle(col.id)) {
          return searchPinnacleByName(supabase, name, perCollection);
        }
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
    if (toolInput.action !== "list") {
      const warn = editionKeyMismatchWarning(toolInput.edition_key);
      if (warn) return warn;
    }
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
    if (toolInput.action !== "list") {
      const warn = editionKeyMismatchWarning(toolInput.edition_key);
      if (warn) return warn;
    }
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
    const warn = editionKeyMismatchWarning(toolInput.editionKey);
    if (warn) return warn;
    if (isPinnacle(effectiveCollectionId)) {
      return explainPinnacleFmv(supabase, { editionKey: toolInput.editionKey });
    }
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

async function persistConversation(row: {
  session_id: string;
  user_message: string;
  bot_response: string;
  escalated: boolean;
  escalation_reason: string | null;
  category: string;
  user_wallet?: string | null;
  page_context?: string | null;
}) {
  try {
    const { error } = await supabase.from("support_conversations").insert({
      ...row,
      resolved: !row.escalated,
    });
    if (error) {
      console.log("[support-chat] persist error:", error.message, error.code ?? "");
    }
  } catch (err: any) {
    console.log("[support-chat] persist threw:", err?.message ?? String(err));
  }
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
  // Declared in outer scope so the top-level catch can persist a meaningful
  // error row tagged with the actual session/message/wallet rather than just
  // a sentinel.
  let parsedSessionId: string | null = null;
  let parsedMessage: string | null = null;
  let parsedUserWallet: string | null = null;
  let parsedPageContext: string | null = null;
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
    parsedSessionId = sessionId;
    parsedMessage = message;
    parsedUserWallet = userWallet ?? null;
    parsedPageContext = pageContext ?? null;

    if (!message?.trim()) {
      return NextResponse.json({ error: "Message required" }, { status: 400 });
    }

    if (!checkRateLimit(sessionId)) {
      return NextResponse.json(
        { response: "You've sent a lot of messages! Take a breather and try again in an hour.", escalated: false, category: "rate_limit" },
        { status: 429 }
      );
    }

    // Greeting fast-path — return a hardcoded reply without invoking the LLM.
    if (GREETING_RE.test(message)) {
      const activeCol = collectionId ? getCollection(collectionId) : null;
      const greetText = activeCol
        ? `Hey! Welcome to RPC. You're on ${activeCol.label} (${activeCol.icon} ${activeCol.partner}). Ask me about live deals, FMV on a specific moment, badges, or your portfolio — happy to dig in.`
        : `Hey! Welcome to RPC — collector intel for NBA Top Shot, NFL All Day, LaLiga Golazos, and Disney Pinnacle. What collection are you browsing, or what would you like to look up?`;
      const greetCategory = classifyCategory(message);

      after(() =>
        persistConversation({
          session_id: sessionId,
          user_message: message,
          bot_response: greetText,
          escalated: false,
          escalation_reason: null,
          category: greetCategory,
          user_wallet: userWallet ?? null,
          page_context: pageContext ?? null,
        })
      );

      if (useStream) {
        const ts = new TransformStream<Uint8Array, Uint8Array>();
        const writer = ts.writable.getWriter();
        const enc = new TextEncoder();
        (async () => {
          try {
            await writer.write(enc.encode(greetText));
            await writer.write(
              enc.encode("\x1e" + JSON.stringify({ response: greetText, escalated: false, category: greetCategory }))
            );
            await writer.close();
          } catch { /* client disconnected */ }
        })();
        return new Response(ts.readable, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "X-RPC-Stream": "1",
            "X-Accel-Buffering": "no",
          },
        });
      }

      return NextResponse.json({ response: greetText, escalated: false, category: greetCategory });
    }

    // Test-only error injector. Header `x-rpc-test-error-mode` paired with a
    // matching `x-rpc-test-secret` (= INGEST_SECRET_TOKEN) forces a synthetic
    // Anthropic-style error to verify the graceful-degradation path. Anyone
    // who already has the ingest secret can do far worse, so this isn't a
    // new exposure surface.
    const testErrMode = req.headers.get("x-rpc-test-error-mode");
    const testErrSecret = req.headers.get("x-rpc-test-secret");
    if (
      testErrMode &&
      process.env.INGEST_SECRET_TOKEN &&
      testErrSecret === process.env.INGEST_SECRET_TOKEN
    ) {
      throw buildSyntheticError(testErrMode);
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
    // Set when runLoop throws an Anthropic SDK error in the streaming path.
    // finalize() consults this to pick the user-meaningful response + category.
    let conciergeErrorMode: ConciergeErrorMode | null = null;

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
      // Anthropic-side outage takes priority over the generic "too complex"
      // fallback — that message is wrong on a 1-word "Ping" query and wrong
      // on a billing failure.
      let category: string;
      if (conciergeErrorMode) {
        const meta = CONCIERGE_ERROR_MESSAGES[conciergeErrorMode];
        finalResponse = meta.response;
        category = meta.category;
      } else {
        if (!finalResponse) {
          finalResponse = "That query was too complex for me to handle in time. Try breaking it down. You can also check the Sniper page directly for the full live feed.";
        }
        if (escalated) {
          finalResponse += "\n\nYou can also DM us directly at https://twitter.com/RipPacksCity for a faster response.";
        }
        category = classifyCategory(message);
      }

      const playerSearched =
        usedTools.includes("search_catalog_deals") || usedTools.includes("search_live_deals") || usedTools.includes("search_across_collections")
          ? body.message.match(/\b([A-Z][a-z]+ [A-Z][a-z]+)\b/)?.[0] ?? undefined
          : undefined;

      // Tool-trace breadcrumb for audit verification. Lets us confirm that
      // any FMV / price figure in the response was grounded in a tool call
      // this turn rather than memory-quoted. Pull from Vercel runtime logs
      // by sessionId after a test run.
      try {
        console.log(
          "[tool-trace] " +
            JSON.stringify({
              session: sessionId,
              tools: usedTools,
              count: usedTools.length,
            })
        );
      } catch {
        /* logging is best-effort */
      }

      // Persistence runs via after() so it's guaranteed to complete via Vercel's
      // waitUntil even if the streaming response closes (or the client disconnects)
      // before the insert finishes. Snapshot the values the closure needs.
      const fr = finalResponse;
      const er = escalated;
      const erReason = escalationReason ?? null;
      after(async () => {
        await persistConversation({
          session_id: sessionId,
          user_message: message,
          bot_response: fr,
          escalated: er,
          escalation_reason: erReason,
          category,
          user_wallet: userWallet ?? null,
          page_context: pageContext ?? null,
        });
        await updateSession(sessionId, category, message, playerSearched).catch(() => {});
      });

      return { response: finalResponse, escalated, escalationReason, category };
    };

    if (useStream && streamResponse && streamWriter) {
      (async () => {
        try {
          await runLoop();
        } catch (err: any) {
          conciergeErrorMode = classifyAnthropicError(err);
          console.log("[support-chat] runLoop streaming error:", err?.status ?? "", err?.name ?? "", conciergeErrorMode, (err?.message ?? String(err)).slice(0, 120));
          // Overwrite any partial stream output with the user-meaningful
          // message. We can't un-stream what already shipped, but for
          // Anthropic 4xx/5xx that fire before any text-delta event, this
          // is the user's first and only payload.
          try {
            await streamWriter!.write(encoder.encode("\n" + CONCIERGE_ERROR_MESSAGES[conciergeErrorMode].response));
          } catch {}
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
    const m = String(err?.message ?? err);
    const mode = classifyAnthropicError(err);
    const meta = CONCIERGE_ERROR_MESSAGES[mode];
    console.log("[sc_err] status", err?.status ?? "");
    console.log("[sc_err] name", err?.name ?? "");
    console.log("[sc_err] mode", mode);
    console.log("[sc_err] m1", m.slice(0, 40));
    console.log("[sc_err] m2", m.slice(40, 120));

    // Persist the failure so we can monitor frequency from the DB rather than
    // log archaeology. Falls back to header / sentinel if body parse failed.
    try {
      const session = parsedSessionId ?? req.headers.get("x-rpc-session-id") ?? `error-${Date.now()}`;
      after(() =>
        persistConversation({
          session_id: session,
          user_message: parsedMessage ?? "(error path — body unavailable)",
          bot_response: meta.response,
          escalated: false,
          escalation_reason: null,
          category: meta.category,
          user_wallet: parsedUserWallet,
          page_context: parsedPageContext,
        })
      );
    } catch { /* best-effort */ }

    return NextResponse.json(
      { response: meta.response, escalated: false, category: meta.category },
      { status: 200 }
    );
  }
}
