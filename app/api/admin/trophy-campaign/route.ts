// app/api/admin/trophy-campaign/route.ts
//
// GET /api/admin/trophy-campaign
// Authorization: Bearer <RPC_ADMIN_TOKEN | INGEST_SECRET_TOKEN>
//
// Backs /admin/trophy-campaign (2026-09-27): who has started a trophy case, who
// has finished one (6/6), who has not started (the campaign audience), and which
// campaign link drove each first pin. Reads the service-role-only views
// `trophy_case_campaign_users` + `trophy_case_campaign_daily` and bridges user_id
// → email with the auth admin API.
//
// ⚠ Every read here FAILS the request rather than degrading. A missing auth page
// would move real accounts into "not started"; a failed view read would render
// "0 started". Both are the failed-read-as-answer class — an operator acting on
// this list emails people, so a partial list is worse than an error.

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

interface CampaignUserRow {
  user_id: string;
  is_internal: boolean;
  internal_reason: string | null;
  started_at: string;
  started_at_source: "observed" | "backfill_upper_bound";
  completed_at: string | null;
  completed_at_source: "observed" | "backfill_upper_bound" | null;
  current_slots: number;
  first_pin_event_at: string | null;
  first_pin_utm_source: string | null;
  first_pin_utm_medium: string | null;
  first_pin_utm_campaign: string | null;
  first_pin_share_ref: string | null;
}

interface DailyRow {
  day_pt: string;
  started_external: number;
  completed_external: number;
  started_internal: number;
  completed_internal: number;
  includes_backfill: boolean;
}

interface AuthUser {
  id: string;
  email: string | null;
  created_at: string | null;
  last_sign_in_at: string | null;
}

const AUTH_PAGE = 1000;
const AUTH_MAX_PAGES = 20;

/** Every auth user, or throws. A partial walk is refused, never returned. */
async function listAllAuthUsers(sb: any): Promise<AuthUser[]> {
  const out: AuthUser[] = [];
  for (let page = 1; page <= AUTH_MAX_PAGES; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: AUTH_PAGE });
    if (error) throw new Error(`auth.admin.listUsers page ${page}: ${error.message}`);
    const users = (data?.users ?? []) as Array<Record<string, any>>;
    for (const u of users) {
      out.push({
        id: String(u.id),
        email: u.email ?? null,
        created_at: u.created_at ?? null,
        last_sign_in_at: u.last_sign_in_at ?? null,
      });
    }
    if (users.length < AUTH_PAGE) return out;
  }
  throw new Error(`auth user walk exceeded ${AUTH_MAX_PAGES} pages; refusing a partial list`);
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = supabaseAdmin as any;

  try {
    const [usersRes, dailyRes, internalRes, authUsers] = await Promise.all([
      sb.from("trophy_case_campaign_users").select("*").order("started_at", { ascending: true }).limit(1000),
      sb.from("trophy_case_campaign_daily").select("*").order("day_pt", { ascending: false }).limit(1000),
      sb.from("internal_accounts").select("user_id, reason").limit(1000),
      listAllAuthUsers(sb),
    ]);
    if (usersRes.error) throw new Error(`trophy_case_campaign_users: ${usersRes.error.message}`);
    if (dailyRes.error) throw new Error(`trophy_case_campaign_daily: ${dailyRes.error.message}`);
    if (internalRes.error) throw new Error(`internal_accounts: ${internalRes.error.message}`);

    const campaignRows = (usersRes.data ?? []) as CampaignUserRow[];
    const internal = new Map<string, string>(
      ((internalRes.data ?? []) as Array<{ user_id: string; reason: string }>).map((r) => [r.user_id, r.reason])
    );
    const byId = new Map(authUsers.map((u) => [u.id, u]));
    const startedIds = new Set(campaignRows.map((r) => r.user_id));

    const users = campaignRows.map((r) => ({
      ...r,
      email: byId.get(r.user_id)?.email ?? null,
      status: r.completed_at ? ("completed" as const) : ("started" as const),
    }));

    const notStarted = authUsers
      .filter((u) => !startedIds.has(u.id))
      .map((u) => ({
        user_id: u.id,
        email: u.email,
        is_internal: internal.has(u.id),
        internal_reason: internal.get(u.id) ?? null,
        signed_up_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
      }))
      .sort((a, b) => String(b.signed_up_at ?? "").localeCompare(String(a.signed_up_at ?? "")));

    const ext = (rows: Array<{ is_internal: boolean }>) => rows.filter((r) => !r.is_internal).length;
    const completed = users.filter((u) => u.status === "completed");

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      totals: {
        accounts: authUsers.length,
        accounts_external: authUsers.filter((u) => !internal.has(u.id)).length,
        started_external: ext(users),
        completed_external: ext(completed),
        not_started_external: ext(notStarted),
        started_internal: users.length - ext(users),
        completed_internal: completed.length - ext(completed),
      },
      users,
      not_started: notStarted,
      daily: (dailyRes.data ?? []) as DailyRow[],
    });
  } catch (err) {
    // Operator-secret-gated route: the driver message is the diagnostic.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[admin/trophy-campaign]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
