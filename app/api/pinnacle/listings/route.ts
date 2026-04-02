import { NextRequest, NextResponse } from "next/server"
import { supabase } from "@/lib/supabase"
import { z } from "zod"

const querySchema = z.object({
  variant: z.string().optional(),
  editionType: z.string().optional(),
  studio: z.string().optional(),
  isChaser: z.enum(["true", "false"]).optional(),
  isLocked: z.enum(["true", "false"]).optional(),
  sortBy: z
    .enum(["price_asc", "price_desc", "serial_asc"])
    .optional()
    .default("price_asc"),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
})

export async function GET(req: NextRequest) {
  const params = Object.fromEntries(req.nextUrl.searchParams.entries())
  const parsed = querySchema.safeParse(params)

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const {
    variant,
    editionType,
    studio,
    isChaser,
    sortBy,
    limit,
    offset,
  } = parsed.data

  // Build query on pinnacle_editions
  let query = supabase
    .from("pinnacle_editions")
    .select("*")

  // Apply filters
  if (variant) {
    const variants = variant.split(",")
    query = query.in("variant", variants)
  }
  if (editionType) {
    const types = editionType.split(",")
    query = query.in("edition_type", types)
  }
  if (studio) {
    const studios = studio.split(",")
    query = query.in("studios", studios)
  }
  if (isChaser === "true") {
    query = query.eq("is_chaser", true)
  }

  // Sort
  switch (sortBy) {
    case "price_asc":
      query = query.order("floor_price_usd", {
        ascending: true,
        nullsFirst: false,
      })
      break
    case "price_desc":
      query = query.order("floor_price_usd", {
        ascending: false,
        nullsFirst: false,
      })
      break
    case "serial_asc":
      query = query.order("created_at", { ascending: true })
      break
  }

  // Pagination
  query = query.range(offset, offset + limit - 1)

  const { data, error, count } = await query

  if (error) {
    return NextResponse.json(
      { error: "Database query failed", details: error.message },
      { status: 500 }
    )
  }

  return NextResponse.json({
    listings: data ?? [],
    total: count,
    limit,
    offset,
  })
}
