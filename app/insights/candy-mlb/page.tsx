// Candy MLB ICONs — public insights surface (STAGED, gated pre-launch).
// Gated in proxy.ts (isPublicPath returns false for /insights/candy*) + noindex in layout, and NOT in the
// sitemap or the /insights hub, until the chain-two public launch. Go-live = remove the proxy line, add the
// sitemap slug + hub card + OG, drop the layout robots:noindex. Reads Candy DIRECTLY (candy_mlb stays
// is_active=false — no shared-plane flip needed).
import { supabaseAdmin } from "@/lib/supabase";
import CandyBoardClient from "./CandyBoardClient";

export const revalidate = 300;

const COLS =
  "external_id,player_name,edition_name,tier,is_rainbow,circulation_count,fmv_usd,confidence,fmv_computed_at," +
  "sales_24h,sales_7d,sales_all,last_sale_at,last_sale_usd,best_offer_usd,offer_bidders";

// 125 rows total — one fetch, well under the PostgREST 1000 cap. Keep the null-FMV cold tail in the
// payload (client renders "—" FMV) so the board is honest about coverage.
async function fetchRows() {
  const { data, error } = await (supabaseAdmin as any)
    .from("candy_secondary_board")
    .select(COLS)
    .order("fmv_usd", { ascending: false, nullsFirst: false })
    .limit(300);
  if (error) {
    console.error("[candy-mlb] backing view error:", error.message);
    return [];
  }
  return data ?? [];
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
  const [rows, packEv] = await Promise.all([fetchRows(), fetchPackEv()]);
  return <CandyBoardClient initialRows={rows} packEv={packEv} fetchedAt={new Date().toISOString()} />;
}
