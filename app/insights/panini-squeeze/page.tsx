// Panini WC Prizm squeeze — public insights surface. LIVE (PANINI_PUBLIC = true).
//
// The go-live mechanism is the SINGLE compile-time flag PANINI_PUBLIC in lib/launch-flags.ts, which
// fans out to all five consumers at once (the proxy.ts route wall, the sitemap slug, the /insights hub
// card, this surface's layout robots, and the smoke-test public list). Flipping it back to false is the
// complete rollback. The old instruction that lived here — "remove the proxy line, add the sitemap slug,
// drop robots:noindex" — is SUPERSEDED and would now be actively wrong: proxy.ts reads the flag, so
// hand-editing it half-ships the surface (un-gated but still noindex, still missing from the sitemap).
import { supabaseAdmin } from "@/lib/supabase";
import PaniniSqueezeClient from "./PaniniSqueezeClient";

export const revalidate = 300;

const COLS =
  // See the note in app/api/public/insights/panini-squeeze/route.ts — this column counts
  // serial-level price coverage, not sales. Renamed from `real_sales` 2026-07-28.
  // `coverage_flag` is a per-(set,parallel) LISTING-BIAS band, joined from panini_coverage_audit.
  // It is derived purely from for_sale_count / pulled_count — the share of pulled copies currently
  // listed — so it is a bias-RISK indicator, never a coverage measurement. Do not label it
  // "coverage" on the surface; the honest words are sample breadth / listing bias.
  //
  // `fmv_confidence` (added 2026-08-01) is fetched for ONE purpose: flagging the ASK_ONLY rows,
  // whose FMV is 0.90 × a single seller's ask on a card that has never traded (see
  // lib/chains/panini/ingest-normalize.ts::toFmvRow). 727 editions here are priced that way and
  // nothing distinguished them — the board's own top row was 90% of one $500,010 ask. The client
  // renders a plain-English "from asks" marker via lib/fmv-basis.ts; the confidence VALUE itself
  // never reaches the DOM, per the standing no-confidence-UI policy.
  "player_name,set_name,tier,mint_cap,pulled_count,still_in_packs,rip_pct,fmv_usd,sealed_fmv_exposure_usd,serial_low_ask_usd,is_rookie,is_debut,serials_with_recorded_price,coverage_flag,fmv_confidence";

// Fetch the WHOLE board, not a slice. The filters (rookies, mint-cap bands, search) run
// client-side, so a truncated fetch silently truncates every filter: measured 2026-07-19,
// "Rookies" showed 43 of 400 real rookies (11%) and "<= /25" showed 271 of 935 (29%),
// because low-FMV rows never made the cut. The client caps how many rows it RENDERS, so
// the DOM stays bounded while filtering stays complete.
//
// MUST paginate with .range(): PostgREST caps reads at 1000 rows and silently CLAMPS an
// explicit .limit() above that — a first attempt used .limit(3000) and quietly got 1000,
// which still left "Rookies" at 177 of 400. Loop until a short page comes back.
const PAGE = 1000;
const MAX_PAGES = 10; // hard stop so a runaway view can never spin the request

async function fetchRows() {
  const all: any[] = [];
  for (let p = 0; p < MAX_PAGES; p++) {
    const { data, error } = await (supabaseAdmin as any)
      .from("panini_squeeze_board")
      .select(COLS)
      .not("fmv_usd", "is", null)
      .order("fmv_usd", { ascending: false })
      .range(p * PAGE, p * PAGE + PAGE - 1);
    if (error) {
      console.error("[panini-squeeze] backing view error:", error.message);
      return all; // degrade to whatever we already have rather than blanking the board
    }
    const batch = data ?? [];
    all.push(...batch);
    if (batch.length < PAGE) break;
  }
  return all;
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
        "best_family_checklist_pct,worst_family_checklist_pct,checklist_players_seen,checklist_players_new_24h," +
        "oldest_family_refresh_h,newest_family_refresh_h"
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
//
// The `_hc` columns are the HONEST subset: broad + partial only, excluding the sets whose
// discovery is listing-biased. They exist because the blended figure is dominated by exactly
// those biased sets — 60.6% of sealed dollars as of 2026-07-28 — so publishing the blend as
// THE number repeats the survivor-bias mistake the chase-biased pack pools made on 07-16.
// The blend is still fetched and still shown, clearly labelled, as the secondary line.
async function fetchTotals() {
  const { data, error } = await (supabaseAdmin as any)
    .from("panini_squeeze_totals")
    .select(
      "editions,sealed_fmv_exposure_usd,chases_lte_25,sealed_copies," +
        "editions_hc,sealed_fmv_exposure_usd_hc,sealed_copies_hc,pct_sealed_usd_from_biased_sets"
    )
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
