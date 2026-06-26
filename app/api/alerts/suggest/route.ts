import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// ── Alerts typeahead suggest ──────────────────────────────────────────────────
// Backs the player / set / team type-to-fill inputs on /alerts. Read-only catalog
// names from editions (public, denormalized columns). Authed users reach it through
// the site lockdown; anon is redirected at proxy.ts. Prefix match, deduped server-side.
//
// GET /api/alerts/suggest?kind=player|set|team&q=<text>&collection=<uuid?>
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

const COLUMN_BY_KIND: Record<string, string> = {
  player: "player_name",
  set: "set_name",
  team: "team_name",
};

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const kind = (url.searchParams.get("kind") ?? "").toLowerCase();
  const q = (url.searchParams.get("q") ?? "").trim();
  const collection = url.searchParams.get("collection")?.trim() || null;

  const col = COLUMN_BY_KIND[kind];
  if (!col || q.length < 2) {
    return NextResponse.json({ suggestions: [] });
  }

  try {
    let query = (supabaseAdmin as any)
      .from("editions")
      .select(col)
      .ilike(col, `${q}%`)
      .not(col, "is", null)
      .order(col, { ascending: true })
      .limit(400);
    if (collection) query = query.eq("collection_id", collection);

    const { data, error } = await query;
    if (error) {
      console.log("[alerts-suggest] query error:", error.message);
      return NextResponse.json({ suggestions: [] });
    }

    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of data ?? []) {
      const v = (row as any)[col];
      if (typeof v === "string" && v && !seen.has(v.toLowerCase())) {
        seen.add(v.toLowerCase());
        out.push(v);
        if (out.length >= 12) break;
      }
    }
    return NextResponse.json({ suggestions: out });
  } catch (err: any) {
    console.log("[alerts-suggest] threw:", err?.message ?? String(err));
    return NextResponse.json({ suggestions: [] });
  }
}
