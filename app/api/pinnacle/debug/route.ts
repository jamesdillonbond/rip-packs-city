import { NextResponse } from "next/server"

export async function POST() {
  const res = await fetch("https://api2.flowty.io/collection/0xedf9df96c92f4595/Pinnacle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ includeAllListings: true, limit: 1, offset: 0 }),
    cache: "no-store",
  })
  const data = await res.json()
  return NextResponse.json(data)
}
