// app/api/og/product/route.tsx
// Branded per-product OG card for Panini product pages (2026-10-26) — the counterpart of
// /api/og/series (Top Shot series pages carry one; Panini product pages fell back to the
// site default). GET /api/og/product?slug=<product slug>
//
// Honesty: a failed read is `readFailed` (short cache, no claim about the product); an unknown
// slug is a plain branded card, never "0 editions". The stat is the 30-day sales volume RPC has
// on record — a floor, labelled as such — never an FMV confidence.
import { NextRequest } from "next/server"
import { getCollection } from "@/lib/collections"
import { renderEntityOg } from "@/lib/og/entity-card"
import { readPaniniProduct } from "@/lib/panini/product"
import { paniniAssetUrl } from "@/lib/panini/assets"
import { paniniSportLabel } from "@/lib/panini/sport-label"
import { usdSignFirst } from "@/lib/usd-format"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function fmtUsd(n: number | null | undefined): string {
  const neg = usdSignFirst(n, fmtUsd); if (neg !== null) return neg
  if (n == null || !Number.isFinite(n)) return ""
  if (Math.abs(n) >= 1000) return "$" + Math.round(n).toLocaleString("en-US")
  return "$" + n.toFixed(2)
}

export async function GET(req: NextRequest) {
  const slug = (req.nextUrl.searchParams.get("slug") || "").trim()
  const accent = getCollection("panini-blockchain")?.accent ?? null
  if (!slug) return renderEntityOg({ eyebrow: "RIP PACKS CITY", title: "Panini", images: [], accent })

  let readFailed = false
  let product: Awaited<ReturnType<typeof readPaniniProduct>>["product"] = null
  try {
    const res = await readPaniniProduct(slug)
    if (!res.ok) readFailed = true
    product = res.product
  } catch {
    readFailed = true
  }
  if (!product) return renderEntityOg({ eyebrow: "PANINI · PRODUCT", title: "Panini product", images: [], accent, readFailed })

  const images = product.top_editions
    .map((e) => paniniAssetUrl(e.thumbnail_url))
    .filter((u): u is string => typeof u === "string")
    .slice(0, 4)
  const sport = product.sport ? paniniSportLabel(product.sport) : null
  const subtitle = [sport, `${product.editions.toLocaleString("en-US")} ${product.editions === 1 ? "edition" : "editions"} seen`].filter(Boolean).join(" · ")
  const vol = product.sales_30d_volume_usd
  return renderEntityOg({
    eyebrow: "PANINI · PRODUCT",
    title: product.name,
    subtitle,
    accent,
    images,
    statLabel: vol && vol > 0 ? "30-day sales on record" : null,
    statValue: vol && vol > 0 ? fmtUsd(vol) : null,
  })
}
