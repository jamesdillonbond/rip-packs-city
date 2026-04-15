import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

const ALLOWED = /^[a-zA-Z0-9_-]{1,64}$/;

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  if (!name || !ALLOWED.test(name)) {
    return NextResponse.json({ error: "invalid name" }, { status: 400 });
  }
  const upstream = `https://nbatopshot.com/img/momentTags/static/${name}.svg`;
  try {
    const r = await fetch(upstream, {
      headers: { Accept: "image/svg+xml,image/*" },
      cache: "no-store",
    });
    if (!r.ok) {
      return NextResponse.json({ error: "not found" }, { status: r.status });
    }
    const body = await r.arrayBuffer();
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
      },
    });
  } catch {
    return NextResponse.json({ error: "fetch failed" }, { status: 502 });
  }
}
