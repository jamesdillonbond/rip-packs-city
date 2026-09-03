// OG share card for /insights/panini-squeeze. Queries the view directly via supabaseAdmin rather than
// self-fetching the public JSON, so the card renders identically whether the surface is gated or public
// (a server-side fetch to its own origin would go back through proxy.ts and 302 to /login while
// PANINI_PUBLIC is false). Same deviation, same reason, as /api/og/insights/candy-mlb.
//
// Wired into the page's metadata 2026-08-01 — until then this route existed but nothing referenced it,
// so every share of the LIVE board fell back to the generic site-default "Public Insights" card.
import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { brandFonts, brandFamilies, OG_CACHE_HEADERS } from "@/lib/og/brand-fonts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RED = "#E03A2F";
const BG = "#0D0D0D";
const INK = "#ECEAE3";
const MUTED = "#9A968C";
const usd = (x: any) =>
  x == null || isNaN(Number(x)) ? "—" : "$" + Number(x).toLocaleString("en-US", { maximumFractionDigits: 0 });

export async function GET(_req: NextRequest) {
  // Brand typography + a long shared cache. `brandFonts` never rejects and
  // validates the bytes before satori sees them, so this cannot break the card.
  const fonts = await brandFonts();
  const fam = brandFamilies(fonts);

  let rows: any[] = [];
  let sealed = 0;
  let editions = 0;
  // 🚨 THE SUM MUST BE PAGED, AND THE COUNT NEXT TO IT IS WHY.
  //
  // This used to read `.select("sealed_fmv_exposure_usd", { count: "exact" })`
  // with no bound and sum the returned rows in JS. PostgREST caps an unbounded
  // `.select()` at 1,000 rows and returns no error, while `count: "exact"` is a
  // real COUNT(*) over the whole view — so the card paired an EXACT edition count
  // with a sum over the first 1,000 rows in PHYSICAL order.
  //
  // Measured live 2026-09-03: the view holds 4,813 rows totalling $2,358,840,
  // and the card was publishing **$143,849 — 16.4x low — beside "4,813 editions"**.
  // ⛔ The pairing is what makes it worse than either half: an exact count sitting
  // next to a truncated sum reads as one coherent measurement, and this is a
  // SOCIAL CARD, so the number travels without the page around it.
  //
  // ⚠ `complete` is not decoration. supabase-js RETURNS errors rather than
  // throwing, so the `catch` below cannot see a failed page — a partial sum would
  // otherwise render as a real total, which is the same defect one order smaller.
  // A sum we could not finish is withheld: `editions` stays 0 and the card falls
  // back to its tagline, exactly as it does for a failed read.
  const AGG_PAGE = 1000;
  try {
    const top = await (supabaseAdmin as any)
      .from("panini_squeeze_board")
      .select("player_name,set_name,mint_cap,still_in_packs,fmv_usd")
      .not("fmv_usd", "is", null)
      .order("fmv_usd", { ascending: false })
      .limit(3);
    rows = top.data ?? [];

    let total = 0;
    let seen = 0;
    let complete = false;
    let expected: number | null = null;
    for (let page = 0; page < 25; page++) {
      // ⚠ A `.range()` needs a deterministic order on a UNIQUE key or the pages
      // overlap and omit in equal measure — the duplicates and omissions cancel,
      // so every count-based check still passes while the SUM is wrong. `id` is
      // the view's key.
      const { data, count, error } = await (supabaseAdmin as any)
        .from("panini_squeeze_board")
        .select("sealed_fmv_exposure_usd", { count: page === 0 ? "exact" : undefined })
        .order("id", { ascending: true })
        .range(page * AGG_PAGE, page * AGG_PAGE + AGG_PAGE - 1);
      if (error) break;
      if (page === 0 && typeof count === "number") expected = count;
      const batch = (data ?? []) as Array<{ sealed_fmv_exposure_usd: number | null }>;
      for (const r of batch) total += Number(r.sealed_fmv_exposure_usd) || 0;
      seen += batch.length;
      if (batch.length < AGG_PAGE) { complete = true; break; }
    }
    // Only publish when the walk covered the population the count reports.
    if (complete && expected != null && seen === expected) {
      editions = expected;
      sealed = total;
    }
  } catch {
    /* fall through to a generic card */
  }

  return new ImageResponse(
    (
      <div style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column", background: BG, padding: "56px 64px", fontFamily: fam.display }}>
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
    { width: 1200, height: 630, ...(fonts ? { fonts } : {}), headers: OG_CACHE_HEADERS }
  );
}
