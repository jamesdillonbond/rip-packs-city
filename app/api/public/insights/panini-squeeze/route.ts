// Public JSON backing the /insights/panini-squeeze page + OG card. Its public/gated state is owned by
// `PANINI_PUBLIC` in lib/launch-flags.ts, read by the single `/(?:...)\/panini` line in proxy.ts (flag
// false -> returns false -> auth gate). ⚠ DO NOT restate that state here. This header read "STAGED: gated
// pre-launch" for the three weeks AFTER Trevor flipped the flag on 2026-08-01, and on 2026-08-22 it — plus
// `collections.is_active = false`, which governs anon PostgREST reads and NOT this surface — convinced a
// saturation audit that 4.6% of the database's disk reads were warming a board nobody could see. Ask the flag.
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { boardUnavailable } from "@/lib/insights/board-error";

import { boardRowMeta } from "@/lib/insights/board-meta"
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
  //
  // `fmv_confidence` (added 2026-08-01) is carried so a consumer can tell an ASK-DERIVED price
  // (ASK_ONLY = 0.90 × one seller's ask on a never-traded card, 727 editions) from a sale-derived
  // one. It is a machine field on a JSON API, not UI copy — the PAGE renders the plain-English
  // "from asks" marker instead (lib/fmv-basis.ts) and never prints the enum.
  "player_name,set_name,tier,mint_cap,pulled_count,still_in_packs,rip_pct,fmv_usd,sealed_fmv_exposure_usd,serial_low_ask_usd,is_rookie,is_debut,serials_with_recorded_price,coverage_flag,fmv_confidence";

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
  const limit = Math.max(1, Math.min(300, Number(sp.get("limit")) || 100));

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
    return boardUnavailable(error, "insights/panini-squeeze");
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
        "best_family_checklist_pct,worst_family_checklist_pct,checklist_players_seen,checklist_players_new_24h," +
        "oldest_family_refresh_h,newest_family_refresh_h"
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
        "oldest_family_refresh_h / newest_family_refresh_h are the age in hours of the least and most " +
        "recently refreshed parallel: the runner walks families in rotation rather than all at once, so " +
        "the board is a MIX of refresh ages and the oldest parallel can be many days behind the newest. " +
        "Treat as a floor, not a census.",
    };
  }

  // Second disclosure, same stance and same fail-soft shape as `coverage` above, but a
  // DIFFERENT failure: upstream stopped supplying serial sale prices on 2026-07-29, so
  // `serials_with_recorded_price` is a fossil count as of last_supplied_on. It is held
  // rather than erased (trg_panini_preserve_sale_fields), but it cannot grow while the
  // feed is out, so its ratio silently DECLINES as new serials are discovered — already
  // ~17% -> ~8%. A consumer rendering it as current price coverage would overclaim.
  // panini_sale_feed_status self-measures, so this can never go stale.
  let salePriceFeed: Record<string, unknown> | null = null;
  const { data: feed, error: feedErr } = await (supabase as any)
    .from("panini_sale_feed_status")
    .select(
      "last_supplied_on,days_since_last_supplied,total_serials,priced_serials,preserved_fossils,pct_serials_priced,feed_ok"
    )
    .limit(1);
  if (feedErr) {
    console.error("[panini-squeeze api] sale feed:", feedErr.message);
  } else if (feed?.[0]) {
    salePriceFeed = {
      ...feed[0],
      note: feed[0].feed_ok
        ? "Upstream is supplying serial sale prices normally."
        : "The Panini marketplace stopped supplying serial sale prices on last_supplied_on. " +
          "serials_with_recorded_price on each row is a HISTORICAL count as of that date, not " +
          "current price coverage: existing values are preserved but no new ones can arrive, so " +
          "pct_serials_priced falls as new serials are indexed. Treat it as a floor. This does " +
          "NOT affect fmv_usd / fmv confidence, which derive from a separate upstream feed that " +
          "remains live.",
    };
  }

  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "panini_squeeze_board",
      set: "2026 Prizm World Cup Soccer",
      ...boardRowMeta(data?.length ?? 0, limit),
      elapsed_ms: Date.now() - t0,
      coverage,
      sale_price_feed: salePriceFeed,
      filters: { tier, set, player, rookie, max_mint: maxMint, sort: sortKey, limit },
    },
    rows: data ?? [],
  });
  res.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
  return res;
}
