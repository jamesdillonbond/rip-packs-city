// app/api/candy-pack-market/route.ts
//
// Candy MLB Packs tab backend (2026-09-25). Candy sells ONE sealed pack product
// (2026 MLB Base Series ICONs, $10 retail, 2,500 declared) as a Metaplex Core
// asset that trades on Magic Eden. None of it lives in `pack_distributions`, so
// the shared Flow pack board (/api/packs → pack_table_rows) has nothing to read;
// this route reads Candy's native pack plane instead: `candy_pack_market` (supply
// + market + EV rollup), `candy_pack_ev_model`, `candy_pack_listings`,
// `candy_pack_sales`, `candy_packs`.
//
// ── HONESTY ────────────────────────────────────────────────────────────────
//   · The market rollup is the page's primary read: if it fails the route answers
//     503 through `apiErrorResponse`, never a zeroed board.
//   · Every SECONDARY panel (asks, sales, the wallet's packs) carries its own
//     `*_error` flag, so "no asks" and "the asks read failed" are different
//     payloads (three states: failed · empty · rows).
//   · THE FLOOR IS SPLIT BY CONFIRMATION. `candy_pack_market.floor_ask_usd` is the
//     min over every `is_active` row, and the indexer deliberately never retires
//     an ask on absence (a short Magic Eden answer once wiped 419 live asks). So an
//     ask can sit "active" long after it stopped being seen — measured
//     2026-09-25, the floor was a listing last seen 2026-07-30 whose token had
//     since sold. That class is now retired on sale evidence (migration
//     20260926020528), but an ask with no sale evidence can still be stale. This
//     route therefore reports the floor over asks CONFIRMED within
//     CANDY_PACK_ASK_CONFIRMED_HOURS separately from the unconfirmed count, and
//     never lets an unconfirmed ask be the headline.
//   · A wallet is read only if it is a Solana address, verbatim (base58 is
//     case-sensitive); anything else is refused for that panel, not zeroed.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { isSolanaAddress } from "@/lib/address"

export const dynamic = "force-dynamic"
export const maxDuration = 30

/**
 * How recently an ask must have been seen by the indexer to count as confirmed.
 * ⚠ DERIVED FROM THE WRITER: /api/candy-listings-indexer runs `35 *\/3 * * *`
 * (vercel.json), so a live ask is re-seen every 3 h; 12 h is four missed sweeps.
 */
export const CANDY_PACK_ASK_CONFIRMED_HOURS = 12

const MAX_ASKS = 50
const MAX_SALES = 20
const MAX_OWNED_SERIALS = 100

interface AskRow {
  token_mint: string
  price_usd: number | string | null
  price_sol: number | string | null
  last_seen_at: string | null
  expiry: string | null
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export async function GET(req: NextRequest) {
  const rawWallet = req.nextUrl.searchParams.get("wallet")?.trim() ?? ""

  try {
    const [marketRes, evRes, asksRes, salesRes, imageRes] = await Promise.all([
      boundedRead((supabaseAdmin as any).from("candy_pack_market").select("*").limit(1), "candy-pack-market/market"),
      boundedRead(
        (supabaseAdmin as any)
          .from("candy_pack_ev_model")
          .select("icon_slots, rainbow_chance, pack_cost_usd, typical_pull_ev_usd, actual_ev_usd, rainbow_priced, rainbow_total, common_priced, common_total, model_note")
          .limit(1),
        "candy-pack-market/ev",
      ),
      boundedRead(
        (supabaseAdmin as any)
          .from("candy_pack_listings")
          .select("token_mint, price_usd, price_sol, last_seen_at, expiry")
          .eq("is_active", true)
          .order("price_usd", { ascending: true })
          .order("pda_address", { ascending: true })
          // Active pack asks measured 23 after the 2026-09-25 repair; the cap is
          // well above that and the count below says if it is ever hit.
          .limit(500),
        "candy-pack-market/asks",
      ),
      boundedRead(
        (supabaseAdmin as any)
          .from("candy_pack_sales")
          .select("serial_number, price_usd, price_sol, marketplace, sold_at")
          .order("sold_at", { ascending: false })
          .order("transaction_hash", { ascending: true })
          .limit(MAX_SALES),
        "candy-pack-market/sales",
      ),
      boundedRead(
        (supabaseAdmin as any).from("candy_packs").select("name, image_url").not("image_url", "is", null).limit(1),
        "candy-pack-market/image",
      ),
    ])

    if (marketRes.error) throw marketRes.error
    const m = (marketRes.data ?? [])[0] as Record<string, unknown> | undefined
    if (!m) {
      // The rollup always returns one row (it is an aggregate). No row means the
      // read did not answer, not that Candy has no packs.
      throw Object.assign(new Error("candy_pack_market returned no row"), { code: "57014" })
    }

    const ev = evRes.error ? null : ((evRes.data ?? [])[0] as Record<string, unknown> | undefined) ?? null
    if (evRes.error) console.error("[candy-pack-market] ev read failed:", evRes.error)

    // ── Asks, split by confirmation ──────────────────────────────────────────
    const now = Date.now()
    const cutoff = now - CANDY_PACK_ASK_CONFIRMED_HOURS * 3_600_000
    let asks: {
      priceUsd: number | null
      priceSol: number | null
      lastSeenAt: string | null
      confirmed: boolean
    }[] = []
    let confirmedFloorUsd: number | null = null
    let confirmedFloorSol: number | null = null
    let confirmedCount = 0
    let unconfirmedCount = 0
    if (!asksRes.error) {
      const rows = ((asksRes.data ?? []) as AskRow[]).filter(
        (r) => !r.expiry || Date.parse(r.expiry) > now,
      )
      for (const r of rows) {
        const seen = r.last_seen_at ? Date.parse(r.last_seen_at) : NaN
        const confirmed = !Number.isNaN(seen) && seen >= cutoff
        const usd = num(r.price_usd)
        const sol = num(r.price_sol)
        if (confirmed) {
          confirmedCount++
          if (usd !== null && (confirmedFloorUsd === null || usd < confirmedFloorUsd)) {
            confirmedFloorUsd = usd
            confirmedFloorSol = sol
          }
        } else {
          unconfirmedCount++
        }
        asks.push({ priceUsd: usd, priceSol: sol, lastSeenAt: r.last_seen_at, confirmed })
      }
      // Confirmed first (cheapest first within each group) — an unconfirmed ask
      // must never be the top row a reader takes as "the price".
      asks = [...asks.filter((a) => a.confirmed), ...asks.filter((a) => !a.confirmed)].slice(0, MAX_ASKS)
    } else {
      console.error("[candy-pack-market] asks read failed:", asksRes.error)
    }

    const sales = salesRes.error
      ? null
      : ((salesRes.data ?? []) as Record<string, unknown>[]).map((s) => ({
          serial: num(s.serial_number),
          priceUsd: num(s.price_usd),
          priceSol: num(s.price_sol),
          marketplace: typeof s.marketplace === "string" ? s.marketplace : null,
          soldAt: typeof s.sold_at === "string" ? s.sold_at : null,
        }))
    if (salesRes.error) console.error("[candy-pack-market] sales read failed:", salesRes.error)

    const image = imageRes.error ? null : ((imageRes.data ?? [])[0] as { image_url?: string } | undefined)?.image_url ?? null

    // ── The wallet's sealed packs ───────────────────────────────────────────
    let owned: { wallet: string; count: number; serials: number[] } | null = null
    let ownedError: string | null = null
    if (rawWallet) {
      if (!isSolanaAddress(rawWallet)) {
        ownedError = "Candy MLB lives on Solana — enter a Solana wallet address."
      } else {
        const { data, error, count } = await boundedRead(
          (supabaseAdmin as any)
            .from("candy_packs")
            .select("serial_number", { count: "exact" })
            .eq("owner", rawWallet)
            .eq("is_burnt", false)
            .order("serial_number", { ascending: true })
            .limit(MAX_OWNED_SERIALS),
          "candy-pack-market/owned",
        )
        if (error || count === null || count === undefined) {
          console.error("[candy-pack-market] owned read failed:", error)
          ownedError = "Could not read this wallet's packs right now."
        } else {
          owned = {
            wallet: rawWallet,
            count,
            serials: ((data ?? []) as { serial_number: number | null }[])
              .map((r) => r.serial_number)
              .filter((n): n is number => typeof n === "number"),
          }
        }
      }
    }

    return NextResponse.json(
      {
        product: {
          name: "2026 MLB Base Series ICONs",
          imageUrl: image,
          retailUsd: num(m.retail_usd),
          declaredSupply: num(m.declared_supply),
        },
        supply: {
          indexed: num(m.pack_assets_indexed),
          duplicateSerials: num(m.duplicate_serials),
          treasuryHeld: num(m.treasury_held),
          collectorHeld: num(m.collector_held),
          collectorWallets: num(m.collector_wallets),
          burnt: num(m.burnt_assets),
          refreshedAt: typeof m.inventory_refreshed_at === "string" ? m.inventory_refreshed_at : null,
        },
        market: {
          confirmedFloorUsd,
          confirmedFloorSol,
          confirmedAsks: asksRes.error ? null : confirmedCount,
          unconfirmedAsks: asksRes.error ? null : unconfirmedCount,
          confirmedWithinHours: CANDY_PACK_ASK_CONFIRMED_HOURS,
          salesAll: num(m.sales_all),
          sales7d: num(m.sales_7d),
          median7dUsd: num(m.median_7d_usd),
          lastSaleAt: typeof m.last_sale_at === "string" ? m.last_sale_at : null,
          lastSaleUsd: num(m.last_sale_usd),
        },
        ev: ev
          ? {
              iconSlots: num(ev.icon_slots),
              rainbowChance: num(ev.rainbow_chance),
              packCostUsd: num(ev.pack_cost_usd),
              typicalPullUsd: num(ev.typical_pull_ev_usd),
              actualEvUsd: num(ev.actual_ev_usd),
              rainbowPriced: num(ev.rainbow_priced),
              rainbowTotal: num(ev.rainbow_total),
              commonPriced: num(ev.common_priced),
              commonTotal: num(ev.common_total),
              note: typeof ev.model_note === "string" ? ev.model_note : null,
            }
          : null,
        ev_error: evRes.error ? true : false,
        asks: asksRes.error ? null : asks,
        asks_error: asksRes.error ? true : false,
        sales,
        sales_error: salesRes.error ? true : false,
        owned,
        owned_error: ownedError,
        generatedAt: new Date(now).toISOString(),
      },
      { headers: { "Cache-Control": rawWallet ? "private, no-store" : "public, s-maxage=120, stale-while-revalidate=300" } },
    )
  } catch (err) {
    return apiErrorResponse(err, "api/candy-pack-market", "Pack market is unavailable right now.")
  }
}
