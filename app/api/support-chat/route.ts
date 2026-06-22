// app/api/support-chat/route.ts
// POST /api/support-chat
// Body: { message, sessionId, ownerKey?, userWallet?, pageContext?, collectionId?,
//         walletConnected?, conversationHistory?, marketPulse?, dailyDeal?, stream? }
// Returns: { response, escalated, escalationReason?, category }
//
// Closed-beta posture: the bot leads with support, Q&A, and feedback intake
// (log_bug / log_feature_request / log_feedback) and only secondarily plays
// deal concierge. ownerKey is the lowercased Top Shot username from the
// /profile sign-in flow; it threads into the system prompt for personal
// addressing and into support_conversations.owner_key for cross-session
// continuity via the beta_feedback_inbox view.

export const maxDuration = 60;

import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { getCollection, publishedCollections, COLLECTION_UUID_BY_SLUG } from "@/lib/collections";
import { getSupabaseServer } from "@/lib/auth/supabase-server";
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
import { checkFeatureQuota, recordFeatureUsage } from "@/lib/pro-tier";

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// Single source of truth for the concierge model id. When Anthropic retires a
// model, bump this ONE line. A retirement surfaces as an Anthropic 404 /
// not_found_error, classified below as "model_error" and logged LOUDLY to
// pipeline_runs as `concierge-model-error` — the generic "unknown" fallback hid
// the 2026-06-15 sonnet-4 retirement for ~7 days.
const CONCIERGE_MODEL = "claude-sonnet-4-6";

const GREETING_RE = /^\s*(hi+|hello|ping|hey+|sup|test|yo|hola|howdy|gm|gn)\s*[!.?]*\s*$/i;

// ── Anthropic error classification ────────────────────────────────────────────
type ConciergeErrorMode = "credit_balance" | "model_error" | "rate_limit" | "overloaded" | "unknown";

function classifyAnthropicError(err: any): ConciergeErrorMode {
  const status: number = Number(err?.status ?? 0);
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
  // Model retired / not found. This route names only ONE remote resource — the
  // model — so a 404 / not_found_error here is overwhelmingly a model problem.
  // Classify it distinctly so it pages instead of hiding in "unknown".
  if (
    status === 404 ||
    errType === "not_found_error" ||
    /\bmodel\b[^.]*\b(not[_\s]*found|retired|deprecat|unavailable|does not exist)\b|model:\s/.test(msg)
  ) {
    return "model_error";
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
  model_error: {
    response:
      "AI concierge is temporarily unavailable. The collector tools below still work — try the Sniper page or browse Sets.",
    category: "concierge_model_error",
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

// LOUD model-retirement signal. A retired/unknown model returns an Anthropic
// 404; without this it vanishes into the generic "unknown" fallback (the
// 2026-06-15 retirement went unnoticed for ~7 days). An ok=false
// `concierge-model-error` pipeline_runs row puts it in front of the daytime
// monitor + night-pass health sweep immediately. Best-effort — never throws
// into the request path.
function reportConciergeModelError(err: any): void {
  try {
    const detail = String(
      err?.error?.error?.message ?? err?.error?.message ?? err?.message ?? err ?? ""
    ).slice(0, 300);
    after(() =>
      supabase
        .rpc("log_pipeline_run", {
          p_pipeline: "concierge-model-error",
          p_started_at: new Date().toISOString(),
          p_ok: false,
          p_error: `concierge model ${CONCIERGE_MODEL} rejected by Anthropic (likely retired): ${detail}`,
          p_extra: {
            model: CONCIERGE_MODEL,
            status: Number(err?.status ?? 0),
            type: String(err?.type ?? err?.error?.error?.type ?? err?.error?.type ?? ""),
          },
        })
        .then(
          () => {},
          () => {}
        )
    );
  } catch {
    /* telemetry is best-effort */
  }
}

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

// ── Authenticated identity from cookie ────────────────────────────────────────
// proxy.ts gates every non-public path through Supabase auth, so any request
// that reaches a server route handler should carry an authenticated cookie.
// We trust the cookie — never the client-passed userWallet — and derive
// owner_key + user_wallet from allow_list keyed on the verified email.
type AuthedIdentity = {
  email: string | null;
  ownerKey: string | null;
  userWallet: string | null;
};

async function deriveIdentity(): Promise<AuthedIdentity> {
  try {
    const sb = await getSupabaseServer();
    const { data, error } = await sb.auth.getUser();
    const email = data?.user?.email ?? null;
    if (error || !email) {
      return { email: null, ownerKey: null, userWallet: null };
    }
    const { data: row } = await supabase
      .from("allow_list")
      .select("username, wallet_addr")
      .ilike("email", email)
      .limit(1)
      .maybeSingle();
    return {
      email,
      ownerKey: row?.username ?? null,
      userWallet: row?.wallet_addr ?? null,
    };
  } catch (err: any) {
    console.log("[support-chat] deriveIdentity threw:", err?.message ?? String(err));
    return { email: null, ownerKey: null, userWallet: null };
  }
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
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://www.rippackscity.com")
  );
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS: Anthropic.Tool[] = [
  {
    name: "log_bug",
    description: "Log a bug report from the user into Trevor's beta-feedback queue. Do NOT call until you have a clear summary, the affected page, what the user tried, and what they expected vs saw — ask clarifying questions first if any of these are missing. The flow is: user reports something vague → you ask one or two crisp clarifying questions → user answers → you log ONCE with the full details. NEVER call this tool on a vague initial message like 'I found a bug' or 'something is broken' — that produces a useless, double-logged row. The summary field must be a clean one-liner that captures the actual bug (e.g. 'Sniper feed shows blank on iPhone Safari', NOT 'I found a bug'). Details must include the user's clarifications. After logging, confirm to the user what was captured ('Logged that bug — Trevor will see it in his triage queue') and ask if there's anything else they need; do NOT pivot to offering deals or FMV checks.",
    input_schema: {
      type: "object" as const,
      properties: {
        summary: { type: "string", description: "One-line summary of the bug, written in the user's voice. <120 chars." },
        details: { type: "string", description: "Full reproduction context: page/URL, what the user tried, what happened, what they expected. Pull from the conversation, don't make it up." },
        page: { type: "string", description: "Page or surface where the bug appeared (e.g. 'sniper (nba-top-shot)', 'profile', 'cart')." },
        severity: { type: "string", enum: ["low", "medium", "high"], description: "low = cosmetic; medium = degraded function; high = page broken / data wrong / blocking." },
      },
      required: ["summary", "details"],
    },
  },
  {
    name: "log_feature_request",
    description: "Log a feature request from the user into Trevor's beta-feedback queue. Do NOT call until you have a clear summary of the feature, the page or surface it would live on, and the workflow / problem the user is trying to solve — ask clarifying questions first if any of these are missing. The flow is: user wishes for something → you ask one or two clarifying questions → user answers → you log ONCE with the full details. NEVER call on a vague initial message like 'it would be nice to have more features'. The summary must be a clean one-liner (e.g. 'Filter collection view by acquisition date', NOT 'add a filter'). After logging, confirm to the user what was captured and ask if there's anything else; do NOT pivot to offering deals or FMV checks.",
    input_schema: {
      type: "object" as const,
      properties: {
        summary: { type: "string", description: "One-line summary of the request. <120 chars." },
        details: { type: "string", description: "Full description of what the user wants and how they'd use it." },
        motivation: { type: "string", description: "Why the user wants this — the workflow / problem they're trying to solve." },
      },
      required: ["summary", "details"],
    },
  },
  {
    name: "log_feedback",
    description: "Log general feedback (praise, confusion, reactions, half-formed thoughts) into Trevor's beta-feedback queue. Do NOT call until you have a clear summary, the page or surface the feedback is about, and what specifically the user reacted to — ask clarifying questions first if any of these are missing. The flow is: user shares a reaction → you ask one or two clarifying questions if it's vague → user answers → you log ONCE with the full details. NEVER call on a vague initial message like 'this is confusing' without first asking what's confusing. The summary must be a clean one-liner (e.g. 'Analytics tier filter is unclear on mobile', NOT 'confusing'). Praise IS worth capturing — it signals what's working — but still capture what specifically the user liked. After logging, confirm what was captured and ask if there's anything else; do NOT pivot to offering deals or FMV checks.",
    input_schema: {
      type: "object" as const,
      properties: {
        summary: { type: "string", description: "One-line summary. <120 chars." },
        details: { type: "string", description: "Full feedback text from the user." },
        sentiment: { type: "string", enum: ["positive", "neutral", "negative"], description: "Overall vibe of the feedback." },
      },
      required: ["summary", "details", "sentiment"],
    },
  },
  {
    name: "search_live_deals",
    description: "Search for live deals from the RPC sniper feed for the active collection. Use this when the user explicitly wants to shop or hunt deals — NOT for support-flavored questions. Returns real listings with prices, FMV discounts, and buy links. Defaults to the page's active collection when collectionId is omitted. CRITICAL: when the user names a specific person — a player (NBA/NFL/Golazos/UFC) or a character (Disney Pinnacle: Mickey, Goofy, Greef Karga, etc.) — you MUST pass that name in the `player` parameter (or `character` for Pinnacle). Never return unfiltered top-discount results when the user asked about someone specific.",
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
    description: "Look up a collector's wallet to see their moments, portfolio value, and stats for the active collection. Accepts either a Flow wallet address (0x followed by 16 hex chars) OR a Top Shot / Dapper SSO username — usernames are resolved via a layered cache (wallet_usernames → seeded_wallets → live Top Shot GQL) and cached on first hit. If the username can't be resolved, return a graceful prompt asking the user to share the 0x address directly; do NOT pretend the wallet was empty.",
    input_schema: {
      type: "object" as const,
      properties: {
        collectionId: { type: "string", description: "Collection id. Defaults to the active page's collection." },
        walletAddress: { type: "string", description: "Flow wallet address (0x + 16 hex) or Top Shot / Dapper username." },
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
    name: "check_wallet_squeeze",
    description: "Show the user how much of their Top Shot collection is actually liquid vs sitting in challenge-locked or burned editions. Returns bucketed exposure (liquid <25% / moderate 25-50% / squeezed 50-75% / extreme ≥75% by squeeze %, moments-weighted), totals, and the top 10 most-squeezed editions they hold. Use when the user asks 'how locked is my bag', 'what's my exposure', 'how much of my collection is liquid', 'what should I sell first', or pastes their wallet asking about scarcity. Accepts a Flow wallet address (0x + 16 hex) OR a Top Shot / Dapper SSO username (resolved via the same ladder as check_wallet). Top Shot only — AllDay / Pinnacle / Golazos / UFC moments are not counted.",
    input_schema: {
      type: "object" as const,
      properties: {
        walletAddress: { type: "string", description: "Flow wallet address (0x + 16 hex) or Top Shot / Dapper username." },
      },
      required: ["walletAddress"],
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
    description: "Page Trevor live for genuine account emergencies — money lost, NFT missing after a confirmed purchase, sign-in fully broken, anything that needs human-in-the-loop within an hour. Do NOT use this for bugs, feature requests, confusion, or general feedback — those go through log_bug / log_feature_request / log_feedback, which queue silently for batch triage. Set urgency='high' only for true emergencies; that is the threshold that fires Telegram. Lower urgencies are stored but do not page.",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: { type: "string" },
        category: { type: "string", enum: ["account", "billing", "missing_nft", "auth_blocked", "other"] },
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
  {
    name: "get_special_serial_owners",
    description: "Find who currently holds the chase serials on Top Shot — the #1 mint, the perfect mint (#N/N), and the jersey-match serial — among tracked wallets. Use for ownership questions like 'who owns the #1 of [player] [set]?' or 'what special serials does [wallet] hold?'. Top Shot ONLY (NBA Top Shot). Provide playerName to find a player's special serials, OR a holder wallet address to list everything that wallet holds; you can also narrow by tag and tier. Returns the current holder, the serial + kind, the edition FMV, and a link to the edition page. Holder is the latest tracked owner, not a guarantee of present custody.",
    input_schema: {
      type: "object" as const,
      properties: {
        playerName: { type: "string", description: "Player name (partial match)." },
        holder: { type: "string", description: "Exact Flow wallet address (0x + 16 hex) to list that wallet's special serials." },
        tag: { type: "string", enum: ["#1", "perfect", "jersey"], description: "Restrict to one chase-serial kind." },
        tier: { type: "string", description: "Top Shot tier (COMMON, RARE, FANDOM, LEGENDARY, ULTIMATE)." },
        limit: { type: "number", description: "Max rows, 1..100, default 25." },
      },
      required: [],
    },
  },
];

// ── System prompt (closed-beta posture: support / feedback first, deals second)
function buildSystemPrompt(ctx: {
  pageContext?: string;
  collectionId?: string;
  ownerKey?: string;
  userWallet?: string;
  walletConnected?: boolean;
  marketPulse?: string;
  dailyDeal?: any;
  profile?: { display_name?: string | null; favorite_team?: string | null; twitter?: string | null } | null;
  priorConversationCount?: number;
}): string {
  const { pageContext, collectionId, ownerKey, userWallet, walletConnected, marketPulse, dailyDeal, profile, priorConversationCount } = ctx;

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
Mention this only if the user explicitly asks about deals or market state. Do NOT lead with it in beta posture.`
      : "";

  const profileLines: string[] = [];
  if (ownerKey) profileLines.push(`- Top Shot username: ${ownerKey}`);
  if (profile?.display_name) profileLines.push(`- Display name: ${profile.display_name}`);
  if (profile?.favorite_team) profileLines.push(`- Favorite team: ${profile.favorite_team}`);
  if (profile?.twitter) profileLines.push(`- Twitter: ${profile.twitter}`);
  if (userWallet) profileLines.push(`- Connected wallet: ${userWallet}`);
  if (typeof priorConversationCount === "number" && priorConversationCount > 0) {
    profileLines.push(`- Prior support_conversations rows for this user: ${priorConversationCount} (returning beta tester)`);
  } else if (ownerKey) {
    profileLines.push(`- First-time chat for this user (no prior support_conversations rows).`);
  }

  const userSection = profileLines.length > 0
    ? `\n## User Context
${profileLines.join("\n")}
${ownerKey ? `Address them by their handle (${ownerKey}) or display name where it feels natural — they're a beta tester whose feedback Trevor wants. ` : ""}If they ask about their own collection, call check_wallet with their connected wallet (or any handle they provide) and the active collection id.`
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
- **sets**: completion tracking — bottlenecks, cheapest path to finish a set
- **analytics**: ecosystem intelligence — top sales, tier trends, player analytics, series volume`
    : "";

  return `You are the RPC Concierge — the in-product support partner and beta-feedback collector for Rip Packs City, a multi-collection intelligence platform for Flow blockchain digital collectibles.

## Your Posture (closed beta)
RPC is in closed beta. Your primary job, in order:
1. **Support**: help users get unstuck. Walk them through how a feature works, where to click, why something looks the way it does.
2. **Q&A**: answer how-things-work questions about FMV, badges, packs, sets, sniping, sign-in, wallets, collections.
3. **Feedback intake**: capture bug reports, feature requests, confusion, and praise so Trevor can act on them. This is critical — the user is a beta tester whose feedback Trevor wants. Use log_bug / log_feature_request / log_feedback liberally (after clarifying — see below); that is how feedback reaches him. Praise still counts — it signals what's working.

**Deal concierge is on-request only — never proactive.** You have search_live_deals / search_catalog_deals / get_fmv / check_wallet / check_wallet_squeeze / search_across_collections / get_collection_snapshot / explain_fmv. Use them ONLY when the user explicitly asks to shop, hunt deals, check FMV, look up a player's price, analyze a wallet, or see their squeeze exposure (the "what's liquid in my bag" question). The welcome message mentions once that deals and FMV checks are available; after that, do not bring them up again unless the user asks. Never offer deals as a consolation prize, side-quest, or follow-up to a support flow.

## CRITICAL — Support flow integrity (hard rule, not a soft preference)
Once a user enters a support, Q&A, confusion, bug-report, feature-request, or general-feedback flow, you MUST stay in that flow through resolution. You do NOT pivot to offering deals, FMV checks, movers, or "while we troubleshoot, want me to pull some deals?" mid-conversation. The pivot is acceptable ONLY if the user themselves explicitly asks to switch topics (e.g. "okay forget that, can you help me find a deal?" or "different question — what's a LeBron Rare worth?"). Until they do, your job is the current thread: ask clarifying questions, log feedback if appropriate, confirm capture, and ask if there's anything else they need. After logging a bug / feature request / feedback, your closing line is "Anything else?" — NOT "want me to pull some deals while we wait?" Violating this rule is the single most common failure mode of this bot; do not do it.

## Your Persona
Sharp, direct, no corporate fluff. You speak fluent collector — moments, serials, FMV, floor, badges, rips, mints, parallels, set bottlenecks, pack EV. You know this is closed beta and you act like it: you're a partner helping ship a product, not a sales bot.

Keep responses concise — most users are on mobile. Short paragraphs, not bullet-heavy walls.

## Capturing Feedback (read this carefully — log ONCE, after clarifying)
When the user describes something that sounds like a bug — error messages, blank pages, wrong numbers, broken buttons, things that don't behave as expected — your job is to capture it cleanly. **Do NOT call log_bug on a vague initial message.** A message like "I found a bug" or "the sniper feed is empty" is the START of the conversation, not the end. The flow is:

1. User reports something vague.
2. You ask **one or two crisp clarifying questions**, no more:
   - Which page or surface (URL or tab name)?
   - What did they try / click / type?
   - What did they see vs what did they expect (and on what device / browser if relevant)?
3. User answers.
4. You call log_bug **exactly once** with a clean one-liner summary that captures the actual bug (e.g. "Sniper feed shows blank on iPhone Safari", NOT "I found a bug"), full details that include the user's clarifications, the page, and a severity guess (high = blocking, medium = degraded, low = cosmetic).
5. You confirm: "Logged that bug — Trevor will see it in his triage queue. Anything else?"

If you already have a clear summary + page + what they tried + what they expected vs saw on the FIRST message, you may skip the clarifying-questions step and log directly — but only then. When in doubt, ask first; one extra question is cheaper than a useless row.

The same flow applies to log_feature_request (clarify the feature + workflow first, then log once with summary + details + motivation) and log_feedback (clarify what specifically the user reacted to, then log once with the right sentiment). Do not log praise without knowing what the praise is about — "this is sick" is not enough; ask "what specifically is clicking for you?" first. Sample triggers that still need clarification: "this is sick", "I love the sniper view", "the analytics page confused me", "I don't get what FMV means here".

After logging anything, briefly confirm what you captured and ask "Anything else?" Do NOT pivot to deals or FMV. Do not over-promise a response time; just say it's in the queue.

## Escalation vs Logging
**escalate_to_human** is reserved for live emergencies — money lost, NFT missing after a confirmed purchase, sign-in fully broken for a paying user, anything Trevor needs to resolve within the hour. Bugs, feature requests, and confusion go through log_bug / log_feature_request / log_feedback — those queue silently for batch triage. If you're unsure, log it; do not escalate. Escalation pages Trevor on Telegram only when urgency='high', so do not casually reach for it.

## CRITICAL — Not Financial Advice
Nothing you say is financial advice. FMV values, deal scores, set valuations, pack EVs, etc. are model outputs with uncertainty. Surface the data they need to make their own decision rather than telling them what to do. The following phrases (and any close paraphrase) are banned:
- "worth buying" / "worth picking up" / "great deal" / "good deal" / "exceptional deal"
- "you should buy" / "you should sell" / "you should hold"
- "snag this" / "pull the trigger" / "jump on this" / "buy now" / "act fast" / "don't miss"
- "I recommend" / "my recommendation" / "I'd buy"

Instead state the data factually: "This listing is at the median FMV for [player] [tier]." / "Ask is $X, FMV is $Y (HIGH confidence), implied discount is Z%." / "No comparable sales in 30d — pricing is directional."

If asked "should I buy this?", respond with the data + an explicit "I don't make buy/sell calls — that's your decision."

## CRITICAL — FMV numbers must come from a tool call this turn
Never quote FMV numbers, ranges, floors, percentiles, or distributions from memory. If you reference any price, FMV, floor, range, or "typical" figure, you must have called get_fmv, search_catalog_deals, or search_live_deals in this turn and be quoting from a tool result row. Soft directional claims ("typically command premium prices", "tend to hold value", "scarce serials carry a premium") count as price assertions — same rule applies. If the relevant tool returned no results, say so honestly; do not fall back to a remembered range.

## CRITICAL — Tier filtering on FMV tools
When a user mentions a tier — Common, Rare, Fandom, Legendary, Ultimate, or any Pinnacle variant_type — you MUST pass that tier into get_fmv or search_catalog_deals. Tier-stripped distributions mix tiers and the median is misleading.

## CRITICAL — Name Filtering Rule
If the user names a specific player or character anywhere in their query, you MUST pass that exact name as a filter on every search and FMV tool call (player / character / playerName / characterName / name). Never label a returned row with a name the row doesn't carry. If the filtered search returns zero rows, say so honestly — do NOT silently substitute a different person.

## CRITICAL — Never Fabricate FMV
A tool result row's \`fmv\` field is the only authoritative FMV for that row. If \`fmv\` is null on a row you surface, report the listing's ask as-is and explicitly note FMV is unavailable for that exact edition. Never borrow an FMV from a different row, compute a discount when fmv is null, or invent an "approximate" figure.

## What RPC Is
Rip Packs City (rippackscity.com) is a collector intelligence platform built by and for the Flow digital collectibles community. RPC covers NBA Top Shot, NFL All Day, Disney Pinnacle, LaLiga Golazos, and UFC Strike — the major collections across the Dapper and Top Shot ecosystem. It covers these currently published collections: ${publishedLabels}. UFC Strike is published with a BETA badge — coverage is limited (only ~20% of editions have FMV) and on-chain volume is thin post-Aptos migration. Tell users explicitly that UFC coverage is limited when they ask.

Every published collection offers the same toolset where data supports it: Overview, Collection Analyzer, Market browser, Sniper feed, Sets tracker, Pack EV calculator, Analytics. Badges are NBA Top Shot moment-level metadata (Rookie Year, Top Shot Debut, Championship Year, etc) — surface inline on Collection / Market / Sniper rows when relevant. Users sign in with an email magic link to save wallets, pin trophy moments, and build a public profile at /profile/[username].

## FMV Methodology (v1.7.0)
- Recalculated every 20 minutes per collection (Pinnacle FMV runs on a parallel pipeline)
- Weighted average of recent sales with 7-day half-life decay (WAP)
- Adjusts for days_since_sale and sales_count_30d
- Confidence: HIGH (5+ sales), MEDIUM (2+), LOW (1, directional only)

## FMV Coverage by Collection
- **NBA Top Shot**: 100%+ (statistically meaningful)
- **NFL All Day**: 100% (29% HIGH/MEDIUM, rest LOW from ask-only — directional in tail)
- **Disney Pinnacle**: 86% (367/425 editions — directional)
- **LaLiga Golazos**: 12.9% (75/581) — for the other 87%, answer with floor + recent-sales context, not "FMV says X"
- **UFC Strike**: 19.7% (29/147, BETA) — answer with floor + last-sale heuristics
When confidence is LOW or coverage is below 50%, proactively note the limitation.

## Pinnacle Routing (invariant)
If the active collection is Disney Pinnacle, FMV and listings live in the pinnacle_* parallel tables — the tool layer routes automatically. Do not warn the user about a different schema.

## Tool routing for price-comparison queries
"Should I buy at $X" / "is $X fair" / "is $X a deal" → first call get_fmv or search_catalog_deals (catalog answers "what is it worth"). Only after that mention live availability via search_live_deals. If search_live_deals returns nothing AND the question implies a price comparison, you MUST chain search_catalog_deals or get_fmv before responding.

## Reading get_fmv / search_catalog_deals responses
- mode = "distribution" (count >= 2): surface median (median_fmv), middle 80% (p10 → p90), count for breadth, name 1-3 sample editions. Frame the user's price relative to the distribution.
- mode = "single" (count = 1): surface the single edition's fmv with confidence label and exact set/player/tier.
- status = "no_results": say so; do not invent a ballpark.

## Common Questions (no tools needed)
- "How is FMV calculated?" → v1.7.0 WAP model with days_since_sale + sales_count_30d, 20-min refresh, confidence levels
- "What are badges?" → Top Shot play tags; major ones; premium pricing. AllDay/Golazos/Pinnacle have parallel editions instead.
- "Why is the sniper feed empty?" → per-collection proxy model; Cloudflare blocking is transient
- "How do I buy a moment?" → Connect Dapper wallet on the native marketplace or Flowty; RPC deep-links directly
- "Does RPC support X collection?" → list published collections
- "My All Day moments disappeared / are missing" → likely locked for set-completion rewards. AllDay lets users lock moments to earn bonuses, and locked moments temporarily disappear from the standard wallet view. Ask them to check the AllDay set-completion / vault page before treating it as a bug.${collectionBlurb}${marketSection}${userSection}${pageSection}

## What's New (2026-06) — product surfaces you must know
- **Rewards program** (/rewards): two numbers — Status (your tier, only goes up) and Credits (spendable). Spend Credits in the shop (Pro time, cosmetics, Moments, merch). FAQ — "how do I earn credits?": link + verify a wallet (verifying pays 500 credits), set a favorite team, complete your profile, visit daily, refer friends, share your profile. Full earn list + live balance live on /rewards.
- **Wallet verification (listing challenge)** — the working path for Top Shot collectors. FAQ — "how do I verify my wallet?": go to /dashboard (or the verify CTA on /rewards). RPC picks one cheap Moment you own and asks you to list it at a unique ~100×/$10-floor price (it won't sell — the odd cents are just a uniqueness check); RPC confirms the live listing and credits you 500. The old "Sign in with Dapper" path is gated on developer access; the FCL wallet button is only for self-custody wallets, not Dapper-custodied Top Shot accounts.
- **Public /insights surfaces** (shareable, anon-public URLs you can hand out): /insights/squeeze (supply locked + burned), /insights/deals (below-FMV asks, Top Shot + Pinnacle), /insights/first-mint, /insights/rookies, /insights (the RPC index), /insights/pack-reality, /insights/pinnacle-scarcity.
- **Per-render Pinnacle pin pages** — /pinnacle/moment/<render_id>. Pinnacle FMV is now per-render (each pin priced on its own sales), not a blended set-level number.
- **Team Hub** (/my-teams): follow teams and track per-team checklists — owned vs missing + cost-to-complete — across collections.

## Tone
Good — bug intake: "Got it. Quick one — which page were you on when the sniper feed went blank, and did the rest of the page load? I want to log this cleanly for Trevor."
Good — feature request: "That's a useful one. Logging it as 'Filter by acquisition date in /collection'. Anything you'd want to slice it by — set, tier, both?"
Good — praise: "Appreciate it — logging it so Trevor sees what's clicking. The new sets view shipped two weeks ago; he'll be glad it's landing."
Good — deal: "That LeBron Rare lists at $18. FMV is $26 (HIGH confidence, 12 sales in 30d), so the ask is 31% under FMV. The moment carries a Rookie Premiere badge."
Bad — directive: "That LeBron Rare is a solid buy at $18 — you should grab it." (banned phrasing)
Bad — fluff: "That's a great question! I'd be happy to help you analyze that..."
Bad — pivoting to deals when the user asked for support: user reports the Profile page is broken; bot responds with "Want me to find some deals while we figure that out?" (no — log the bug, confirm capture, ask if they need anything else).
Bad — double-logging: user says "I found a bug"; bot calls log_bug immediately with summary "I found a bug" then asks clarifying questions and logs again. (No — clarify FIRST, then call log_bug exactly once with a clean one-liner.)
Bad — pitch after support: bot logs a bug, then says "Logged it — also, I noticed there are 12 moments listed 30%+ below FMV right now if you want a break from troubleshooting." (No — close with "Anything else?" full stop.)

Respond in whatever language the user writes in.`;
}

// ── FMV distribution result formatter ─────────────────────────────────────────
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

// ── Beta-feedback log helper ──────────────────────────────────────────────────
// Insert a separate support_conversations row for log_bug / log_feature_request /
// log_feedback. The view beta_feedback_inbox surfaces these for Trevor's batch
// triage. Telegram is intentionally NOT fired here — only escalate_to_human
// with urgency='high' pages live.
async function logBetaFeedback(args: {
  feedbackType: "bug" | "feature_request" | "general_feedback";
  summary: string;
  details: string;
  ctx: { sessionId: string; ownerKey?: string | null; userWallet?: string | null; userEmail?: string | null; pageContext?: string | null };
}): Promise<{ id: number | null }> {
  try {
    const { data, error } = await supabase
      .from("support_conversations")
      .insert({
        session_id: args.ctx.sessionId,
        user_message: args.summary,
        bot_response: `[${args.feedbackType}] ${args.summary}`,
        escalated: false,
        escalation_reason: null,
        category: "beta_feedback",
        resolved: false,
        owner_key: args.ctx.ownerKey ?? null,
        user_wallet: args.ctx.userWallet ?? null,
        user_email: args.ctx.userEmail ?? null,
        page_context: args.ctx.pageContext ?? null,
        feedback_type: args.feedbackType,
        feedback_summary: args.summary,
        feedback_details: args.details,
        feedback_status: "new",
      })
      .select("id")
      .maybeSingle();
    if (error) {
      console.log("[beta-feedback] insert error:", error.message);
      return { id: null };
    }
    return { id: data?.id ?? null };
  } catch (err: any) {
    console.log("[beta-feedback] insert threw:", err?.message ?? String(err));
    return { id: null };
  }
}

// ── Tool execution ────────────────────────────────────────────────────────────
async function executeTool(
  toolName: string,
  toolInput: any,
  ctx: { sessionId: string; ownerKey?: string | null; userWallet?: string | null; userEmail?: string | null; collectionId?: string | null; pageContext?: string | null }
): Promise<string> {
  const base = siteUrl();
  const effectiveCollectionId: string | undefined = toolInput.collectionId ?? ctx.collectionId ?? undefined;
  const effectiveCollectionUuid: string | null = effectiveCollectionId
    ? (COLLECTION_UUID_BY_SLUG[effectiveCollectionId] ?? null)
    : null;

  if (toolInput && typeof toolInput === "object") {
    if (toolInput.character && !toolInput.player) toolInput.player = toolInput.character;
    if (toolInput.characterName && !toolInput.playerName) toolInput.playerName = toolInput.characterName;
  }

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

  // ── Beta feedback intake tools ────────────────────────────────────────────
  if (toolName === "log_bug") {
    const summary = String(toolInput.summary ?? "").trim();
    const details = String(toolInput.details ?? "").trim();
    if (!summary || !details) {
      return JSON.stringify({ status: "error", message: "summary and details are required" });
    }
    const page = toolInput.page ?? ctx.pageContext ?? null;
    const severity = toolInput.severity ?? "medium";
    const detailsBlock = `Severity: ${severity}\nPage: ${page ?? "(unspecified)"}\n\n${details}`;
    const { id } = await logBetaFeedback({
      feedbackType: "bug",
      summary,
      details: detailsBlock,
      ctx: { sessionId: ctx.sessionId, ownerKey: ctx.ownerKey, userWallet: ctx.userWallet, userEmail: ctx.userEmail, pageContext: page },
    });
    return JSON.stringify({
      status: id ? "logged" : "logged_offline",
      feedback_type: "bug",
      summary,
      severity,
      message: "Logged in Trevor's beta-feedback queue. He reviews bug reports in batch — no live page on this one.",
    });
  }

  if (toolName === "log_feature_request") {
    const summary = String(toolInput.summary ?? "").trim();
    const details = String(toolInput.details ?? "").trim();
    if (!summary || !details) {
      return JSON.stringify({ status: "error", message: "summary and details are required" });
    }
    const motivation = toolInput.motivation ?? null;
    const detailsBlock = `${details}${motivation ? `\n\nMotivation: ${motivation}` : ""}`;
    const { id } = await logBetaFeedback({
      feedbackType: "feature_request",
      summary,
      details: detailsBlock,
      ctx: { sessionId: ctx.sessionId, ownerKey: ctx.ownerKey, userWallet: ctx.userWallet, userEmail: ctx.userEmail, pageContext: ctx.pageContext },
    });
    return JSON.stringify({
      status: id ? "logged" : "logged_offline",
      feedback_type: "feature_request",
      summary,
      message: "Logged as a feature request — Trevor will see it in the queue.",
    });
  }

  if (toolName === "log_feedback") {
    const summary = String(toolInput.summary ?? "").trim();
    const details = String(toolInput.details ?? "").trim();
    const sentiment = toolInput.sentiment ?? "neutral";
    if (!summary || !details) {
      return JSON.stringify({ status: "error", message: "summary and details are required" });
    }
    const detailsBlock = `Sentiment: ${sentiment}\n\n${details}`;
    const { id } = await logBetaFeedback({
      feedbackType: "general_feedback",
      summary,
      details: detailsBlock,
      ctx: { sessionId: ctx.sessionId, ownerKey: ctx.ownerKey, userWallet: ctx.userWallet, userEmail: ctx.userEmail, pageContext: ctx.pageContext },
    });
    return JSON.stringify({
      status: id ? "logged" : "logged_offline",
      feedback_type: "general_feedback",
      sentiment,
      summary,
      message: "Logged in the feedback queue — appreciate it.",
    });
  }

  // ── Existing concierge tools (deal hunting, FMV, wallets) ─────────────────
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
      // Username branch: resolve via the cache-aware ladder before calling
      // wallet-search. The lookup returns fast on cache hits and falls back
      // to live Top Shot GQL on misses, writing back to wallet_usernames so
      // the next call short-circuits at layer 1. wallet-search would do this
      // anyway — pre-resolving here lets the bot return a clean "not found"
      // message with the right framing instead of an opaque "Username not
      // found." error from wallet-search's catch path.
      const inputAddr = String(toolInput.walletAddress ?? "").trim();
      const isHex = /^0x[a-fA-F0-9]{16}$/.test(inputAddr);
      let resolvedAddr = inputAddr;
      if (!isHex) {
        // deno-lint-ignore no-explicit-any
        const { data: rpcResult } = await (supabase as any).rpc("resolve_topshot_username", {
          p_username: inputAddr,
        });
        if (rpcResult?.found === true && typeof rpcResult.wallet_address === "string") {
          resolvedAddr = rpcResult.wallet_address.startsWith("0x")
            ? rpcResult.wallet_address
            : `0x${rpcResult.wallet_address}`;
        } else {
          // Cache miss — defer to wallet-search which will hit live Top Shot
          // GQL via resolveTopShotUsernameCacheAware. If THAT also misses,
          // wallet-search returns 200 with an error string; we surface a
          // graceful unresolved-username message so the bot doesn't lie.
          const liveRes = await fetch(`${base}/api/resolve-topshot-username`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.INGEST_SECRET_TOKEN ?? ""}`,
            },
            body: JSON.stringify({ username: inputAddr }),
            signal: AbortSignal.timeout(8000),
          }).catch(() => null);
          const liveBody = liveRes ? await liveRes.json().catch(() => null) : null;
          if (liveBody?.found === true && typeof liveBody.wallet_address === "string") {
            resolvedAddr = liveBody.wallet_address;
          } else {
            return JSON.stringify({
              status: "username_not_resolved",
              wallet: inputAddr,
              message:
                "I don't have a wallet for that username on file. If you can share the wallet address (starts with 0x and 16 hex chars), I'll pull it up directly.",
            });
          }
        }
      }

      const res = await fetch(`${base}/api/wallet-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: resolvedAddr,
          collectionId: effectiveCollectionId ?? undefined,
        }),
        signal: AbortSignal.timeout(12000),
      });
      const data = await res.json();
      const moments = data.moments || data.rows || [];
      const totalFmv = moments.reduce((s: number, m: any) => s + (m.fmv ?? 0), 0);
      return JSON.stringify({
        status: "ok",
        wallet: resolvedAddr,
        username_input: isHex ? null : inputAddr,
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

  if (toolName === "check_wallet_squeeze") {
    try {
      // Mirror check_wallet's username-resolution ladder so the bot can
      // accept either a 0x address or a TS username and not surprise the
      // user. Then call get_wallet_squeeze_exposure RPC, which returns a
      // structured jsonb (buckets, totals, top 10 squeezed editions).
      const inputAddr = String(toolInput.walletAddress ?? "").trim();
      const isHex = /^0x[a-fA-F0-9]{16}$/.test(inputAddr);
      let resolvedAddr = inputAddr;
      if (!isHex) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: rpcResult } = await (supabase as any).rpc("resolve_topshot_username", {
          p_username: inputAddr,
        });
        if (rpcResult?.found === true && typeof rpcResult.wallet_address === "string") {
          resolvedAddr = rpcResult.wallet_address.startsWith("0x")
            ? rpcResult.wallet_address
            : `0x${rpcResult.wallet_address}`;
        } else {
          const liveRes = await fetch(`${base}/api/resolve-topshot-username`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.INGEST_SECRET_TOKEN ?? ""}`,
            },
            body: JSON.stringify({ username: inputAddr }),
            signal: AbortSignal.timeout(8000),
          }).catch(() => null);
          const liveBody = liveRes ? await liveRes.json().catch(() => null) : null;
          if (liveBody?.found === true && typeof liveBody.wallet_address === "string") {
            resolvedAddr = liveBody.wallet_address;
          } else {
            return JSON.stringify({
              status: "username_not_resolved",
              wallet: inputAddr,
              message:
                "I don't have a wallet for that username on file. If you can share the wallet address (starts with 0x and 16 hex chars), I'll pull the squeeze breakdown.",
            });
          }
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: summary, error: rpcErr } = await (supabase as any).rpc("get_wallet_squeeze_exposure", {
        p_wallet: resolvedAddr.toLowerCase(),
      });
      if (rpcErr) {
        return JSON.stringify({ status: "error", message: rpcErr.message });
      }
      if (!summary || (summary.total_moments ?? 0) === 0) {
        return JSON.stringify({
          status: "empty",
          wallet: resolvedAddr,
          username_input: isHex ? null : inputAddr,
          message:
            "I don't have any Top Shot moments cached for that wallet yet. Try again after a backfill or check the address.",
        });
      }
      return JSON.stringify({
        status: "ok",
        wallet: resolvedAddr,
        username_input: isHex ? null : inputAddr,
        summary,
      });
    } catch (err: unknown) {
      return JSON.stringify({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
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
        summary: `Your collection: ${data.totalMoments} moments, total FMV $${Number(data.totalFmv).toFixed(2)}. Top moments: ${topList}. Share your collection at ${siteUrl()}/share/${encodeURIComponent(toolInput.walletAddress)}`,
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

  if (toolName === "get_special_serial_owners") {
    try {
      const player = String(toolInput.playerName ?? toolInput.player ?? "").trim() || null;
      const holder = String(toolInput.holder ?? "").trim() || null;
      const tagIn = String(toolInput.tag ?? "").trim();
      const tag = ["#1", "perfect", "jersey"].includes(tagIn) ? tagIn : null;
      const tier = String(toolInput.tier ?? "").trim().toUpperCase() || null;
      if (!player && !holder && !tag && !tier) {
        return JSON.stringify({
          status: "need_input",
          message: "Provide a player name or a holder wallet address (and optionally a tag/tier).",
        });
      }
      const limit = Math.min(Math.max(Number(toolInput.limit) || 25, 1), 100);
      const { data, error } = await supabase.rpc("get_special_serial_owners_board", {
        p_tag: tag,
        p_tier: tier,
        p_player: player,
        p_holder: holder,
        p_sort: "fmv",
        p_limit: limit,
        p_offset: 0,
      });
      if (error) return JSON.stringify({ status: "error", message: error.message });
      const rows = (data ?? []).map((r: any) => ({
        player: r.player_name,
        set: r.set_name,
        tier: r.tier,
        serial: r.serial,
        circulation: r.circulation_count,
        kind: r.tag, // '#1' | 'perfect' | 'jersey'
        holder: r.holder_address,
        edition_fmv: r.edition_fmv != null ? Number(r.edition_fmv) : null,
        edition_url: r.edition_key ? `${base}/nba-top-shot/edition/${encodeURIComponent(r.edition_key)}` : null,
      }));
      return JSON.stringify({
        status: "ok",
        note: "Top Shot only. 'holder' is the current owner among tracked wallets (latest seen), not a present-custody guarantee.",
        total: rows.length,
        rows,
      });
    } catch (err: any) {
      return JSON.stringify({ status: "error", message: err?.message ?? "get_special_serial_owners failed" });
    }
  }

  if (toolName === "escalate_to_human") {
    const { reason, category, urgency } = toolInput;
    const isHigh = String(urgency ?? "medium").toLowerCase() === "high";
    // Telegram pages Trevor live ONLY when urgency='high'. Lower urgencies are
    // logged to the DB via persistConversation (escalated=true) but do not
    // generate a live notification — that is what log_bug / log_feature_request
    // exist for.
    if (isHigh) {
      try {
        if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
          await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: process.env.TELEGRAM_CHAT_ID,
              text: `\u{1F6A8} RPC Support Escalation (HIGH)\nCategory: ${category}\nSession: ${ctx.sessionId}\nUser: ${ctx.ownerKey ?? "(anon)"}\n\nIssue: ${reason}`,
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
              subject: `[RPC Support] ${category} — HIGH urgency`,
              text: `Session: ${ctx.sessionId}\nUser: ${ctx.ownerKey ?? "(anon)"}\nCategory: ${category}\nUrgency: high\n\nIssue:\n${reason}`,
            }),
          });
        }
      } catch { /* non-fatal */ }
    }
    return JSON.stringify({
      status: "escalated",
      paged: isHigh,
      message: isHigh
        ? "Trevor has been paged on Telegram and email — expect a follow-up shortly."
        : "Logged for Trevor's review. Not paged live (only urgency='high' pages immediately).",
    });
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

function resolveCategory(message: string, errorMode?: ConciergeErrorMode | null): string {
  if (errorMode) return CONCIERGE_ERROR_MESSAGES[errorMode].category;
  return classifyCategory(message);
}

async function persistConversation(row: {
  session_id: string;
  user_message: string;
  bot_response: string;
  escalated: boolean;
  escalation_reason: string | null;
  category: string;
  user_wallet?: string | null;
  owner_key?: string | null;
  user_email?: string | null;
  page_context?: string | null;
  is_smoke_test?: boolean;
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

// Constant-time check of the X-RPC-Smoke-Test header against
// SMOKE_TEST_SESSION_TOKEN env. crypto.timingSafeEqual is used so token
// validation does not leak via response timing. Returns false (treat as
// real anonymous traffic) if either side is missing or lengths mismatch.
function isSmokeTestRequest(req: NextRequest): boolean {
  const presented = req.headers.get("x-rpc-smoke-test");
  const expected = process.env.SMOKE_TEST_SESSION_TOKEN;
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { timingSafeEqual } = require("node:crypto") as typeof import("node:crypto");
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function updateSession(
  sessionId: string,
  category: string,
  userMessage: string,
  ctx: { ownerKey?: string | null; userWallet?: string | null; userEmail?: string | null; isSmokeTest?: boolean },
  playerSearched?: string
) {
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
        owner_key: ctx.ownerKey ?? null,
        user_wallet: ctx.userWallet ?? null,
        user_email: ctx.userEmail ?? null,
        is_smoke_test: ctx.isSmokeTest ?? false,
      },
      { onConflict: "session_id" }
    );
  } catch { /* non-fatal */ }
}

// Fetch profile_bio + prior support_conversations count so the system prompt
// can address the user by handle and frame returning beta testers warmly.
// profile_bio is keyed by `username` — NOT `owner_key`; the existing
// /api/profile/bio route has a separate bug there that's out of scope.
async function loadOwnerContext(ownerKey: string): Promise<{
  profile: { display_name?: string | null; favorite_team?: string | null; twitter?: string | null } | null;
  priorConversationCount: number;
}> {
  let profile: { display_name?: string | null; favorite_team?: string | null; twitter?: string | null } | null = null;
  let priorConversationCount = 0;
  try {
    const { data } = await supabase
      .from("profile_bio")
      .select("display_name, favorite_team, twitter")
      .eq("username", ownerKey)
      .maybeSingle();
    if (data) profile = data;
  } catch { /* non-fatal */ }
  try {
    const { count } = await supabase
      .from("support_conversations")
      .select("*", { count: "exact", head: true })
      .eq("owner_key", ownerKey);
    if (typeof count === "number") priorConversationCount = count;
  } catch { /* non-fatal */ }
  return { profile, priorConversationCount };
}

export async function POST(req: NextRequest) {
  let parsedSessionId: string | null = null;
  let parsedMessage: string | null = null;
  let parsedOwnerKey: string | null = null;
  let parsedUserWallet: string | null = null;
  let parsedUserEmail: string | null = null;
  let parsedPageContext: string | null = null;
  // X-RPC-Smoke-Test header carries SMOKE_TEST_SESSION_TOKEN so the
  // smoke-test runner's anonymous traffic gets flagged on
  // support_conversations.is_smoke_test (and chat_sessions.is_smoke_test).
  // Real anonymous traffic from the in-product chat will not present this
  // header and will continue to land with is_smoke_test=false (the default).
  const isSmokeTest = isSmokeTestRequest(req);
  // Cookie is the trust boundary — derive the user's email server-side and
  // resolve owner_key + user_wallet from allow_list. Client-passed values
  // are intentionally ignored to prevent spoofed identity.
  const identity = await deriveIdentity();
  if (!identity.email && !isSmokeTest) {
    console.log("[support-chat] no authed identity — proxy.ts should have gated this");
  }
  try {
    const body = await req.json();
    const {
      message,
      sessionId = `anon-${Date.now()}`,
      pageContext,
      collectionId,
      conversationHistory = [],
      marketPulse,
      dailyDeal,
      stream: useStream = false,
    } = body;
    // Server-derived identity wins; client-passed ownerKey/userWallet are dropped.
    const ownerKey = identity.ownerKey;
    const userWallet = identity.userWallet;
    const userEmail = identity.email;
    const walletConnected = !!userWallet;
    parsedSessionId = sessionId;
    parsedMessage = message;
    parsedOwnerKey = ownerKey;
    parsedUserWallet = userWallet;
    parsedUserEmail = userEmail;
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

    // Pro tier daily quota — only enforced when we have a wallet to key on.
    // Free users get 5/day; pro_trial 50/day; founding/pro_paid/grandfather 200/day;
    // founding+admin unlimited. Anonymous users (no wallet) bypass the quota
    // and rely on the per-session rate limit above. Recording happens in
    // after() so failures don't block response delivery.
    if (userWallet) {
      const quota = await checkFeatureQuota(userWallet, "concierge_messages");
      if (!quota.allowed) {
        return NextResponse.json(
          {
            response: `You've hit your daily Concierge limit (${quota.daily_limit ?? 0}/day on the ${quota.plan} plan). Upgrade to RPC Pro for 200 messages per day — see /pricing.`,
            escalated: false,
            category: "daily_limit_reached",
            error: "daily_limit_reached",
            plan: quota.plan,
            used_today: quota.used_today,
            daily_limit: quota.daily_limit,
            upgrade_url: "/pricing",
          },
          { status: 429 }
        );
      }
      // Quota passed — record usage in the background so every return path
      // below (greeting, streaming, normal response, escalation) increments
      // the daily counter exactly once.
      after(() => recordFeatureUsage(userWallet, "concierge_messages", { session_id: sessionId }));
    }

    if (GREETING_RE.test(message)) {
      const activeCol = collectionId ? getCollection(collectionId) : null;
      const greetText = ownerKey
        ? activeCol
          ? `Hey ${ownerKey} — RPC's in closed beta, so I lead with support and feedback intake. You're on ${activeCol.label} (${activeCol.icon} ${activeCol.partner}). Bug? Feature idea? Question? Or want me to dig into deals/FMV?`
          : `Hey ${ownerKey} — RPC's in closed beta. I'm here to help you get unstuck, log bugs and feature requests for Trevor, and answer questions. Deals and FMV too if you want.`
        : activeCol
          ? `Welcome to RPC. We're in closed beta. You're on ${activeCol.label} (${activeCol.icon} ${activeCol.partner}). I can help you get unstuck, log bugs/features for Trevor, or pull deals/FMV — what's up?`
          : `Welcome to RPC — closed beta. I help you get unstuck, log feedback for Trevor, and answer questions. Also do deals and FMV across NBA Top Shot, NFL All Day, LaLiga Golazos, and Disney Pinnacle. What's up?`;
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
          owner_key: ownerKey ?? null,
          user_email: userEmail ?? null,
          page_context: pageContext ?? null,
          is_smoke_test: isSmokeTest,
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

    const testErrMode = req.headers.get("x-rpc-test-error-mode");
    const testErrSecret = req.headers.get("x-rpc-test-secret");
    if (
      testErrMode &&
      process.env.INGEST_SECRET_TOKEN &&
      testErrSecret === process.env.INGEST_SECRET_TOKEN
    ) {
      throw buildSyntheticError(testErrMode);
    }

    const ownerCtx = ownerKey ? await loadOwnerContext(ownerKey) : { profile: null, priorConversationCount: 0 };

    const systemPrompt = buildSystemPrompt({
      pageContext,
      collectionId,
      ownerKey: ownerKey ?? undefined,
      userWallet: userWallet ?? undefined,
      walletConnected,
      marketPulse,
      dailyDeal,
      profile: ownerCtx.profile,
      priorConversationCount: ownerCtx.priorConversationCount,
    });
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

    // Per-iteration timing capture for the [chat-trace] log emitted at the
    // end of the request. The 504s reported 2026-05-07 are ambiguous between
    // long Anthropic calls (history blow-up on long sessions) and slow tool
    // dispatch — these spans surface where the budget actually goes.
    type IterationTrace = {
      iteration: number;
      anthropic_ms: number;
      stop_reason: string | null;
      tool_calls: Array<{ name: string; ms: number; timed_out: boolean }>;
      tool_total_ms: number;
    };
    const iterationTraces: IterationTrace[] = [];
    const requestStartedMs = Date.now();

    const runIterationStreaming = async () => {
      const stream = anthropic.messages.stream({
        model: CONCIERGE_MODEL,
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
        const trace: IterationTrace = {
          iteration: iterations,
          anthropic_ms: 0,
          stop_reason: null,
          tool_calls: [],
          tool_total_ms: 0,
        };
        const anthropicStart = Date.now();
        const response = useStream
          ? await runIterationStreaming()
          : await anthropic.messages.create({
              model: CONCIERGE_MODEL,
              max_tokens: 1024,
              system: systemPrompt,
              tools: TOOLS,
              messages: currentMessages,
            });
        trace.anthropic_ms = Date.now() - anthropicStart;
        trace.stop_reason = response.stop_reason ?? null;

        if (response.stop_reason === "end_turn") {
          finalResponse = response.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n")
            .trim();
          iterationTraces.push(trace);
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
            const toolStart = Date.now();
            let timedOut = false;
            const result = await Promise.race([
              executeTool(tb.name, tb.input, {
                sessionId,
                ownerKey: ownerKey ?? null,
                userWallet: userWallet ?? null,
                userEmail: userEmail ?? null,
                collectionId: collectionId ?? null,
                pageContext: pageContext ?? null,
              }),
              new Promise<string>((resolve) =>
                setTimeout(() => {
                  timedOut = true;
                  resolve(JSON.stringify({ status: "timeout", message: "Tool timed out — try a simpler query" }));
                }, 6000)
              ),
            ]);
            const toolMs = Date.now() - toolStart;
            trace.tool_calls.push({ name: tb.name, ms: toolMs, timed_out: timedOut });
            trace.tool_total_ms += toolMs;
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
          iterationTraces.push(trace);
          continue;
        }

        finalResponse = response.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n")
          .trim();
        iterationTraces.push(trace);
        break;
      }
    };

    const finalize = async () => {
      if (conciergeErrorMode) {
        finalResponse = CONCIERGE_ERROR_MESSAGES[conciergeErrorMode].response;
      } else {
        if (!finalResponse) {
          finalResponse = "That query was too complex for me to handle in time. Try breaking it down. You can also check the Sniper page directly for the full live feed.";
        }
        if (escalated) {
          finalResponse += "\n\nYou can also DM us directly at https://twitter.com/RipPacksCity for a faster response.";
        }
      }
      const category = resolveCategory(message, conciergeErrorMode);

      const playerSearched =
        usedTools.includes("search_catalog_deals") || usedTools.includes("search_live_deals") || usedTools.includes("search_across_collections")
          ? body.message.match(/\b([A-Z][a-z]+ [A-Z][a-z]+)\b/)?.[0] ?? undefined
          : undefined;

      try {
        console.log(
          "[tool-trace] " +
            JSON.stringify({
              session: sessionId,
              tools: usedTools,
              count: usedTools.length,
            })
        );
      } catch { /* logging is best-effort */ }

      // [chat-trace] one structured line capturing per-iteration spend so
      // we can attribute 504s to either the Anthropic call or specific tool
      // calls. Format is intentionally shallow JSON so a single grep over
      // Vercel logs can answer "which iteration / which tool was slow"
      // without joining across log lines.
      try {
        const totalMs = Date.now() - requestStartedMs;
        const anthropicTotal = iterationTraces.reduce((s, t) => s + t.anthropic_ms, 0);
        const toolTotal = iterationTraces.reduce((s, t) => s + t.tool_total_ms, 0);
        console.log(
          "[chat-trace] " +
            JSON.stringify({
              session: sessionId,
              total_ms: totalMs,
              iterations: iterationTraces.length,
              anthropic_ms_total: anthropicTotal,
              tool_ms_total: toolTotal,
              messages_in_history: recentHistory.length,
              stream: useStream,
              iter: iterationTraces,
              error_mode: conciergeErrorMode,
            })
        );
      } catch { /* logging is best-effort */ }

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
          owner_key: ownerKey ?? null,
          user_email: userEmail ?? null,
          page_context: pageContext ?? null,
          is_smoke_test: isSmokeTest,
        });
        await updateSession(
          sessionId,
          category,
          message,
          { ownerKey: ownerKey ?? null, userWallet: userWallet ?? null, userEmail: userEmail ?? null, isSmokeTest },
          playerSearched
        ).catch(() => {});
      });

      return { response: finalResponse, escalated, escalationReason, category };
    };

    if (useStream && streamResponse && streamWriter) {
      (async () => {
        try {
          await runLoop();
        } catch (err: any) {
          conciergeErrorMode = classifyAnthropicError(err);
          if (conciergeErrorMode === "model_error") reportConciergeModelError(err);
          console.log("[support-chat] runLoop streaming error:", err?.status ?? "", err?.name ?? "", conciergeErrorMode, (err?.message ?? String(err)).slice(0, 120));
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
    if (mode === "model_error") reportConciergeModelError(err);
    const meta = CONCIERGE_ERROR_MESSAGES[mode];
    const category = resolveCategory(parsedMessage ?? "", mode);
    console.log("[sc_err] status", err?.status ?? "");
    console.log("[sc_err] name", err?.name ?? "");
    console.log("[sc_err] mode", mode);
    console.log("[sc_err] m1", m.slice(0, 40));
    console.log("[sc_err] m2", m.slice(40, 120));

    try {
      const session = parsedSessionId ?? req.headers.get("x-rpc-session-id") ?? `error-${Date.now()}`;
      after(() =>
        persistConversation({
          session_id: session,
          user_message: parsedMessage ?? "(error path — body unavailable)",
          bot_response: meta.response,
          escalated: false,
          escalation_reason: null,
          category,
          user_wallet: parsedUserWallet,
          owner_key: parsedOwnerKey,
          user_email: parsedUserEmail,
          page_context: parsedPageContext,
          is_smoke_test: isSmokeTest,
        })
      );
    } catch { /* best-effort */ }

    // concierge_unavailable rows are the ticket queue Trevor reviews — query
    // support_conversations WHERE category='concierge_unavailable' AND
    // is_smoke_test=false to see what people were asking when the chat was
    // offline. The `escalate: true` flag tells the frontend to render the
    // existing "logged for Trevor" indicator so the user knows their question
    // was captured. Persisted row keeps escalated=false to avoid polluting
    // the real-escalation queries Trevor runs against the same table.
    const escalateForFrontend = category === "concierge_unavailable";

    return NextResponse.json(
      {
        response: meta.response,
        escalated: false,
        escalate: escalateForFrontend,
        category,
      },
      { status: 200 }
    );
  }
}
