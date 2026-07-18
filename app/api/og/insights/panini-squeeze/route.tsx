// OG share card for /insights/panini-squeeze. Queries the view directly (works gated or public).
// STAGED with the page; gated pre-launch by the single panini line in proxy.ts.
import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RED = "#E03A2F";
const BG = "#0D0D0D";
const INK = "#ECEAE3";
const MUTED = "#9A968C";
const usd = (x: any) =>
  x == null || isNaN(Number(x)) ? "—" : "$" + Number(x).toLocaleString("en-US", { maximumFractionDigits: 0 });

export async function GET(_req: NextRequest) {
  let rows: any[] = [];
  let sealed = 0;
  let editions = 0;
  try {
    const top = await (supabaseAdmin as any)
      .from("panini_squeeze_board")
      .select("player_name,set_name,mint_cap,still_in_packs,fmv_usd")
      .not("fmv_usd", "is", null)
      .order("fmv_usd", { ascending: false })
      .limit(3);
    rows = top.data ?? [];
    const agg = await (supabaseAdmin as any)
      .from("panini_squeeze_board")
      .select("sealed_fmv_exposure_usd", { count: "exact" });
    editions = agg.count ?? 0;
    sealed = (agg.data ?? []).reduce((s: number, r: any) => s + (Number(r.sealed_fmv_exposure_usd) || 0), 0);
  } catch {
    /* fall through to a generic card */
  }

  return new ImageResponse(
    (
      <div style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column", background: BG, padding: "56px 64px", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", color: MUTED, fontSize: 22, letterSpacing: 2, textTransform: "uppercase", fontWeight: 700 }}>
          Rip Packs City · Insights
        </div>
        <div style={{ display: "flex", color: INK, fontSize: 62, fontWeight: 800, marginTop: 8, lineHeight: 1.05 }}>
          Panini WC Prizm Squeeze
        </div>
        <div style={{ display: "flex", color: MUTED, fontSize: 26, marginTop: 12 }}>
          {editions ? `${editions.toLocaleString("en-US")} editions · ${usd(sealed)} still sealed in packs` : "2026 Prizm World Cup Soccer — still-in-packs supply + FMV"}
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 34, gap: 12 }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", fontSize: 28 }}>
              <div style={{ display: "flex", width: 46, color: RED, fontWeight: 800 }}>{i + 1}</div>
              <div style={{ display: "flex", color: INK, fontWeight: 700, width: 340 }}>{r.player_name || "—"}</div>
              <div style={{ display: "flex", color: MUTED, width: 300 }}>{r.set_name || ""} /{r.mint_cap}</div>
              <div style={{ display: "flex", color: MUTED, width: 150 }}>{r.still_in_packs} in packs</div>
              <div style={{ display: "flex", color: INK, fontWeight: 800 }}>{usd(r.fmv_usd)}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", marginTop: "auto", color: MUTED, fontSize: 22 }}>
          rippackscity.com/insights/panini-squeeze
        </div>
        <div style={{ display: "flex", position: "absolute", bottom: 0, left: 0, height: 8, width: "100%", background: RED }} />
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
