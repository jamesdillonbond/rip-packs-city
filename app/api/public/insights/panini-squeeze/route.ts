// Public JSON backing the /insights/panini-squeeze page + OG card. STAGED: gated pre-launch by the
// single `/(?:...)\/panini` line in proxy.ts (returns false -> auth gate). Un-gates at go-live with the page.
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

const COLS =
  "player_name,set_name,tier,mint_cap,pulled_count,still_in_packs,rip_pct,fmv_usd,sealed_fmv_exposure_usd,serial_low_ask_usd,is_rookie,is_debut,real_sales";

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
      "total_editions,trustworthy_editions,pct_trustworthy,listing_gated_editions,listing_gated_families,families"
    )
    .limit(1);
  if (covErr) {
    console.error("[panini-squeeze api] coverage:", covErr.message);
  } else if (cov?.[0]) {
    coverage = {
      ...cov[0],
      basis: "listing_gated",
      note: "Panini publishes no full checklist; an edition is indexed once it has been listed for sale. Coverage is strongest on high-print parallels and thinnest on the scarcest. Treat as a floor, not a census.",
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
