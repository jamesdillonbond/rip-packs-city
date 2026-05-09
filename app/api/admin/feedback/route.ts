// app/api/admin/feedback/route.ts
// GET — list support_conversations for triage, plus aggregate stats.
//
// Reads directly from public.support_conversations (NOT beta_feedback_inbox)
// so callers can also query the shipped/wontfix/duplicate buckets — the inbox
// view filters those out. Stats come from public.beta_feedback_stats.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

const VALID_STATUSES = new Set([
  "new",
  "reviewed",
  "in_progress",
  "shipped",
  "wontfix",
  "duplicate",
]);

const VALID_TYPES = new Set([
  "bug",
  "feature_request",
  "confusion",
  "general_feedback",
  "praise",
]);

const DEFAULT_OPEN_STATUSES = ["new", "reviewed", "in_progress"];

const SELECT_COLUMNS = [
  "id",
  "created_at",
  "updated_at",
  "shipped_at",
  "owner_key",
  "user_wallet",
  "user_email",
  "page_context",
  "feedback_type",
  "feedback_summary",
  "feedback_details",
  "feedback_status",
  "admin_note",
  "duplicate_of",
  "user_message",
  "bot_response",
  "session_id",
].join(",");

function parseCsv(raw: string | null, allow: Set<string>): string[] | null {
  if (!raw) return null;
  const out = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && allow.has(s));
  return out.length > 0 ? out : null;
}

interface StatsRow {
  feedback_type: string | null;
  feedback_status: string | null;
  n: number | string;
  shipped_last_7d: boolean | null;
}

function buildStats(rows: StatsRow[]) {
  let open_bugs = 0;
  let open_features = 0;
  let open_confusion = 0;
  let open_general = 0;
  let open_praise = 0;
  let shipped_last_7d = 0;
  let wontfix_total = 0;
  let total_triaged = 0;
  let total_open = 0;

  for (const r of rows) {
    const n = Number(r.n) || 0;
    const status = r.feedback_status ?? "new";
    const type = r.feedback_type ?? "general_feedback";
    const isOpen = status === "new" || status === "reviewed" || status === "in_progress";

    if (isOpen) {
      total_open += n;
      if (type === "bug") open_bugs += n;
      else if (type === "feature_request") open_features += n;
      else if (type === "confusion") open_confusion += n;
      else if (type === "praise") open_praise += n;
      else open_general += n;
    } else {
      total_triaged += n;
      if (status === "wontfix") wontfix_total += n;
      if (status === "shipped" && r.shipped_last_7d === true) shipped_last_7d += n;
    }
  }

  return {
    open_bugs,
    open_features,
    open_confusion,
    open_general,
    open_praise,
    shipped_last_7d,
    wontfix_total,
    total_triaged,
    total_open,
  };
}

export async function GET(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();

  const { searchParams } = new URL(req.url);
  const statuses = parseCsv(searchParams.get("status"), VALID_STATUSES) ?? DEFAULT_OPEN_STATUSES;
  const types = parseCsv(searchParams.get("type"), VALID_TYPES);
  const ownerKey = searchParams.get("owner_key")?.trim() || null;
  const q = searchParams.get("q")?.trim() || null;

  const limitRaw = Number(searchParams.get("limit") ?? "100");
  const limit = Math.min(500, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100));

  let query = supabaseAdmin
    .from("support_conversations")
    .select(SELECT_COLUMNS)
    .not("feedback_type", "is", null)
    .in("feedback_status", statuses);

  if (types) query = query.in("feedback_type", types);
  if (ownerKey) query = query.eq("owner_key", ownerKey);

  if (q) {
    const escaped = q.replace(/[%,()]/g, " ");
    const pattern = `%${escaped}%`;
    query = query.or(
      `feedback_summary.ilike.${pattern},feedback_details.ilike.${pattern},user_message.ilike.${pattern}`
    );
  }

  // Open states first, then most recent. Postgrest doesn't expose CASE
  // ordering, so we approximate by ordering on feedback_status (alphabetical
  // happens to put 'in_progress','new','reviewed' ahead of 'shipped','wontfix'
  // — but not 'duplicate'). Re-sort in app code below to make the rank
  // deterministic regardless of alphabet drift.
  const { data: rawRows, error } = await query
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const STATUS_RANK: Record<string, number> = {
    new: 0,
    reviewed: 1,
    in_progress: 2,
    shipped: 3,
    duplicate: 4,
    wontfix: 5,
  };
  const rows = (rawRows ?? []).slice().sort((a: any, b: any) => {
    const ra = STATUS_RANK[a.feedback_status] ?? 99;
    const rb = STATUS_RANK[b.feedback_status] ?? 99;
    if (ra !== rb) return ra - rb;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  const { data: statsRows, error: statsErr } = await supabaseAdmin
    .from("beta_feedback_stats")
    .select("feedback_type,feedback_status,n,shipped_last_7d");

  if (statsErr) {
    return NextResponse.json({ error: statsErr.message }, { status: 500 });
  }

  const stats = buildStats((statsRows ?? []) as StatsRow[]);

  return NextResponse.json({ rows, stats });
}
