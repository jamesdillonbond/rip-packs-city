// Public JSON backing the /insights/panini-squeeze page + OG card. STAGED: gated pre-launch by the
// single `/(?:...)\/panini` line in proxy.ts (returns false -> auth gate). Un-gates at go-live with the page.
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

const COLS =
  // `serials_with_recorded_price` was named `real_sales` until 2026-07-28. It has always
  // counted serial-level PRICE COVERAGE (serials carrying a last_sale_usd), never market
  // activity — only ~17% of ingested serials have a price at all — while the adjacent
  // fmv_confidence derives from the upstream marketplace txn count. Two different
  // quantities in neighbouring columns read as corroborating, which is why 840 editions
  // showed HIGH confidence beside `real_sales = 0`. Renamed, not re-sourced: ms.txns is
  // discarded at ingest today and is not available to the view.
  //
  // `coverage_flag` (added 2026-07-28) is the per-(set, parallel) LISTING-BIAS band from
  // panini_coverage_audit, banded purely on for_sale_count / pulled_count. A consumer must not
  // read it as a coverage percentage: it says how listing-driven our sample of that parallel is,
  // and says nothing about the cards we have never seen. broad|partial are the lower-bias subset
  // the page headlines; heavily_biased|listing_gated carry ~60% of blended sealed value.
  "player_name,set_name,tier,mint_cap,pulled_count,still_in_packs,rip_pct,fmv_usd,sealed_fmv_exposure_usd,serial_low_ask_usd,is_rookie,is_debut,serials_with_recorded_price,coverage_flag";

const VALID_TIERS = new Set(["COMMON", "RARE", "LEGENDARY", "ULTIMATE"]);
const VALID_SORTS: Record<string, string> = {
  fmv: "fmv_usd",
  sealed: "sealed_fmv_exposure_usd",
  rip: "rip_pct",
  supply: "still_in_packs",
  mint: "mint_cap",
};

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const sp = new URL(req.url).searchParams;
  const tier = sp.get("tier")?.toUpperCase() || null;
  const set = sp.get("set");
  const player = sp.get("player");
  const rookie = sp.get("rookie") === "1";
  const maxMint = sp.get("max_mint") ? Number(sp.get("max_mint")) : null;
  const sortKey = VALID_SORTS[sp.get("sort") || "fmv"] || "fmv_usd";
  const limit = Math.max(1, Math.min(300, Number(sp.get("limit") ?? "100")));

  if (tier && !VALID_TIERS.has(tier)) {
    return NextResponse.json({ error: `invalid tier '${tier}'` }, { status: 400 });
  }

  let q = (supabase as any).from("panini_squeeze_board").select(COLS).not("fmv_usd", "is", null);
  if (tier) q = q.eq("tier", tier);
  if (set) q = q.ilike("set_name", `%${set}%`);
  if (player) q = q.ilike("player_name", `%${player}%`);
  if (rookie) q = q.eq("is_rookie", true);
  if (maxMint && Number.isFinite(maxMint)) q = q.lte("mint_cap", maxMint);
  q = q.order(sortKey, { ascending: false, nullsFirst: false }).limit(limit);

  const { data, error } = await q;
  if (error) {
    console.error("[panini-squeeze api]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Honest-coverage disclosure, carried in the CONTRACT so a consumer cannot render this
  // board as a census by accident. Panini publishes no checklist — an edition is indexed
  // only once it has been listed — so completeness is structurally partial and must be
  // stated. panini_coverage_summary self-measures; nothing here is hardcoded.
  // Fail-soft: the board is the primary payload, so a coverage error omits the block
  // rather than 500-ing the response.
  let coverage: Record<string, unknown> | null = null;
  const { data: cov, error: covErr } = await (supabase as any)
    .from("panini_coverage_summary")
    .select(
      "total_editions,trustworthy_editions,pct_trustworthy,listing_gated_editions,listing_gated_families,families," +
        "best_family_checklist_pct,worst_family_checklist_pct,checklist_players_seen,checklist_players_new_24h"
    )
    .limit(1);
  if (covErr) {
    console.error("[panini-squeeze api] coverage:", covErr.message);
  } else if (cov?.[0]) {
    coverage = {
      ...cov[0],
      basis: "listing_gated",
      note:
        "Panini publishes no full checklist; a card is indexed only once it has been listed for sale. " +
        "Per-parallel coverage runs roughly best_family_checklist_pct down to worst_family_checklist_pct, " +
        "thinnest where cards are scarcest. NOTE pct_trustworthy is a COMPOSITION share (editions in " +
        "well-covered families), NOT a coverage percentage. checklist_players_seen is a LOWER bound on the " +
        "true checklist and is still growing, so every percent-of-checklist figure is best-case. " +
        "Treat as a floor, not a census.",
    };
  }

  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "panini_squeeze_board",
      set: "2026 Prizm World Cup Soccer",
      total_rows: data?.length ?? 0,
      elapsed_ms: Date.now() - t0,
      coverage,
      filters: { tier, set, player, rookie, max_mint: maxMint, sort: sortKey, limit },
    },
    rows: data ?? [],
  });
  res.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
  return res;
}
