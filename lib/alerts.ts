// lib/alerts.ts
//
// Server-only helper around the omni-channel alerts foundation (notification
// channels, deal subscriptions, the delivery outbox). Every mutation goes
// through the SECURITY DEFINER DB functions via the service-role client; those
// functions are REVOKEd from anon/authenticated, so this file is the only way
// to reach them.
//
// Security invariant (mirrors lib/rewards.ts): the owner_key is ALWAYS the
// session-resolved user id (requireUser().id as text) — never a value taken
// from request input. A subscription/channel body carries only filter prefs
// and the channel name; it never names another user.
//
// NEVER import this file into a "use client" component: it references the
// service-role Supabase client (SUPABASE_SERVICE_ROLE_KEY).

import { supabaseAdmin as supabase } from "@/lib/supabase";

export type Channel = "email" | "telegram" | "discord";
export const CHANNELS: Channel[] = ["email", "telegram", "discord"];
export function isChannel(v: unknown): v is Channel {
  return typeof v === "string" && (CHANNELS as string[]).includes(v);
}

// ── Channel linking ────────────────────────────────────────────────────────

// Register / refresh a pending link for (owner, channel). Returns a one-time
// 8-char code (15-min TTL). For email pass the address as channelUserId; for
// telegram/discord leave it null (the bot supplies the platform id on claim).
export async function createChannelLinkCode(
  ownerKey: string,
  channel: Channel,
  channelUserId?: string | null
) {
  const { data, error } = await (supabase as any).rpc("create_channel_link_code", {
    p_owner_key: ownerKey,
    p_channel: channel,
    p_channel_user_id: channelUserId ?? null,
  });
  if (error) {
    console.log("[alerts] create_channel_link_code err", channel, error.message);
    return null;
  }
  return data as { ok: boolean; channel: string; code: string; expires_at: string };
}

// Bind a platform identity to the pending link (the bot, or the email-verify
// route, calls this). Returns { ok, owner_key, channel } or { error }.
export async function claimChannelLink(
  channel: Channel,
  channelUserId: string,
  channelUsername: string | null,
  code: string
) {
  const { data, error } = await (supabase as any).rpc("claim_channel_link", {
    p_channel: channel,
    p_channel_user_id: channelUserId,
    p_channel_username: channelUsername,
    p_code: code,
  });
  if (error) {
    console.log("[alerts] claim_channel_link err", channel, error.message);
    return { error: "server_error" as const };
  }
  return data as { ok?: boolean; owner_key?: string; channel?: string; error?: string };
}

// Inbound bot message -> which RPC user. Touches last_used_at.
export async function resolveChannelOwner(channel: Channel, channelUserId: string) {
  const { data, error } = await (supabase as any).rpc("resolve_channel_owner", {
    p_channel: channel,
    p_channel_user_id: channelUserId,
  });
  if (error) {
    console.log("[alerts] resolve_channel_owner err", channel, error.message);
    return { linked: false as const };
  }
  return data as { linked: boolean; owner_key?: string };
}

// Resolve a linked bot DM to the user's lowercased Top Shot username, for
// concierge personalization. Mirrors the value /api/support-chat uses as
// ownerKey (the lowercased TS handle, from allow_list.username). Here the input
// is the bot channel id, so we go channel -> owner_key (auth uid) -> the user's
// saved-wallet username (lowercased), falling back to their profile_bio handle.
// Returns null for unlinked/unknown users so the concierge keeps its generic
// behavior. Best-effort: never throws.
export async function resolveChannelOwnerUsername(
  channel: Channel,
  channelUserId: string
): Promise<string | null> {
  try {
    const owner = await resolveChannelOwner(channel, channelUserId);
    if (!owner.linked || !owner.owner_key) return null;
    const { data: sw } = await supabase
      .from("saved_wallets")
      .select("username")
      .eq("user_id", owner.owner_key)
      .not("username", "is", null)
      .order("pinned_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (sw?.username) return String(sw.username).toLowerCase();
    const { data: pb } = await supabase
      .from("profile_bio")
      .select("username")
      .eq("user_id", owner.owner_key)
      .not("username", "is", null)
      .limit(1)
      .maybeSingle();
    return pb?.username ? String(pb.username).toLowerCase() : null;
  } catch (e) {
    console.log("[alerts] resolveChannelOwnerUsername err", channel, e instanceof Error ? e.message : String(e));
    return null;
  }
}

// All verified channel targets for a user (optionally one channel).
export async function getOwnerChannelTargets(ownerKey: string, channel?: Channel) {
  const { data, error } = await (supabase as any).rpc("get_owner_channel_targets", {
    p_owner_key: ownerKey,
    p_channel: channel ?? null,
  });
  if (error) {
    console.log("[alerts] get_owner_channel_targets err", error.message);
    return [];
  }
  return (data ?? []) as Array<{
    channel: Channel;
    channel_user_id: string;
    channel_username: string | null;
  }>;
}

// ── Deal-subscription preview ────────────────────────────────────────────────

// "You'd get N deals right now" — also the backing matcher the dispatcher uses.
export async function buildDealAlertsForSubscription(subscriptionId: string) {
  const { data, error } = await (supabase as any).rpc(
    "build_deal_alerts_for_subscription",
    { p_subscription_id: subscriptionId }
  );
  if (error) {
    console.log("[alerts] build_deal_alerts err", error.message);
    return null;
  }
  return data as { deals_count: number; deals: any[] } | null;
}

// ── Dispatch + outbox ────────────────────────────────────────────────────────

export async function dispatchDueDealAlerts(max = 1000) {
  const { data, error } = await (supabase as any).rpc("dispatch_due_deal_alerts", {
    p_max: max,
  });
  if (error) return { error: error.message };
  return data as { subscriptions_scanned: number; enqueued: number };
}

export async function dispatchTriggeredFmvAlerts(max = 200) {
  const { data, error } = await (supabase as any).rpc("dispatch_triggered_fmv_alerts", {
    p_max: max,
  });
  if (error) return { error: error.message };
  return data as { scanned: number; enqueued: number };
}

// Atomically claim a batch of pending deliveries for one channel (status ->
// 'sending'). A per-channel sender drains this, then marks each row.
export async function claimPendingDeliveries(channel: Channel, max = 50) {
  const { data, error } = await (supabase as any).rpc("claim_pending_deliveries", {
    p_channel: channel,
    p_max: max,
  });
  if (error) {
    console.log("[alerts] claim_pending_deliveries err", channel, error.message);
    return { channel, count: 0, deliveries: [] as Delivery[] };
  }
  return data as { channel: Channel; count: number; deliveries: Delivery[] };
}

export async function markDeliverySent(id: string) {
  const { error } = await (supabase as any).rpc("mark_delivery_sent", { p_id: id });
  if (error) console.log("[alerts] mark_delivery_sent err", error.message);
}

export async function markDeliveryFailed(id: string, errMsg: string) {
  const { error } = await (supabase as any).rpc("mark_delivery_failed", {
    p_id: id,
    p_error: errMsg.slice(0, 500),
  });
  if (error) console.log("[alerts] mark_delivery_failed err", error.message);
}

// ── Shapes ───────────────────────────────────────────────────────────────────

// One `deal` payload covers BOTH deal sources the dispatcher enqueues, since
// both insert with alert_kind='deal':
//   • edition-level  — build_deal_alerts_for_subscription / cross_collection_deals_board
//   • per-serial      — topshot_serial_deal_alerts_for_subscription / topshot_underpriced_serials_board
// The shared fields are present on both; the rest are source-specific (optional).
// The formatter (lib/alerts/format.ts) resolves the headline ask/FMV/detail-url
// with per-source fallbacks rather than branching on a discriminator.
export interface DealPayload {
  subscription_id: string;
  label: string | null;
  deal: {
    // ── Shared ──
    external_id: string;
    player_name: string | null;
    set_name: string | null;
    tier: string | null;
    collection_slug: string | null;
    circulation_count: number | null;
    confidence: string | null;
    discount_pct: number | null;
    discount_usd: number | null;
    thumbnail_url: string | null;

    // ── Edition-level (cross_collection_deals_board) ──
    name?: string | null;
    collection_name?: string | null;
    fmv_usd?: number | null;
    low_ask?: number | null;
    detail_url?: string | null;
    ask_updated_at?: string | null;

    // ── Per-serial (topshot_underpriced_serials_board) ──
    nft_id?: string | null;
    serial_number?: number | null;
    kind?: string | null; // 'first' (#1) | 'perfect'
    ask_usd?: number | null;
    serial_fmv_usd?: number | null; // serial-adjusted FMV; discount_pct is vs this
    edition_fmv_usd?: number | null; // base-edition FMV (secondary context)
    estimate_quality?: string | null;
    listing_url?: string | null; // absolute (Dapper)
    moment_url?: string | null; // relative RPC /moment/<nft_id>
  };
}

export interface FmvPayload {
  alert_id: string | number;
  edition_key: string | null;
  player_name: string | null;
  set_name: string | null;
  alert_type: string | null;
  threshold: number | null;
  current_fmv: number | null;
  lowest_ask: number | null;
  confidence: string | null;
}

export interface Delivery {
  id: string;
  owner_key: string;
  channel: Channel;
  channel_user_id: string;
  alert_kind: "deal" | "fmv" | "pack_digest";
  subject_key: string | null;
  dedup_bucket: string | null;
  payload: DealPayload | FmvPayload | Record<string, unknown>;
  status: string;
  attempts: number;
}

// ── Collection slug <-> UUID (the deal board is TS + Pinnacle today) ─────────
export const COLLECTION_UUID_BY_SLUG: Record<string, string> = {
  nba_top_shot: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  nfl_all_day: "dee28451-5d62-409e-a1ad-a83f763ac070",
  laliga_golazos: "06248cc4-b85f-47cd-af67-1855d14acd75",
  ufc_strike: "9b4824a8-736d-4a96-b450-8dcc0c46b023",
  disney_pinnacle: "7dd9dd11-e8b6-45c4-ac99-71331f959714",
};
