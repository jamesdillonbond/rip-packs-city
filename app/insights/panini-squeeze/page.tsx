// Panini WC Prizm squeeze — public insights surface (STAGED, gated pre-launch).
// Gated in proxy.ts (isPublicPath returns false for /insights/panini*) + noindex in layout, and NOT in
// the sitemap or the /insights hub, until the multi-chain public launch. Go-live = remove the proxy line,
// add the sitemap slug + hub card, drop the layout robots:noindex.
import { supabaseAdmin } from "@/lib/supabase";
import PaniniSqueezeClient from "./PaniniSqueezeClient";

export const revalidate = 300;

const COLS =
  "player_name,set_name,tier,mint_cap,pulled_count,still_in_packs,rip_pct,fmv_usd,sealed_fmv_exposure_usd,serial_low_ask_usd,is_rookie,is_debut,real_sales";

async function fetchRows() {
  const { data, error } = await (supabaseAdmin as any)
    .from("panini_squeeze_board")
    .select(COLS)
    .not("fmv_usd", "is", null)
    .order("fmv_usd", { ascending: false })
    .limit(300);
  if (error) {
    console.error("[panini-squeeze] backing view error:", error.message);
    return [];
  }
  return data ?? [];
}

// Panini publishes no full checklist, so an edition only enters our index once it has
// been LISTED (the runner enumerates from getMarketPlaceList). Coverage is therefore
// strongest on high-print parallels and thinnest on the scarcest ones. This board must
// SAY that rather than imply completeness — same honesty stance as the Sold-tab lower
// bound. panini_coverage_summary self-measures, so the disclosure can never go stale.
async function fetchCoverage() {
  const { data, error } = await (supabaseAdmin as any)
    .from("panini_coverage_summary")
    .select(
      "total_editions,trustworthy_editions,pct_trustworthy,listing_gated_editions,listing_gated_families,families," +
        "best_family_checklist_pct,worst_family_checklist_pct,checklist_players_seen,checklist_players_new_24h"
    )
    .limit(1);
  if (error) {
    // Never let the disclosure query take down the board — degrade to no banner.
    console.error("[panini-squeeze] coverage summary error:", error.message);
    return null;
  }
  return data?.[0] ?? null;
}

// KPI totals over the WHOLE board. Previously the KPIs were summed client-side from the
// 300-row slice below, so the page showed "EDITIONS 300" under a banner saying it indexes
// 1,842 — and "Sealed copies" read 742 against a true 22,575 (the top-300-by-FMV are scarce
// low-print cards; sealed volume lives in the high-print commons that never make that cut).
async function fetchTotals() {
  const { data, error } = await (supabaseAdmin as any)
    .from("panini_squeeze_totals")
    .select("editions,sealed_fmv_exposure_usd,chases_lte_25,sealed_copies")
    .limit(1);
  if (error) {
    // Fail-soft: the client falls back to slice-derived KPIs rather than rendering nothing.
    console.error("[panini-squeeze] totals error:", error.message);
    return null;
  }
  return data?.[0] ?? null;
}

export default async function PaniniSqueezePage() {
  const [rows, coverage, totals] = await Promise.all([fetchRows(), fetchCoverage(), fetchTotals()]);
  return (
    <PaniniSqueezeClient
      initialRows={rows}
      coverage={coverage}
      totals={totals}
      fetchedAt={new Date().toISOString()}
    />
  );
}
