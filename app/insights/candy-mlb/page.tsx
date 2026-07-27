// Candy MLB ICONs — public insights surface (STAGED, gated pre-launch).
// Gated in proxy.ts (isPublicPath returns false for /insights/candy*) + noindex in layout, and NOT in the
// sitemap or the /insights hub, until the chain-two public launch. Go-live = remove the proxy line, add the
// sitemap slug + hub card + OG, drop the layout robots:noindex. Reads Candy DIRECTLY (candy_mlb stays
// is_active=false — no shared-plane flip needed). All backing views are anon/authenticated-REVOKED and read
// here via supabaseAdmin (service_role) — route-gating is NOT data-gating.
import { supabaseAdmin } from "@/lib/supabase";
import CandyBoardClient from "./CandyBoardClient";

export const revalidate = 300;

const MARKET_COLS =
  "external_id,player_name,edition_name,tier,is_rainbow,circulation_count,fmv_usd,fmv_computed_at," +
  "last_sale_serial,median_sale_usd," +
  "sales_24h,sales_7d,sales_all,last_sale_at,last_sale_usd,best_offer_usd,offer_bidders,floor_ask_usd,listing_count,excluded_troll_count";

// Small helper: every Candy board view is <600 rows (well under the PostgREST 1000 cap), so one ordered fetch
// each. Fail-soft to [] so a single view error never blanks the whole board.
async function fetchView(view: string, cols: string, orderCol: string, asc = false, limit = 600) {
  const { data, error } = await (supabaseAdmin as any)
    .from(view)
    .select(cols)
    .order(orderCol, { ascending: asc, nullsFirst: false })
    .limit(limit);
  if (error) {
    console.error(`[candy-mlb] ${view} error:`, error.message);
    return [];
  }
  return data ?? [];
}

// The pack MARKET, beside the pack MODEL. Candy packs trade on Magic Eden and
// RPC indexes those sales now — showing an EV model with no realised price next
// to it invites the reader to treat the model as the price.
async function fetchPackMarket() {
  const { data, error } = await (supabaseAdmin as any)
    .from("candy_pack_market")
    .select(
      "pack_assets_indexed,collector_held,collector_wallets,active_asks,floor_ask_usd," +
        "sales_all,sales_7d,median_7d_usd,last_sale_usd,last_sale_at," +
        "retail_usd,median_vs_retail_x,median_vs_typical_pull_x,median_vs_actual_ev_x"
    )
    .limit(1);
  if (error) {
    console.error("[candy-mlb] pack-market error:", error.message);
    return null;
  }
  return data?.[0] ?? null;
}

async function fetchPackEv() {
  const { data, error } = await (supabaseAdmin as any)
    .from("candy_pack_ev_model")
    .select(
      "icon_slots,rainbow_chance,pack_cost_usd,common_slot_ev,common_slot_typical,rainbow_ev," +
        "common_total,common_priced,rainbow_total,rainbow_priced,actual_ev_usd,typical_pull_ev_usd,model_note"
    )
    .limit(1);
  if (error) {
    console.error("[candy-mlb] pack-ev error:", error.message);
    return null;
  }
  return data?.[0] ?? null;
}

export default async function CandyMlbPage() {
  const [rows, packEv, packMarket, deals, spreads, serials, scarcity, holders, players, parallel] = await Promise.all([
    fetchView("candy_secondary_board", MARKET_COLS, "fmv_usd"),
    fetchPackEv(),
    fetchPackMarket(),
    fetchView(
      "candy_deals_board",
      "pda_address,external_id,player_name,edition_name,tier,is_rainbow,circulation_count,serial_number,ask_usd,fmv_usd,discount_pct,discount_vs_median_pct,median_sale_usd,sales_count,seller",
      "discount_pct"
    ),
    fetchView(
      "candy_offer_spread_board",
      "external_id,player_name,edition_name,tier,is_rainbow,circulation_count,floor_usd,listing_count,best_offer_usd,distinct_bidders,fmv_usd,spread_usd,spread_pct",
      "best_offer_usd"
    ),
    fetchView(
      "candy_special_serials_board",
      "external_id,player_name,edition_name,tier,is_rainbow,circulation_count,serial_number,kind,owner,is_treasury,fmv_usd,last_sale_usd,last_sale_at",
      "fmv_usd"
    ),
    fetchView(
      "candy_scarcity_board",
      "external_id,player_name,edition_name,tier,is_rainbow,circulation_count,sealed,circulating,circulating_pct,holders,fmv_usd",
      "circulating_pct",
      true // most-squeezed (lowest circulating %) first
    ),
    fetchView("candy_holder_board", "wallet_address,serials,editions,est_fmv_usd,priced_serials", "serials"),
    fetchView(
      "candy_player_board",
      "player_name,team_name,editions,rainbow_editions,total_supply,priced,avg_fmv,top_fmv,sales_all",
      "top_fmv"
    ),
    fetchView("candy_parallel_premium", "parallel_group,is_rainbow,editions,priced,avg_fmv,min_fmv,max_fmv,total_supply", "is_rainbow", true, 5),
  ]);

  return (
    <CandyBoardClient
      initialRows={rows}
      packEv={packEv}
      packMarket={packMarket}
      deals={deals}
      spreads={spreads}
      serials={serials}
      scarcity={scarcity}
      holders={holders}
      players={players}
      parallel={parallel}
      fetchedAt={new Date().toISOString()}
    />
  );
}
