import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { ownLookup } from "@/lib/safe-lookup";
import { resolvePlayerName } from "@/lib/concierge/player-identity";
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections";

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

  const col = ownLookup(COLUMN_BY_KIND, kind);
  if (!col || q.length < 2) {
    return NextResponse.json({ suggestions: [] });
  }

  try {
    // The name's start OR any later word's start ("jok" → "Nikola Jokić").
    const prefixRead = (pattern: string) => {
      let query = (supabaseAdmin as any)
        .from("editions")
        .select(col)
        .ilike(col, pattern)
        .not(col, "is", null)
        .order(col, { ascending: true })
        .limit(400);
      if (collection) query = query.eq("collection_id", collection);
      return query;
    };
    const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
    // #207: both reads are accent-SENSITIVE ("jokic" finds no "Jokić"), and an
    // alert stores the spelling it is given and matches it EXACTLY. For players
    // the resolver (accent-, alias- and partial-name-aware) leads the list.
    const [startRes, wordRes, resolvedNames] = await Promise.all([
      prefixRead(`${escaped}%`),
      prefixRead(`% ${escaped}%`),
      kind === "player" ? resolvedPlayerSuggestions(q, collection) : Promise.resolve([] as string[]),
    ]);
    const error = startRes.error ?? wordRes.error;
    if (error) {
      console.log("[alerts-suggest] query error:", error.message);
      return NextResponse.json({ suggestions: [] });
    }

    const seen = new Set<string>();
    const out: string[] = [];
    for (const name of resolvedNames) {
      if (!seen.has(name.toLowerCase())) { seen.add(name.toLowerCase()); out.push(name); }
    }
    for (const row of [...(startRes.data ?? []), ...(wordRes.data ?? [])]) {
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

// One resolver read per collection in scope; a person it names becomes a
// suggestion (an ambiguous answer offers each candidate). A failed read offers none.
async function resolvedPlayerSuggestions(q: string, collection: string | null): Promise<string[]> {
  const scope = collection ? [collection] : Object.values(COLLECTION_UUID_BY_SLUG);
  const verdicts = await Promise.all(scope.map((u) => resolvePlayerName(supabaseAdmin, u, q)));
  const names: string[] = [];
  for (const v of verdicts) {
    if (v.status === "one") names.push(v.player.name);
    else if (v.status === "ambiguous") names.push(...v.candidates.map((c) => c.player.name));
  }
  return names;
}
