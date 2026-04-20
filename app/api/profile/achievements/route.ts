import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

const supabase = supabaseAdmin as any;

export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey");
  if (!ownerKey) {
    return NextResponse.json({ error: "ownerKey required" }, { status: 400 });
  }
  try {
    const { data, error } = await supabase
      .from("profile_achievements")
      .select("achievement_key, tier, progress, unlocked_at")
      .eq("owner_key", ownerKey)
      .order("unlocked_at", { ascending: true });
    if (error) {
      console.error("[achievements GET]", error.message);
      return NextResponse.json({ achievements: [] });
    }
    return NextResponse.json({ achievements: data ?? [] });
  } catch (err: any) {
    console.error("[achievements GET]", err?.message);
    return NextResponse.json({ achievements: [] });
  }
}

export async function POST(req: NextRequest) {
  const token = process.env.INGEST_SECRET_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "Server misconfigured: INGEST_SECRET_TOKEN not set" },
      { status: 500 }
    );
  }
  try {
    const body = await req.json().catch(() => ({}));
    const ownerKey: string | undefined = body?.ownerKey;
    if (!ownerKey) {
      return NextResponse.json({ triggered: false, error: "ownerKey required" }, { status: 400 });
    }
    const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
    const r = await fetch(`${url}/functions/v1/compute-achievements`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ owner_key: ownerKey }),
    });
    const result = await r.json().catch(() => ({}));
    if (!r.ok) {
      return NextResponse.json({ triggered: false, error: result?.error ?? `status ${r.status}` });
    }
    return NextResponse.json({ triggered: true, result });
  } catch (err: any) {
    return NextResponse.json({ triggered: false, error: err?.message ?? "error" });
  }
}
