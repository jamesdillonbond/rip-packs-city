// app/api/admin/beta-activity/route.ts
//
// GET /api/admin/beta-activity
// Authorization: Bearer <RPC_ADMIN_TOKEN | INGEST_SECRET_TOKEN>
//
// Per-beta-user activity rollup for /admin/beta-activity. Joins allow_list
// (active users) → user_profiles (last_active_at) → usage_events (last 7d
// page-view count + last seen + top features).
//
// All reads via supabaseAdmin since usage_events is service-role-only and
// allow_list is gated.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const ingest = process.env.INGEST_SECRET_TOKEN;
  const admin = process.env.RPC_ADMIN_TOKEN;
  if (ingest && auth === `Bearer ${ingest}`) return true;
  if (admin && auth === `Bearer ${admin}`) return true;
  return false;
}

interface AllowListRow {
  email: string;
  username: string | null;
  wallet_addr: string | null;
  status: string;
  approved_at: string | null;
}

interface ProfileRow {
  id: string;
  last_active_at: string | null;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = supabaseAdmin as any;

  // 1. All active beta users.
  const { data: allowRowsRaw, error: alErr } = await sb
    .from("allow_list")
    .select("email, username, wallet_addr, status, approved_at")
    .eq("status", "active")
    .order("approved_at", { ascending: false });

  if (alErr) {
    return NextResponse.json({ error: alErr.message }, { status: 500 });
  }
  const allowRows = (allowRowsRaw ?? []) as AllowListRow[];
  const wallets = allowRows.map((r) => r.wallet_addr).filter((w): w is string => !!w);

  // 2. Auth.users — fetched via the admin auth API to bridge email → user_id.
  // We then look up user_profiles.last_active_at by id.
  const emailToId = new Map<string, string>();
  try {
    let page = 1
    // Walk pages of 1000 until we've covered every email in our allow_list.
    // This is bounded — beta has ~50 users today, so we'll exit after page 1.
    while (page <= 5) {
      const { data: usersPage } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
      const usersList = (usersPage as { users?: Array<{ id: string; email?: string | null }> } | null)?.users ?? [];
      for (const u of usersList) {
        if (u.email) emailToId.set(u.email.toLowerCase(), u.id);
      }
      if (usersList.length < 1000) break;
      page += 1;
    }
  } catch (err) {
    console.log("[beta-activity] auth.admin.listUsers failed:", err);
  }

  const userIds = Array.from(new Set(Array.from(emailToId.values())));

  // 3. user_profiles.last_active_at by id.
  let profilesById = new Map<string, ProfileRow>();
  if (userIds.length > 0) {
    const { data: profileRows } = await sb
      .from("user_profiles")
      .select("id, last_active_at")
      .in("id", userIds);
    if (Array.isArray(profileRows)) {
      profilesById = new Map(profileRows.map((p: ProfileRow) => [p.id, p]));
    }
  }

  // 4. usage_events — last 7d page-view counts + last_seen + top features
  // per wallet_address (which can be a literal wallet, "user:<uuid>", or "anon").
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const lookupKeys = new Set<string>();
  for (const w of wallets) lookupKeys.add(w.toLowerCase());
  for (const id of userIds) lookupKeys.add(`user:${id}`);

  const eventCounts = new Map<string, { pageViews7d: number; lastSeen: string | null; features: Map<string, number> }>();
  if (lookupKeys.size > 0) {
    const { data: eventRows } = await sb
      .from("usage_events")
      .select("wallet_address, feature_name, occurred_at")
      .gte("occurred_at", sevenDaysAgo)
      .in("wallet_address", Array.from(lookupKeys));

    for (const ev of (eventRows ?? []) as Array<{ wallet_address: string; feature_name: string; occurred_at: string }>) {
      const key = ev.wallet_address.toLowerCase();
      let bucket = eventCounts.get(key);
      if (!bucket) {
        bucket = { pageViews7d: 0, lastSeen: null, features: new Map() };
        eventCounts.set(key, bucket);
      }
      if (ev.feature_name === "page-view") bucket.pageViews7d += 1;
      const featCount = bucket.features.get(ev.feature_name) ?? 0;
      bucket.features.set(ev.feature_name, featCount + 1);
      if (!bucket.lastSeen || ev.occurred_at > bucket.lastSeen) bucket.lastSeen = ev.occurred_at;
    }
  }

  // 5. Stitch into rows.
  const out = allowRows.map((row) => {
    const id = row.email ? emailToId.get(row.email.toLowerCase()) ?? null : null;
    const profile = id ? profilesById.get(id) ?? null : null;

    let bucket = row.wallet_addr ? eventCounts.get(row.wallet_addr.toLowerCase()) : undefined;
    if (!bucket && id) bucket = eventCounts.get(`user:${id}`);

    const topFeatures = bucket
      ? Array.from(bucket.features.entries())
          .filter(([k]) => k !== "page-view")
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([feature, count]) => ({ feature, count }))
      : [];

    return {
      email: row.email,
      username: row.username,
      wallet_addr: row.wallet_addr,
      approved_at: row.approved_at,
      last_active_at: profile?.last_active_at ?? null,
      page_views_7d: bucket?.pageViews7d ?? 0,
      last_seen_at: bucket?.lastSeen ?? null,
      top_features: topFeatures,
    };
  });

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    user_count: out.length,
    rows: out,
  });
}
