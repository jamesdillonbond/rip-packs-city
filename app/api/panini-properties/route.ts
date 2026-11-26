// app/api/panini-properties/route.ts
//
// The league / brand scope index for the Panini tabs (2026-11-26): every publisher_properties row for Panini
// that has at least one product id, and the product id → slug map (panini_products.property_slug, migration
// 20261126185023). GET-only, no session, catalogue data only — public like its sibling Panini tab backends.
// A failed read is a 503 through apiErrorResponse, never an empty index (an empty index would silently
// remove the scope control and un-filter a scoped tab).

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"

export const dynamic = "force-dynamic"

const ROW_CLAMP = 1000
const FAIL = "Leagues and brands are unavailable right now."
const TAG = "api/panini-properties"

export async function GET() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any
    const [props, products] = await Promise.all([
      boundedRead(
        db.from("publisher_properties").select("slug,name,heading,sort_order").eq("publisher", "panini").order("sort_order", { ascending: true }).order("slug", { ascending: true }).range(0, ROW_CLAMP - 1),
        `${TAG}/properties`,
      ),
      boundedRead(
        db.from("panini_products").select("set_id,property_slug").not("property_slug", "is", null).order("set_id", { ascending: true }).range(0, ROW_CLAMP - 1),
        `${TAG}/products`,
      ),
    ])
    if (props.error) return apiErrorResponse(props.error, TAG, FAIL)
    if (products.error) return apiErrorResponse(products.error, TAG, FAIL)
    if (!Array.isArray(props.data) || !Array.isArray(products.data) || products.data.length >= ROW_CLAMP || props.data.length >= ROW_CLAMP) {
      return apiErrorResponse(new Error("a non-array or clamped read"), TAG, FAIL)
    }
    const setProperty: Record<string, string> = {}
    const used = new Set<string>()
    for (const r of products.data as Array<{ set_id?: unknown; property_slug?: unknown }>) {
      const id = Number(r.set_id)
      if (!Number.isSafeInteger(id) || typeof r.property_slug !== "string" || !r.property_slug) continue
      setProperty[String(id)] = r.property_slug
      used.add(r.property_slug)
    }
    const properties = (props.data as Array<{ slug?: unknown; name?: unknown; heading?: unknown; sort_order?: unknown }>)
      .filter((p) => typeof p.slug === "string" && typeof p.name === "string" && used.has(p.slug as string))
      .map((p) => ({ slug: p.slug as string, name: p.name as string, heading: p.heading === "entertainment" ? "entertainment" : "leagues", sort_order: Number(p.sort_order) }))
    return NextResponse.json({ properties, setProperty }, { headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=3600" } })
  } catch (e) {
    return apiErrorResponse(e, TAG, FAIL)
  }
}
