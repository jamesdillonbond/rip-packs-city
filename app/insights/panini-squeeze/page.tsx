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

export default async function PaniniSqueezePage() {
  const rows = await fetchRows();
  return <PaniniSqueezeClient initialRows={rows} fetchedAt={new Date().toISOString()} />;
}
