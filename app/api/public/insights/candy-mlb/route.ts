// Public JSON backing the /insights/candy-mlb page. Its public/gated state is owned by `CANDY_MLB_PUBLIC`
// in lib/launch-flags.ts, read by the single `/(?:...)\/candy` line in proxy.ts (flag false -> returns
// false -> auth gate). ⚠ DO NOT restate that state here — this header still said "STAGED: gated pre-launch"
// three weeks after the 2026-07-31 go-live. Note the line below is still true and is a DIFFERENT switch:
// `candy_mlb.is_active` stays false and governs anon PostgREST reads, never this surface's visibility.
// Candy = 2026 MLB Base Series ICONs (chain two, Solana / Magic Eden). Reads Candy DIRECTLY — candy_mlb
// stays is_active=false, so this needs neither the is_active flip nor the 28-shared-RPC candy-arm fix.
// HONESTY: best_offer_usd is an OFFER-derived signal, a SEPARATE column, NEVER FMV; the pack-EV block
// leads with typical_pull_ev; meta.coverage states the board is thin (46/125 priced) so a consumer can't
// render it as a census.
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { boardUnavailable } from "@/lib/insights/board-error";
import { boundedRead } from "@/lib/api/bounded-read";

import { boardRowMeta } from "@/lib/insights/board-meta"
const COLS =
  // `confidence` is deliberately NOT selected. FMV confidence tiers are a
  // build-time signal that must never reach a user surface (site-wide policy,
  // 2026-07-11) — the board already refuses to render the pill, so shipping the
  // field on a PUBLIC contract only invites a consumer to render what we won't.
  "external_id,player_name,edition_name,tier,is_rainbow,circulation_count,fmv_usd,fmv_computed_at," +
  "sales_24h,sales_7d,sales_all,last_sale_at,last_sale_usd,last_sale_serial,median_sale_usd,best_offer_usd,offer_bidders";

const VALID_TIERS = new Set(["COMMON", "LEGENDARY"]);
const VALID_SORTS: Record<string, string> = {
  fmv: "fmv_usd",
  sales: "sales_all",
  offer: "best_offer_usd",
  circ: "circulation_count",
};

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const sp = new URL(req.url).searchParams;
  const tier = sp.get("tier")?.toUpperCase() || null;
  const player = sp.get("player");
  const rainbow = sp.get("rainbow") === "1";
  const sortKey = VALID_SORTS[sp.get("sort") || "fmv"] || "fmv_usd";
  const limit = Math.max(1, Math.min(300, Number(sp.get("limit")) || 150));

  if (tier && !VALID_TIERS.has(tier)) {
    return NextResponse.json({ error: `invalid tier '${tier}'` }, { status: 400 });
  }

  // Fetch the WHOLE board (125 rows, well under the PostgREST 1000 cap) so client-side filters stay
  // complete. Do NOT filter out null-FMV rows here — the cold tail (no-sale editions) is part of the
  // honest picture and renders as "—" FMV, optionally with a best-offer floor.
  let q = (supabase as any).from("candy_secondary_board").select(COLS);
  if (tier) q = q.eq("tier", tier);
  if (player) q = q.ilike("player_name", `%${player}%`);
  if (rainbow) q = q.eq("is_rainbow", true);
  q = q.order(sortKey, { ascending: false, nullsFirst: false }).limit(limit);

  const { data, error } = await boundedRead(q, "api/public/insights/candy-mlb/candy_secondary_board");
  if (error) {
    return boardUnavailable(error, "insights/candy-mlb");
  }
  // fmv_usd is stored numeric(12,4) → PostgREST serializes it with 4 decimals ($3.2500). Round to 2 for
  // display parity with every other USD figure on the board (Item 4 cosmetic, 2026-07-24).
  const rows = (data ?? []).map((r: any) =>
    r.fmv_usd == null ? r : { ...r, fmv_usd: Math.round(Number(r.fmv_usd) * 100) / 100 }
  );

  // Pack-EV model — single row. Fail-soft: the board is the primary payload, so an EV error omits the
  // block rather than 500-ing. The board must LEAD with typical_pull_ev (Actual EV is chase-inclusive
  // and inflated by a 2/25-priced Rainbow leg on an ultra-thin market).
  let packEv: Record<string, unknown> | null = null;
  const { data: ev, error: evErr } = await boundedRead((supabase as any)
    .from("candy_pack_ev_model")
    .select(
      "icon_slots,rainbow_chance,pack_cost_usd,common_slot_ev,common_slot_typical,rainbow_ev," +
        "common_total,common_priced,rainbow_total,rainbow_priced,actual_ev_usd,typical_pull_ev_usd,model_note"
    )
    .limit(1), "api/public/insights/candy-mlb/candy_pack_ev_model");
  if (evErr) console.error("[candy-mlb api] pack-ev:", evErr.message);
  else if (ev?.[0]) packEv = ev[0];

  // Coverage disclosure carried IN the contract so a consumer cannot render a thin board as a census.
  const priced = rows.filter((r: any) => r.fmv_usd != null).length;
  const withOffer = rows.filter((r: any) => r.best_offer_usd != null).length;
  const rainbowPriced = rows.filter((r: any) => r.is_rainbow && r.fmv_usd != null).length;
  const rainbowTotal = rows.filter((r: any) => r.is_rainbow).length;
  // Measured, not asserted. The previous copy hardcoded "every price is
  // LOW-confidence off only 1–2 sales"; by 2026-07-27 that was false on both
  // counts (24 of 109 priced editions had reached MEDIUM, and 43 of the LOW
  // ones had 3+ sales). A number computed from the payload cannot go stale.
  const salesCounts = rows
    .filter((r: any) => r.fmv_usd != null)
    .map((r: any) => Number(r.sales_all ?? 0))
    .sort((a: number, b: number) => a - b);
  const medianSales = salesCounts.length
    ? salesCounts[Math.floor((salesCounts.length - 1) / 2)]
    : 0;

  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "candy_secondary_board",
      set: "2026 MLB Base Series ICONs · Candy Digital (Solana)",
      ...boardRowMeta(rows.length, limit),
      elapsed_ms: Date.now() - t0,
      coverage: {
        total_editions: rows.length,
        priced_editions: priced,
        editions_with_best_offer: withOffer,
        rainbow_priced: rainbowPriced,
        rainbow_total: rainbowTotal,
        basis: "thin_secondary",
        median_sales_per_priced_edition: medianSales,
        note:
          "Candy's secondary market opened ~2026-07-23 (Magic Eden). FMV is auto-computed by the standard " +
          `pipeline off live sales: ${priced} of ${rows.length} editions carry one, off a median of ` +
          `${medianSales} sale${medianSales === 1 ? "" : "s"} each — the cold tail (no-sale editions) shows ` +
          "FMV '—'. best_offer_usd is an OFFER-derived floor, NEVER FMV. Treat this board as an early read " +
          "on a thin market, not a census.",
      },
      pack_ev: packEv,
      filters: { tier, player, rainbow, sort: sortKey, limit },
    },
    rows,
  });
  res.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
  return res;
}
