import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

const FLOW_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export async function GET(req: NextRequest) {
  const flowId = req.nextUrl.searchParams.get("flowId");
  const widthParam = req.nextUrl.searchParams.get("width");
  const pathParam = req.nextUrl.searchParams.get("path"); // optional: e.g. "image"
  if (!flowId || !FLOW_ID.test(flowId)) {
    return NextResponse.json({ error: "invalid flowId" }, { status: 400 });
  }
  let width = 180;
  if (widthParam) {
    const parsed = parseInt(widthParam, 10);
    if (Number.isFinite(parsed) && parsed >= 32 && parsed <= 2048) width = parsed;
  }
  const suffix = pathParam === "image" || pathParam == null ? "/image" : "";
  const upstream = `https://assets.nbatopshot.com/media/${flowId}${suffix}?width=${width}`;
  try {
    const r = await fetch(upstream, {
      headers: { Accept: "image/*" },
      cache: "no-store",
    });
    if (!r.ok) {
      return NextResponse.json({ error: "not found" }, { status: r.status });
    }
    const body = await r.arrayBuffer();
    const contentType = r.headers.get("content-type") || "image/jpeg";
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  } catch {
    return NextResponse.json({ error: "fetch failed" }, { status: 502 });
  }
}
